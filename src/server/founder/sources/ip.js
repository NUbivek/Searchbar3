/**
 * Patents and trademarks: two public registers with their own dates, useful
 * for checking "holds N patents" and "founded in ..." against the record.
 *
 *   patents      patent families naming the person as inventor (worldwide,
 *                from Google Patents). Google's terms bar automated querying
 *                and it turns automated callers away; no permitted patent
 *                search answers without registration (the USPTO's Open Data
 *                Portal, PatentsView and the EPO's services all need one). So
 *                the lookup runs only where the owner allows Google Patents
 *                (FOUNDER_GOOGLE_PATENTS=on); elsewhere the screen says it is
 *                not enabled. When Google turns the lookup away it fails, and
 *                the coverage statement says patents were not checked.
 *   trademarks   not enabled: the only search by owner was the USPTO
 *                trademark web application's internal backend, removed for
 *                terms reasons. trademarkFindings keeps the matching for a
 *                permitted feed of filings.
 *
 * Identity. Inventor search is by name, so namesakes are the main risk. A
 * patent is kept only when the inventor's first and last names are the
 * subject's (middle names and "Last First" order allowed). It is then graded
 * from the assignee: a patent whose printed assignee is a known company of the
 * subject (the register rule of registries.js, legal names learned for it
 * included) is graded by the identity check; one the company search returns
 * under another owner is "likely" at most (reassigned), or "possible" when that
 * owner only resembles the company ("Flow Hair Salon Inc" for Flow). Threads
 * are followed only from families whose printed owner is the user's company or
 * a domain-anchored one. When the confirmed patents all write the inventor
 * with the same middle initial, name-only records with a different middle name
 * are left out.
 *
 * Trademark owners are matched on the whole owner name (legal form aside),
 * never on a word inside it: "Stripe" must not pick up "Blue Stripe, LLC" or
 * "Stripe International Inc.", "Flow" must not pick up "Flow Companies Inc",
 * and an owner named only by an ordinary word ("RAMP CORPORATION", owner of
 * HEALTHRAMP) is never Ramp's.
 *
 * Privacy: only names of inventors, assignees and owning companies, titles
 * and dates are read. Inventor city, trademark owner address and attorney
 * fields are never requested, and marks owned by individuals are skipped.
 *
 * The lookups can be switched off without a deploy: FOUNDER_SOURCES_OFF is a
 * comma-separated list of ids ('patents', 'trademarks').
 */
import { getJson, htmlToText } from '../http';
import { makeFinding, makeThread } from '../finding';
import { nameTokens, companyKeyStrict } from '../identity';
import { companyKeys } from '../../founderCheck';
import { isOrdinaryWordCompany } from '../names';
import { knownCompanyFor, knownCompanyNames, nameTie } from './registries';

const switchedOff = (id) => String(process.env.FOUNDER_SOURCES_OFF || '').split(',').map((s) => s.trim()).filter(Boolean).includes(id);
/** The owner's choice to allow Google Patents, which bars automated querying in its terms (off unless set). */
const googlePatentsAllowed = () => /^(on|1|true|yes)$/i.test(String(process.env.FOUNDER_GOOGLE_PATENTS || '').trim());

const MAX_FAMILIES = 25; // patent families reported per person
const MAX_NAME_ONLY = 10; // of which, at most this many matched by name alone
const MAX_THREADS = 5;
const MAX_MARKS = 8;

const clean = (s) => htmlToText(String(s || '').replace(/&hellip;/gi, '…')).replace(/\s+/g, ' ').trim();
const day = (s) => (/^\d{4}-\d{2}-\d{2}/.test(String(s || '')) ? String(s).slice(0, 10) : null);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const properCase = (name) => String(name || '').split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
/** "Kevin M. LYNK" -> "Kevin M. Lynk": registers often print surnames in capitals. */
const tidyName = (raw) => clean(raw).split(' ').map((w) => (w.length > 1 && /[A-Z]/.test(w) && w === w.toUpperCase() && !/^(II|III|IV)$/.test(w) ? w[0] + w.slice(1).toLowerCase() : w)).join(' ');
/** Lowercase name without legal form or punctuation: "Theranos, Inc." -> "theranos"; "Stripe International Inc." -> "stripe international". */
const LEGAL_WORDS = /\b(incorporated|inc|llc|ltd|limited|corp|corporation|co|company|companies|plc|pbc|lp|llp|sa|sas|sarl|gmbh|ag|bv|nv|oy|ab|aps|pte|pty|srl|spa|kk|the)\b/g;
const legalNorm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(?:[a-z]\.){2,}/g, (m) => m.replace(/\./g, '')).replace(/[^a-z0-9 ]+/g, ' ').replace(LEGAL_WORDS, ' ').replace(/\s+/g, ' ').trim();
/** The name as written, without a trailing legal form: "Nikola Corporation" -> "Nikola". */
const withoutLegalForm = (name) => {
  let out = String(name || '').trim();
  for (let i = 0; i < 3; i += 1) out = out.replace(/[,\s]+(incorporated|inc|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|sas|sa|ag|bv|nv)\.?$/i, '').trim();
  return out || String(name || '').trim();
};

/* ------------------------------------------------------------------ patents */

const NAME_SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);

/** What is needed to recognise the subject in an inventor field. Null when the name is a single word. */
function inventorIdentity(subject) {
  const words = String(subject?.name || '').split(/\s+/).filter(Boolean);
  const display = properCase(words.join(' ')); // the full name, capitalised the way the identity check expects
  while (words.length > 2 && NAME_SUFFIX.has(nameTokens(words[words.length - 1]).join(''))) words.pop();
  if (words.length < 2) return null;
  const first = nameTokens(words[0])[0];
  const last = nameTokens(words[words.length - 1]);
  if (!first || !last.length) return null;
  const middle = nameTokens(words.slice(1, -1).join(' '));
  return { first, last, middleInitial: middle.length ? middle[0][0] : null, query: `${words[0]} ${words[words.length - 1]}`, display, firstWord: words[0], lastWord: words[words.length - 1] };
}

/**
 * Is this inventor, as the register wrote it, the subject's first and last
 * name? "Trevor R. Milton", "Milton Trevor", "Milton Trevor R" and
 * "A Holmes Elizabeth" (how some offices print "Elizabeth A. Holmes") are.
 * "Trevor Milton Laib" (surname Laib), "Laura Elizabeth Schilling Holmes" and
 * "Milton Trevor Wicks" (it cannot be told whether Milton is the surname
 * there) are not. Returns { middleInitial } or null.
 */
function matchInventor(recorded, who) {
  const t = nameTokens(recorded);
  while (t.length > 2 && NAME_SUFFIX.has(t[t.length - 1])) t.pop();
  const n = who.last.length;
  if (t.length < n + 1) return null;
  const initial = (middle) => (middle.length ? middle[0][0] : null);
  const lastAt = (i) => who.last.every((x, k) => t[i + k] === x);
  // "First [Middle ...] Last"
  if (t[0] === who.first && lastAt(t.length - n)) return { middleInitial: initial(t.slice(1, t.length - n)) };
  // "Last First" or "Last First M"
  if (lastAt(0) && t[n] === who.first && (t.length === n + 1 || (t.length === n + 2 && t[n + 1].length === 1))) return { middleInitial: initial(t.slice(n + 1)) };
  // "M Last First"
  if (t.length === n + 2 && t[0].length === 1 && lastAt(1) && t[n + 1] === who.first) return { middleInitial: t[0] };
  return null;
}

function googleUrl(fields) {
  const inner = Object.entries({ ...fields, num: 100, sort: 'new' }).map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/%20/g, '+')}`).join('&');
  return `https://patents.google.com/xhr/query?url=${encodeURIComponent(inner)}&exp=`;
}
const googleSearchPage = (fields) => `https://patents.google.com/?${Object.entries({ ...fields, sort: 'new' }).map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/%20/g, '+')}`).join('&')}`;

function fromGoogle(result) {
  const p = result?.patent;
  const number = String(p?.publication_number || '').trim();
  if (!number) return null;
  return {
    number,
    title: clean(p.title) || 'Untitled patent record',
    inventor: tidyName(p.inventor),
    assignee: clean(p.assignee),
    priority: day(p.priority_date),
    filed: day(p.filing_date),
    granted: day(p.grant_date),
    url: /^patent\/[A-Za-z0-9]+\/[a-z]{2}$/.test(String(result.id || '')) ? `https://patents.google.com/${result.id}` : `https://patents.google.com/patent/${encodeURIComponent(number)}/en`,
  };
}

/** One Google Patents query: the records on the first page (up to 100, newest first) and the inventor facet. */
async function googleSearch(fields, deadline) {
  let data;
  try {
    data = await getJson(googleUrl(fields), { deadline, timeoutMs: 9000 });
  } catch (error) {
    // Google answers automated callers with a 429 or a 503 "unusual traffic" page: the patents were not checked
    if (error?.status === 429 || error?.status === 503) {
      const refused = new Error(`Google Patents turned the lookup away (HTTP ${error.status}); patents were not checked`);
      refused.status = error.status;
      refused.code = 'refused';
      throw refused;
    }
    throw error;
  }
  const results = data?.results;
  if (!results || typeof results !== 'object') throw new Error('Unexpected answer from Google Patents');
  return {
    total: Number(results.total_num_results) || 0,
    records: (Array.isArray(results.cluster) ? results.cluster : []).flatMap((c) => (Array.isArray(c?.result) ? c.result : [])).map(fromGoogle).filter(Boolean),
    // facet: every inventor named on the matching patents, with a relative weight
    inventors: (Array.isArray(results.summary?.inventor) ? results.summary.inventor : []).filter((x) => x?.key && x.key !== 'Total').sort((a, b) => (b.value || 0) - (a.value || 0)).map((x) => tidyName(x.key)),
  };
}

const TITLE_NOISE = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'or', 'to', 'in', 'with', 'on', 'by']);
const titleWords = (title) => new Set(String(title || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !TITLE_NOISE.has(w)));
const overlap = (a, b) => {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared);
};

/**
 * Group publications into families: the same invention filed in several
 * countries, or published first as an application and later as a grant,
 * shares a priority date and (nearly) a title. A record that carries the
 * office's own family number is grouped by it instead.
 */
function groupFamilies(records) {
  const families = [];
  for (const r of records) {
    const date = r.priority || r.filed || '';
    const words = titleWords(r.title);
    const home = families.find((f) => (r.familyId || f.familyId
      ? Boolean(r.familyId) && r.familyId === f.familyId
      : f.date === date && (date ? overlap(words, f.words) >= 0.6 : overlap(words, f.words) === 1)));
    if (home) home.members.push(r); else families.push({ date, words, familyId: r.familyId || null, members: [r] });
  }
  const rank = (r) => (r.granted ? 2 : 0) + (/^US/.test(r.number) ? 1 : 0);
  return families.map((f) => {
    // the publication to cite: a granted US patent when there is one (the earliest grant), else the best available
    const rep = [...f.members].sort((a, b) => rank(b) - rank(a) || String(a.granted || a.filed || '').localeCompare(String(b.granted || b.filed || '')))[0];
    const distinct = (values, key) => { const seen = new Set(); return values.filter((v) => v && !seen.has(key(v)) && seen.add(key(v))); };
    return {
      rep,
      members: f.members,
      date: f.members.map((m) => m.priority || m.filed).filter(Boolean).sort()[0] || null,
      priority: f.members.map((m) => m.priority).filter(Boolean).sort()[0] || null,
      assignees: distinct(f.members.flatMap((m) => String(m.assignee || '').split(' / ')), (v) => legalNorm(v) || v.toLowerCase()),
      inventorForms: distinct(f.members.map((m) => m.inventor), (v) => nameTokens(v).join(' ')),
      middleInitials: [...new Set(f.members.map((m) => m.middleInitial).filter(Boolean))],
      // true when the patent search listed a publication of this family under the company's name as assignee
      underCompany: f.members.some((m) => m.underCompany),
    };
  });
}

/**
 * One finding for a patent family. `held` is a grade the connector sets by hand: "likely" when the patent search
 * listed the family under the subject's company as assignee although the record now prints another owner (patents
 * are sold and reassigned: Theranos' are held by Labrador Diagnostics today), "possible" when the printed owner only
 * resembles the company ("Flow Hair Salon Inc" for Flow). "Listed under" is a note on the record, never part of the
 * text the grader reads: the grader must not see the company named where the record does not name it.
 */
function familyFinding(subject, who, family, connector, held = null) {
  const { rep } = family;
  const others = family.members.filter((m) => m !== rep).map((m) => m.number);
  const assignees = family.assignees.length ? `${family.assignees.length > 1 ? 'assignees' : 'assignee'}: ${family.assignees.join(' / ')}` : 'no assignee recorded';
  const quote = [
    // the name is kept in a form the identity check recognises, so the record can be re-graded when more companies become known
    `Inventor named: ${subject.hasName(rep.inventor) ? rep.inventor : `${rep.inventor} (searched as ${who.display})`}`,
    held?.listedUnder ? `${assignees} (listed under assignee ${held.listedUnder})` : assignees,
    family.priority ? `priority ${family.priority}` : null,
    rep.filed ? `filed ${rep.filed}` : null,
    rep.granted ? `granted ${rep.granted}` : null,
    others.length ? `also published as ${others.slice(0, 4).join(', ')}${others.length > 4 ? ` and ${others.length - 4} more` : ''}` : null,
  ].filter(Boolean).join('; ');
  const build = (title) => makeFinding(subject, {
    source: connector.id, sourceLabel: connector.label, category: 'ip', severity: 'info',
    title, quote, url: rep.url, date: family.priority || family.date || rep.filed || rep.granted,
    matchText: [who.display, ...family.inventorForms, ...family.assignees].filter(Boolean).join(' | '),
    ...(held ? { match: held.match, matchReasons: [held.reason] } : {}),
    data: {
      publicationNumber: rep.number, inventorAsRecorded: rep.inventor, assignees: family.assignees, priorityDate: family.priority, filingDate: rep.filed, grantDate: rep.granted, publications: family.members.map((m) => m.number),
      ...(held?.listedUnder ? { listedUnder: held.listedUnder } : {}),
      ...(held?.match === 'possible' ? { excludeFromTimeline: true } : {}),
    },
  });
  // The privacy filter drops text with medical words; a patent title is not about the person, so keep the record without it.
  return build(`${rep.number}: ${rep.title}`) || build(`${rep.number}: patent record (title not shown)`);
}

/**
 * Is a printed assignee a known company of the subject? The register rule (registries.js knownCompanyFor: the
 * name itself, its country arm or holding, an arm of a coined name, or a learned legal name), plus, for a coined
 * name only, the company's name followed by other words ("Theranos IP Company, LLC"). An ordinary word
 * ("Flow Hair Salon Inc" for Flow) never ties this way.
 */
function assigneeCompany(subject, assignee) {
  const tie = knownCompanyFor(subject, assignee);
  if (tie) return tie.company;
  const hit = knownCompanyNames(subject).find((n) => nameTie(n.name, assignee) === 'prefix' && !isOrdinaryWordCompany(n.name) && legalNorm(n.name).length >= 4);
  return hit ? hit.of : null;
}
/** Does the printed assignee carry the company's word without being it ("Flowserve", "Flow Hair Salon" for Flow)? */
const resemblesCompany = (assignee, company) => {
  const word = legalNorm(company).replace(/\s+/g, '');
  return word.length >= 3 && legalNorm(assignee).replace(/\s+/g, '').includes(word);
};
/** The user's own company, or one whose web domain the check knows: the only companies whose patents' threads are followed. */
function isAnchoredCompany(subject, company) {
  if (!company) return false;
  if (legalNorm(company) === legalNorm(subject.company)) return true;
  const key = companyKeys(company)[0] || company.toLowerCase();
  const aliasDomain = [...(subject.anchors?.aliases?.values?.() || [])].some((a) => a.of === key && /\.[a-z]{2,}$/i.test(a.value) && !/\s/.test(a.value));
  const label = legalNorm(company).replace(/\s+/g, '');
  const domain = [...(subject.anchors?.domains?.values?.() || [])].some((d) => String(d.value || '').toLowerCase().replace(/^www\./, '').split('.')[0].replace(/-/g, '') === label);
  return aliasDomain || domain;
}

/** Number of single-character edits between two short strings (used to spot one name misspelt in a register). */
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 9;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}
const LATIN = /^[\x20-\x7EÀ-ɏ]+$/;

const NOT_A_COMPANY = /\b(university|universit[aä]t|universite|college|school|institute of technology|hospital|foundation|government|department|ministry|secretary|national laborator(?:y|ies)|regents|trustees)\b/i;
const ORG_WORD = /\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|lp|llp|gmbh|ag|sa|sas|bv|nv|pty|pte|kk|labs?|technolog(?:y|ies)|systems|industries|motors?|group|holdings|partners|ventures|networks|software|pharma\w*|therapeutics|biosciences|diagnostics|sciences|energy|robotics|solutions|international|enterprises|associates)\b/i;
/** A name that reads as a business, not as a person or a university (assignees can be either). */
function looksLikeCompany(name) {
  const n = String(name || '').trim();
  if (n.length < 2 || !/^[\x20-\x7EÀ-ɏ]+$/.test(n) || NOT_A_COMPANY.test(n)) return false;
  const words = n.split(/\s+/).length;
  return ORG_WORD.test(n) || words === 1 || words >= 4 || /[0-9&]/.test(n);
}

/** "Greg D. Brockman" -> "Greg Brockman": the form a person is usually written in elsewhere. */
const withoutMiddleInitials = (name) => {
  const words = String(name || '').split(/\s+/).filter(Boolean);
  return words.filter((w, i) => i === 0 || i === words.length - 1 || !/^[A-Za-z]\.?$/.test(w)).join(' ');
};

export const patentsConnector = {
  id: 'patents',
  label: 'Patents (Google Patents)',
  kinds: ['subject'],
  prior: 0.4,
  timeoutMs: 18000,
  // Google's terms bar automated querying and it turns automated callers away, and no permitted patent search
  // answers without registration (the USPTO's Open Data Portal, PatentsView and the EPO's services all need one).
  // So the patent lookup runs only where the owner has chosen to allow Google Patents (FOUNDER_GOOGLE_PATENTS=on);
  // everywhere else the screen says it is not enabled, never "no patents".
  enabled: () => !switchedOff('patents') && googlePatentsAllowed(),
  unavailableReason: 'Patent records are not enabled on this deployment.',

  async run(task, ctx) {
    const subject = ctx?.subject;
    const who = subject ? inventorIdentity(subject) : null;
    if (!who || (task?.kind && task.kind !== 'subject')) return { findings: [], threads: [], notes: [] };
    const deadline = ctx.deadline;
    const anchors = [...subject.anchors.companies.values()];
    const known = (name) => anchors.some((a) => a.test(name));
    const company = subject.company || anchors[0]?.value || '';
    const companyShort = withoutLegalForm(company);
    const notes = [];

    // 1. Google Patents: everything under the name, and (when a company is known) the patents assigned to it,
    //    which also tells us who the co-inventors on those are.
    const searches = [googleSearch({ inventor: who.query }, deadline)];
    if (company) searches.push(googleSearch({ inventor: who.query, assignee: companyShort }, deadline));
    const [byName, byCompany] = (await Promise.allSettled(searches)).map((r) => (r.status === 'fulfilled' ? r.value : { error: r.reason }));
    // 2. No other patent register is asked: when Google Patents does not answer at all, the lookup fails (and is reported as not done).
    if (byName.error && (!byCompany || byCompany.error)) throw byName.error;
    if (byName.error) notes.push(`The patent search by name alone did not answer; only patents assigned to ${companyShort} are listed.`);
    // Each search returns its newest 100 records at most: beyond that the counts are a minimum.
    const cutShort = (s) => Boolean(s && !s.error && s.total > s.records.length);
    const partial = cutShort(byName) || cutShort(byCompany);

    // 3. Keep the records whose inventor is the subject's first and last name; one entry per publication.
    //    Records returned for the company's name as assignee are marked: the search matched the company
    //    even where the record now prints a later owner.
    const byNumber = new Map();
    let otherPeople = 0;
    const raw = [...(byCompany?.records || []).map((r) => ({ ...r, underCompany: true })), ...(byName.records || [])];
    for (const r of raw) {
      if (byNumber.has(r.number)) continue;
      const hit = matchInventor(r.inventor, who);
      if (!hit) continue;
      if (who.middleInitial && hit.middleInitial && hit.middleInitial !== who.middleInitial) { otherPeople += 1; continue; }
      byNumber.set(r.number, { ...r, middleInitial: hit.middleInitial });
    }

    // 4. One finding per family, graded from the assignee. A family whose printed assignee is a known company is
    //    graded by the identity check from its own text. One the company search returned under another owner is
    //    "likely" at most (a reassigned patent), or "possible" when that owner only resembles the company.
    const heldGrade = (family) => {
      if (family.assignees.some((a) => assigneeCompany(subject, a))) return null;
      if (company && family.underCompany) {
        if (family.assignees.length && family.assignees.every((a) => !resemblesCompany(a, companyShort))) {
          return { match: 'likely', reason: `the patent search lists it under assignee ${companyShort}; the record now prints ${family.assignees.join(' / ')} (patents are often sold or reassigned)`, listedUnder: companyShort };
        }
        return { match: 'possible', reason: `the assignee only resembles ${companyShort}: it may be another company`, listedUnder: companyShort };
      }
      // A name-only family is left to the grader (so a company learned later can tie it), unless its owner merely
      // resembles a known company: that must never be read as the company.
      if (family.assignees.some((a) => known(a) && !assigneeCompany(subject, a))) return { match: 'possible', reason: 'matched by name; the assignee only resembles a known company of this person' };
      return null;
    };
    let graded = groupFamilies([...byNumber.values()]).map((family) => ({ family, finding: familyFinding(subject, who, family, this, heldGrade(family)) })).filter((x) => x.finding);
    const tied = () => graded.filter((x) => x.finding.match !== 'possible');
    // A middle initial that every company-tied patent agrees on marks name-only records with another one as namesakes.
    const learned = [...new Set(tied().flatMap((x) => x.family.middleInitials))];
    if (!who.middleInitial && learned.length === 1) {
      const before = graded.length;
      graded = graded.filter((x) => x.finding.match !== 'possible' || !x.family.middleInitials.length || x.family.middleInitials.includes(learned[0]));
      otherPeople += before - graded.length;
    }
    if (!graded.length) {
      if (otherPeople) notes.push(`Patent records under the name ${who.display} belong to inventors with a different middle name and were left out.`);
      return { findings: [], threads: [], notes };
    }
    const newest = (a, b) => String(b.family.date || '').localeCompare(String(a.family.date || ''));
    const confirmed = tied().sort(newest);
    const nameOnly = graded.filter((x) => x.finding.match === 'possible').sort(newest);
    const shown = [...confirmed.slice(0, MAX_FAMILIES), ...nameOnly.slice(0, Math.min(MAX_NAME_ONLY, Math.max(0, MAX_FAMILIES - confirmed.length)))];
    if (shown.length < graded.length) notes.push(`Patents: the ${shown.length} most relevant of ${graded.length} patent families naming ${who.display} are listed.`);
    // Families whose printed owner is exactly a known company that is the user's own or domain-anchored: the only
    // ones whose other owners and co-inventors are followed.
    const trustedFamilies = confirmed.filter((x) => x.finding.match === 'confirmed' && x.family.assignees.some((a) => isAnchoredCompany(subject, assigneeCompany(subject, a))));

    // 5. The summary: how many, with whom, and how many are tied to a company we know.
    const tally = (items) => {
      const counts = new Map(); // spellings of one name ("Theranos IP Company, LLC" / "Theranos, IP Company, LLC") count together
      for (const x of items) {
        for (const a of x.family.assignees) {
          const key = legalNorm(a) || a.toLowerCase();
          const row = counts.get(key) || { name: a, n: 0 };
          row.n += 1;
          counts.set(key, row);
        }
      }
      return [...counts.values()].sort((a, b) => b.n - a.n).map((row) => [row.name, row.n]);
    };
    // Co-inventors: the people named on the patents the search returned for the company (most frequent first).
    // For a company named with one ordinary word the search also returns look-alike owners' patents, so their
    // inventors are not the person's co-inventors.
    const coInventors = [];
    if (byCompany && !byCompany.error && trustedFamilies.length && !isOrdinaryWordCompany(companyShort)) {
      const seen = new Set();
      for (const n of byCompany.inventors) {
        if (!LATIN.test(n) || n.split(' ').length < 2 || matchInventor(n, who)) continue;
        const key = nameTokens(withoutMiddleInitials(n)).sort().join(' '); // "Young Daniel" is "Daniel Young"
        if (!key || seen.has(key)) continue;
        seen.add(key);
        coInventors.push(n);
      }
    }
    const dates = graded.map((x) => x.family.date).filter(Boolean).sort();
    const quote = [
      confirmed.length ? `Assignees on the ${plural(confirmed.length, 'family', 'families')} tied to a known company when searched: ${tally(confirmed).slice(0, 5).map(([a, n]) => `${a} (${n})`).join(' / ')}.` : null,
      nameOnly.length ? `${plural(nameOnly.length, 'family matches', 'families match')} by name only and may belong to a namesake${tally(nameOnly).length ? ` (assignees include ${tally(nameOnly).slice(0, 4).map(([a]) => a).join(' / ')})` : ''}.` : null,
      coInventors.length ? `Co-inventors on the ${companyShort} patents: ${coInventors.slice(0, 8).join(', ')}.` : null,
      dates.length ? `Priority dates run from ${dates[0]} to ${dates[dates.length - 1]}.` : null,
      !byName.error ? `Google Patents returns ${plural(byName.total, 'result', 'results')} for inventor ${who.query}${partial ? '; only the newest 100 of each search were read, so the counts here are a minimum' : ''}.` : null,
      otherPeople ? `${plural(otherPeople, 'record', 'records')} naming an inventor with a different middle name ${otherPeople === 1 ? 'was' : 'were'} left out.` : null,
    ].filter(Boolean).join(' ');
    // The title carries no count of tied families: companies learned later tie more of them, and the report counts
    // them again from the family records (data.familyIds). The text graded holds every assignee, so the summary is
    // re-graded with the families.
    const summary = makeFinding(subject, {
      source: this.id, sourceLabel: this.label, category: 'ip', severity: 'info',
      title: `${who.display}: named inventor on ${partial ? 'at least ' : ''}${plural(graded.length, 'patent family', 'patent families')}`,
      quote,
      url: googleSearchPage(company && confirmed.length ? { inventor: who.query, assignee: companyShort } : { inventor: who.query }),
      matchText: [who.display, ...tally(graded.filter((x) => !heldGrade(x.family) || heldGrade(x.family).match !== 'possible')).map(([a]) => a)].filter(Boolean).join(' | '),
      data: { families: graded.length, tiedToKnownCompany: confirmed.length, nameOnly: nameOnly.length, countsAreMinimum: partial, coInventors: coInventors.slice(0, 12), familyIds: shown.map((x) => x.finding.id) },
    });

    // 6. Threads. Followed (trusted) only from families whose printed owner is exactly a known, anchored company:
    //    the other owners of those patents, and the co-inventors.
    const threads = [];
    const companyNames = (items, limit) => {
      // A name one or two letters away from a commoner one is the register's typo, not another company.
      const picked = [];
      for (const [a] of tally(items)) {
        if (known(a) || assigneeCompany(subject, a) || matchInventor(a, who) || !looksLikeCompany(a)) continue;
        const key = legalNorm(a);
        if (picked.some((p) => p.key === key || (Math.min(p.key.length, key.length) >= 8 && editDistance(p.key, key) <= 2))) continue;
        picked.push({ key, name: a });
        if (picked.length >= limit) break;
      }
      return picked.map((p) => p.name);
    };
    const followed = new Set();
    for (const a of companyNames(trustedFamilies, MAX_THREADS)) {
      followed.add(legalNorm(a));
      threads.push(makeThread('company', a, `joint, earlier or later owner of a ${companyShort || 'known-company'} patent naming ${who.display} as inventor`, { trusted: true }));
    }
    for (const n of coInventors.slice(0, MAX_THREADS)) threads.push(makeThread('associate', withoutMiddleInitials(n), `co-inventor on ${companyShort} patents`, { trusted: true }));
    // The printed owner of a reassigned family: recorded, not followed
    for (const a of companyNames(confirmed.filter((x) => !trustedFamilies.includes(x)), 3)) {
      if (!followed.has(legalNorm(a))) threads.push(makeThread('company', a, `owner now printed on a patent the search lists under ${companyShort || 'a known company'} (naming ${who.display} as inventor)`, { trusted: false }));
    }
    // Assignees on name-only patents may be a namesake's employer: recorded, never followed.
    for (const a of companyNames(nameOnly, 3)) threads.push(makeThread('company', a, `assignee on a patent naming an inventor ${who.display} (name match only)`, { trusted: false }));
    return { findings: [summary, ...shown.map((x) => x.finding)].filter(Boolean), threads: threads.filter(Boolean), notes };
  },
};

/* --------------------------------------------------------------- trademarks */

// The connector used to ask the USPTO trademark web application's own search backend. That is the "USPTO web
// app's internal search" the owner removed for terms reasons, so it is never asked again. No permitted route
// searches by owner without registration (the USPTO's documented trademark services look a filing up by its
// serial number, and its bulk files need a registered download), so the source is not enabled on this
// deployment. The matching below is kept, tested on filings given to it, for a permitted feed of filings.
// Fields read from a filing: never an owner's address or the attorney fields.
const markPage = (serial) => `https://tsdr.uspto.gov/statusview/sn${encodeURIComponent(serial)}`;

/** "Mistral AI (SOCIÉTÉ PAR ACTIONS SIMPLIFIÉE (SAS); FRANCE)" -> { name: 'Mistral AI', kind: 'SOCIÉTÉ PAR ACTIONS SIMPLIFIÉE (SAS)', raw } */
function parseOwner(raw) {
  const text = clean(raw);
  if (!text.endsWith(')')) return { name: text, kind: '', raw: text };
  let depth = 0;
  let open = -1;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (text[i] === ')') depth += 1;
    else if (text[i] === '(') { depth -= 1; if (depth === 0) { open = i; break; } }
  }
  if (open <= 0) return { name: text, kind: '', raw: text };
  const inside = text.slice(open + 1, -1);
  const cut = inside.lastIndexOf(';');
  return { name: text.slice(0, open).trim(), kind: (cut >= 0 ? inside.slice(0, cut) : inside).trim(), raw: text };
}

// Owners that are private people: never matched, never named.
const PERSON_OWNER = /\b(individual|sole proprietor(?:ship)?)\b/i;
// Owner types that are plainly organisations (used before an owner's name is repeated in a note).
const ORGANISATION_OWNER = /\b(corporation|company|partnership|trust|association|foundation|cooperative|soci[eé]t[eé]|gmbh|limited|ltd|llc|joint venture|public benefit|non-?profit)\b/i;

function fromTrademarkHit(hit) {
  const s = hit?.source || hit?._source;
  const id = String(s?.id || hit?.id || '').trim();
  if (!s || !/^\d{6,10}$/.test(id)) return null;
  return {
    id,
    wordmark: clean(s.wordmark) || '',
    owners: (Array.isArray(s.ownerName) ? s.ownerName : [s.ownerName]).filter(Boolean).map(parseOwner).filter((o) => o.name && !PERSON_OWNER.test(o.kind)),
    filed: day(s.filedDate),
    registered: day(s.registrationDate),
    registrationId: s.registrationId ? String(s.registrationId) : null,
    abandoned: day(s.abandonDate),
    cancelled: day(s.cancelDate),
    alive: s.alive === true,
    classes: (Array.isArray(s.internationalClass) ? s.internationalClass : []).map((c) => clean(c).replace(/\.$/, '')).filter(Boolean),
  };
}

const markStatus = (m) => (m.cancelled ? `registered ${m.registered || 'earlier'}, cancelled ${m.cancelled}`
  : m.abandoned ? `abandoned ${m.abandoned}`
    : m.registered ? `registered ${m.registered}, ${m.alive ? 'live' : 'no longer live'}`
      : m.alive ? 'pending (live)' : 'no longer live');

const byFilingDate = (a, b) => String(a.filed || '9').localeCompare(String(b.filed || '9'));

/** The owner's name with its legal form, case and punctuation aside: "STRIPE, INC." -> "stripe inc". */
const ownerKey = (name) => String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const LONG_GAP_YEARS = 7;
/**
 * The whole company name with only its legal form removed (companyKeyStrict, accents and dotted initials aside):
 * "Mistral AI (SAS)" -> "mistral ai", "Flow Companies Inc" -> "flow companies". A trademark owner is the company
 * only when this key is the same; a describing word more or less ("AI", "Companies") makes another owner.
 */
const fullKey = (name) => companyKeyStrict(String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\b(?:[a-z]\.){2,}/gi, (m) => m.replace(/\./g, '')))
  .replace(/\b(pbc|pte|srl|aps|oy|kk)\b/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Two companies can carry the same name. Filings are grouped by the owner's
 * name with its legal form ("Nikola Corporation" apart from "Nikola LLC"),
 * and two forms are one owner when a single mark lists both ("Stripe, Inc."
 * became "Stripe, LLC"). The place of registration is not used: the register
 * records the same company under different states. Largest group first, each
 * sorted by filing date.
 */
function groupByOwnerName(matched) {
  const parent = new Map();
  const find = (k) => { let x = k; while (parent.get(x) !== x) x = parent.get(x); return x; };
  for (const m of matched) {
    for (const k of m.ownerKeys) if (!parent.has(k)) parent.set(k, k);
    for (const k of m.ownerKeys.slice(1)) parent.set(find(k), find(m.ownerKeys[0]));
  }
  const groups = new Map();
  for (const m of matched) {
    const root = find(m.ownerKeys[0]);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(m);
  }
  const liveIn = (g) => g.filter((m) => m.alive).length;
  return [...groups.values()].sort((a, b) => b.length - a.length || liveIn(b) - liveIn(a)).map((g) => g.sort(byFilingDate));
}

/**
 * Split one owner's filings (sorted by date) where everything filed so far
 * had lapsed and nothing followed for years: a "Stripe, Inc." mark filed in
 * 1991 and cancelled in 1999 is an earlier user of the name, not the start of
 * the company that began filing in 2011. Returns the runs in date order.
 */
function splitAtLongGaps(marks) {
  const runs = [];
  let run = null;
  for (const m of marks) {
    // a mark with no recorded end is taken to be in force, so it never closes a run
    const end = m.alive ? '9999' : (m.cancelled || m.abandoned || '9999');
    const apart = run && m.filed && run.lastFiled ? (Date.parse(m.filed) - Date.parse(run.lastFiled)) / (365.25 * 86400000) : 0;
    if (!run || (apart >= LONG_GAP_YEARS && run.openUntil < m.filed)) { run = { marks: [], lastFiled: null, openUntil: '' }; runs.push(run); }
    run.marks.push(m);
    if (m.filed) run.lastFiled = m.filed;
    if (end > run.openUntil) run.openUntil = end;
  }
  return runs.map((r) => r.marks);
}

/**
 * Trademark filings of a company, from filings a permitted source supplies ({ hits: [{ source: {...} }],
 * totalValue }). The owner must be the company: its whole name, a fuller name the check already holds, or a
 * legal name learned for it ("Ramp Business Corporation" for Ramp). A filing whose owner carries only the bare
 * ordinary word ("RAMP CORPORATION", owner of HEALTHRAMP) is never the company's: with a legal name known it is
 * left out, and without one the filings are counted in a note, never shown as the company's.
 */
export function trademarkFindings(companyName, data, ctx, connector = trademarksConnector) {
  const company = String(companyName || '').replace(/\s+/g, ' ').trim();
  const strictKey = legalNorm(company);
  const looseKey = companyKeys(company)[0] || '';
  const beginsWithLoose = Boolean(looseKey) && (strictKey === looseKey || strictKey.startsWith(`${looseKey} `));
  const tokens = (beginsWithLoose || !strictKey ? looseKey : strictKey).split(' ').filter(Boolean);
  if (!tokens.length || !Array.isArray(data?.hits)) return { findings: [], threads: [], notes: [] };
    const { hits } = data;
  const marks = hits.map(fromTrademarkHit).filter(Boolean);
  const notes = [];

  // The owner must be the company: the whole name, legal form aside, never only its core word ("WE, INC." is not
  // "WeWork"; "Flow Companies Inc" is not "Flow"). The one other name accepted is a fuller name of the same company
  // that the check already holds (given or found: "Mistral AI" when the thread reads "Mistral").
  const given = fullKey(ctx?.subject?.company);
  const known = [ctx?.subject?.company, ...[...(ctx?.subject?.anchors?.companies?.values?.() || [])].map((a) => a?.value)]
    .filter((v) => v && ((looseKey && companyKeys(v)[0] === looseKey) || (fullKey(company) && fullKey(v).startsWith(`${fullKey(company)} `))));
  const accepted = new Map([[fullKey(company), company]]);
  for (const v of known) if (fullKey(v) && !accepted.has(fullKey(v))) accepted.set(fullKey(v), v);
  // Legal names learned for this company (a Form D's issuer, the site's legal footer) are its names too
  const legalNames = ctx?.subject ? knownCompanyNames(ctx.subject).filter((n) => n.alias && ((looseKey && companyKeys(n.of)[0] === looseKey) || legalNorm(n.of) === strictKey)) : [];
  for (const n of legalNames) if (fullKey(n.name) && !accepted.has(fullKey(n.name))) accepted.set(fullKey(n.name), n.name);
  // One ordinary word ("Ramp", "Merge") is a name many businesses own marks under. With a legal name known, an
  // owner named only that word is another business; without one, nothing can tell, unless the user typed the
  // company with its legal form ("Stripe, Inc.").
  const bare = isOrdinaryWordCompany(company) && !fullKey(company).includes(' ');
  const typedLegal = ctx?.subject?.company && fullKey(ctx.subject.company) === fullKey(company) && withoutLegalForm(ctx.subject.company) !== String(ctx.subject.company).trim();
  if (bare && legalNames.length) accepted.delete(fullKey(company));
  accepted.delete('');
  const ownedBy = (test) => marks.map((m) => {
    const owners = m.owners.filter((o) => test(o.name));
    return owners.length ? { ...m, owner: owners[0], ownerKeys: [...new Set(owners.map((o) => ownerKey(o.name)))] } : null;
  }).filter(Boolean);
  const matched = ownedBy((name) => accepted.has(fullKey(name)));
  const viaKeys = [...new Set(matched.map((m) => fullKey(m.owner.name)))];
  const via = viaKeys.length === 1 ? accepted.get(viaKeys[0]) : company;
  const reason = via === company || fullKey(via) === fullKey(company) ? `trademark owner name matches ${company}` : `trademark owner name matches ${via}, a known name of ${company}`;
  // A one-word name that is not the company the user gave ("We Co." beside "WE, INC.") is shared by many unrelated
  // owners: such a match is kept as possible, fixed, and out of the timeline.
  const oneWordOnly = viaKeys.length > 0 && viaKeys.every((k) => !k.includes(' ') && k !== given);
  if (!matched.length) {
    // Say what was seen and not counted, so a near miss is visible (organisations only: people are never named).
    const near = [...new Map(marks.flatMap((m) => m.owners).filter((o) => ORGANISATION_OWNER.test(o.kind) && legalNorm(o.name).startsWith(tokens.join(' '))).map((o) => [legalNorm(o.name), o.name])).values()];
    if (near.length && !notes.length) notes.push(`No US trademark owner is named exactly ${company}. Owners with longer names were not counted, as they may be other companies: ${near.slice(0, 4).join('; ')}${near.length > 4 ? ` and ${near.length - 4} more` : ''}.`);
    return { findings: [], threads: [], notes };
  }
  if (Number(data.totalValue) > hits.length) notes.push(`The trademark list for ${company} may be incomplete: many owners have names that begin the same way.`);
  if (bare && !legalNames.length && !typedLegal && viaKeys.every((k) => k === fullKey(company))) {
    const spelled = new Map(); // one spelling per owner, the first seen
    for (const m of matched) if (!spelled.has(ownerKey(m.owner.name))) spelled.set(ownerKey(m.owner.name), m.owner.name);
    const owners = [...spelled.values()];
    notes.push(`${plural(matched.length, 'US trademark filing is', 'US trademark filings are')} owned by ${owners.length === 1 ? 'a business' : `${owners.length} businesses`} named ${company} (${owners.slice(0, 3).join('; ')}). "${company}" is an ordinary word many businesses use, so none is shown as the company's; a search under the company's full legal name can tell.`);
    return { findings: [], threads: [], notes };
  }

  // Same name, another company: report the owner with the most filings and say what was left out.
  const [largest, ...otherOwners] = groupByOwnerName(matched);
  const runs = splitAtLongGaps(largest);
  const main = runs.reduce((best, r) => (r.length >= best.length ? r : best), runs[0]);
  const span = (g) => (g.length === 1 || g[0].filed === g[g.length - 1].filed ? `on ${g[0].filed || 'an unrecorded date'}` : `from ${g[0].filed} to ${g[g.length - 1].filed}`);
  const leftOut = [
    ...otherOwners.map((g) => ({ owner: g[0].owner.name, filings: g.length, earliestFiled: g[0].filed, text: `${g[0].owner.name} (${plural(g.length, 'filing', 'filings')}${g[0].filed ? `, earliest ${g[0].filed}` : ''})` })),
    ...runs.filter((r) => r !== main).map((g) => ({ owner: g[0].owner.name, filings: g.length, earliestFiled: g[0].filed, text: `${plural(g.length, 'filing', 'filings')} under the same name ${span(g)}, years apart from the rest` })),
  ];
  if (leftOut.length) notes.push(`Trademarks: more than one owner may be using the name ${company}. The owner with the most filings is reported; not counted: ${leftOut.slice(0, 4).map((x) => x.text).join('; ')}.`);

  const [earliest] = main;
  const latest = main[main.length - 1];
  const live = main.filter((m) => m.alive).length;
  const count = (key) => main.filter((m) => m[key]).length;
  // The owner as the register writes it; spellings that differ only in capitals are shown once, commonest first.
  const spellings = new Map();
  for (const m of main) {
    const key = m.owner.raw.toLowerCase();
    spellings.set(key, { raw: spellings.get(key)?.raw || m.owner.raw, n: (spellings.get(key)?.n || 0) + 1 });
  }
  const owners = [...spellings.values()].sort((a, b) => b.n - a.n).map((o) => o.raw);
  const named = (m) => (m.wordmark ? m.wordmark : 'a design mark');
  const base = oneWordOnly
    ? { source: connector.id, sourceLabel: connector.label, category: 'ip', severity: 'info', match: 'possible', matchReasons: [`${reason}, a one-word name other companies also use: may be another company`] }
    : { source: connector.id, sourceLabel: connector.label, category: 'ip', severity: 'info', match: 'company', matchReasons: [reason] };
  const timeline = oneWordOnly ? { excludeFromTimeline: true } : {};
  // The privacy filter can reject a mark for a word in it; the filing is then kept without the mark text.
  const withTimeline = (f) => (f.data ? { ...f, data: { ...f.data, ...timeline } } : f);
  const build = (withMark, without) => makeFinding(ctx?.subject, withTimeline(withMark)) || makeFinding(ctx?.subject, withTimeline({ ...withMark, ...without }));
  const ownerLine = `Owner on record: ${owners.slice(0, 3).join(' / ')}${owners.length > 3 ? ` and ${plural(owners.length - 3, 'more spelling', 'more spellings')}` : ''}.`;
  const tallyLine = `${count('registered')} registered; ${count('abandoned')} abandoned; ${count('cancelled')} cancelled.`;
  const leftOutLine = leftOut.length ? `Not counted, as they may belong to another company of the same name: ${leftOut.slice(0, 3).map((x) => x.text).join('; ')}.` : null;

  const summary = build({
    ...base,
    title: `${company}: ${plural(main.length, 'US trademark filing', 'US trademark filings')}${earliest.filed ? `, earliest filed ${earliest.filed}` : ''}; ${live} live, ${main.length - live} no longer live`,
    quote: [
      ownerLine,
      `Earliest filing: ${named(earliest)}, serial ${earliest.id}${earliest.filed ? `, filed ${earliest.filed}` : ''} (${markStatus(earliest)}).`,
      main.length > 1 ? `Latest filing: ${named(latest)}, serial ${latest.id}${latest.filed ? `, filed ${latest.filed}` : ''}.` : null,
      tallyLine,
      leftOutLine,
    ].filter(Boolean).join(' '),
    url: markPage(earliest.id), // the filing behind the earliest date
    date: earliest.filed,
    data: {
      company, filings: main.length, live, notLive: main.length - live, earliestFiled: earliest.filed, latestFiled: latest.filed, owners: owners.slice(0, 5),
      sameNameNotCounted: leftOut.slice(0, 6).map(({ owner, filings, earliestFiled }) => ({ owner, filings, earliestFiled })),
    },
  }, { quote: [ownerLine, tallyLine, leftOutLine].filter(Boolean).join(' ') });

  // Individual marks: one per distinct mark text, earliest first. The earliest filing is already cited by the summary.
  const markKey = (m) => (m.wordmark ? m.wordmark.toUpperCase() : `design-${m.id}`);
  const seen = new Set([markKey(earliest)]);
  const individual = [];
  for (const m of main) {
    if (m === earliest) continue;
    const key = markKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    individual.push(m);
    if (individual.length >= MAX_MARKS) break;
  }
  const findings = [summary, ...individual.map((m) => build({
    ...base,
    title: `Trademark ${named(m)} (serial ${m.id}): filed ${m.filed || 'on an unrecorded date'}; ${markStatus(m)}`,
    quote: [
      `Owner: ${m.owner.raw}`,
      m.filed ? `filed ${m.filed}` : null,
      m.registered ? `registered ${m.registered}${m.registrationId ? ` (registration ${m.registrationId})` : ''}` : null,
      m.abandoned ? `abandoned ${m.abandoned}` : null,
      m.cancelled ? `cancelled ${m.cancelled}` : null,
      `status: ${m.alive ? 'live' : 'no longer live'}`,
      m.classes.length ? `classes: ${m.classes.join(', ')}` : null,
    ].filter(Boolean).join('; '),
    url: markPage(m.id),
    date: m.filed,
    data: { serial: m.id, wordmark: m.wordmark || null, live: m.alive, filed: m.filed, registered: m.registered, abandoned: m.abandoned, cancelled: m.cancelled, classes: m.classes },
  }, { title: `Trademark filing (serial ${m.id}): filed ${m.filed || 'on an unrecorded date'}; ${markStatus(m)}`, data: { serial: m.id, live: m.alive, filed: m.filed } }))];
  return { findings: findings.filter(Boolean), threads: [], notes };
}

export const trademarksConnector = {
  id: 'trademarks',
  label: 'US trademarks (USPTO)',
  kinds: ['company'],
  prior: 0.35,
  timeoutMs: 12000,
  // No permitted search by owner is available (see above): the screen says "not enabled", never "no trademarks".
  enabled: () => false,
  unavailableReason: 'US trademark records are not enabled on this deployment.',

  async run(task) {
    const company = String(task?.value || '').replace(/\s+/g, ' ').trim();
    if (task?.kind !== 'company' || company.length < 2) return { findings: [], threads: [], notes: [] };
    // Never a request: a lookup not run is reported as not run
    return { findings: [], threads: [], notes: [`US trademark records were not searched for ${company}: they are not enabled on this deployment.`], partial: ['US trademarks (not enabled)'] };
  },
};
