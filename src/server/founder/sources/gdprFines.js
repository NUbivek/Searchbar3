/**
 * EU data-protection fines against a COMPANY. Never against a person.
 *
 *   gdpr-fines   the CMS Enforcement Tracker (enforcementtracker.com, provided
 *                by CMS): fines that EU and EEA data-protection authorities
 *                have issued under the GDPR, each with the country, the
 *                authority, the date, the amount in euros, the articles
 *                breached and the kind of violation. It covers the EU the way
 *                the UK Information Commissioner's Office screen (exposure.js)
 *                covers the UK.
 *
 * Reading. The tracker's home page carries the whole dataset as JSON inside
 * <script type="application/json" id="et-cases">. The page (about 1.1 MB) is
 * read at most once a day through the cache, as a compact index; no other
 * link on the site is ever followed. Each finding links to the tracker's own
 * page for the case (/ETid-<number>). A page without that block, a block that
 * is not a list of cases, or a list far shorter than the tracker's is an
 * error (the lookup is reported as failed), never "no match".
 *
 * Licence. The database is published under CC BY-NC-SA 4.0 with the
 * attribution "enforcementtracker.com, provided by CMS". The owner stated on
 * 2026-11-20 that this site is non-commercial, so the source is on; the
 * attribution is in the label and in every record. If the site is ever used
 * commercially, switch it off with FOUNDER_SOURCES_OFF=gdpr-fines.
 *
 * Privacy. The tracker also lists fines against private individuals
 * ("Private individual", "Physician", "Mayor", "Police officer", "Sole
 * trader"), and its sector "Individuals and Private Associations". Those rows
 * are dropped when the list is read and never stored. Only company threads
 * are screened, a company name that is the person's own name is never
 * screened, and only the parties that are companies are quoted.
 *
 * Matching (the same rules as the breach registers in exposure.js). Every
 * party named in a case (the tracker separates several with new lines or
 * commas) is compared with every known name of the company: the name typed
 * and the fuller legal names the check learned (sanctions.companyNames). A
 * case is the company's ('company') when the party is the company's exact,
 * distinctive name, or a learned legal name of two or more words. A company
 * named with one ordinary word (names.isOrdinaryWordCompany: Uber, Merge,
 * Ramp), or a party that adds a general word ("Summit Financial Group" for
 * Summit), is a possible namesake: 'possible', with "verify it is the same
 * company" in its title. No grade above 'company' is ever set here.
 */
import { request } from '../http';
import { makeFinding } from '../finding';
import { cachedEntry } from '../cache';
import { isOrdinaryWordCompany } from '../names';
import { companyKey, matchOrgName, orgTokens } from './exposure';
import { companyNames } from './sanctions';

const ID = 'gdpr-fines';
export const ATTRIBUTION = 'enforcementtracker.com, provided by CMS';
export const LICENCE = 'CC BY-NC-SA 4.0';
export const LABEL = `EU data-protection fines (CMS Enforcement Tracker: ${ATTRIBUTION}, ${LICENCE})`;
const SITE = 'https://www.enforcementtracker.com';
export const TRACKER_PAGE = `${SITE}/`;
export const caseUrl = (e) => `${SITE}/ETid-${e}`;

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_KEY = 'gdpr:cms-enforcement-tracker:v1';
const MAX_FINDINGS = 8;
/** The tracker held 3,432 cases on 2026-11-20: a list far shorter than that is a page that changed, not the list. */
export const MIN_CASES = 1500;
const HIGH_FINE_EUR = 1000000;

export const COVERAGE_NOTE = `EU data-protection fines: the CMS Enforcement Tracker (${ATTRIBUTION}, ${LICENCE}) lists fines that EU and EEA data-protection authorities have made public. Fines that were not published, decisions without a fine, and fines against private individuals are not included, so a company with no entry may still have been fined or reprimanded.`;

const switchedOff = () => String(process.env.FOUNDER_SOURCES_OFF || '').split(',').map((x) => x.trim()).includes(ID);

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const t = oneLine(s); return t.length <= n ? t : `${t.slice(0, n - 1).replace(/[\s,;:(]+$/, '')}…`; };
/** 290000000 -> "EUR 290,000,000"; '' when the fine is not a positive number. */
export const euros = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 && n !== null && n !== '' ? `EUR ${Math.round(Number(n)).toLocaleString('en-US')}` : '');
/** "2024-07-22", "2019-11" or "2022" as given; '' for "Unknown" or anything else. */
const dateOf = (d) => (/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(oneLine(d)) ? oneLine(d) : '');

/* ------------------------------------------------------------------ */
/* Who a case is against                                               */
/* ------------------------------------------------------------------ */

const PRIVATE_SECTOR = /^individuals and private associations$/i;
/** A legal form written in a party's name: the party is an organisation, whatever else its name says. */
// Short forms that are also ordinary words ("as", "ad") are only read with their dots ("a.s.").
const LEGAL_FORM = /(?:^|[\s,.(])(?:s\.a\.u|sau|s\.a|sa|s\.l\.u|slu|s\.l|sl|s\.l\.l|s\.a\.s|sas|sasu|s\.a\.r\.l|sarl|s\.r\.l|srl|s\.p\.a|spa|s\.c\.c\.a|s\.c\.a\.c|s\.c\.c|gmbh|gbr|ag|kg|ohg|e\.v|ltd|limited|plc|llc|inc|corp|corporation|b\.v|bv|n\.v|nv|a\.s|a\/s|asa|ab|oy|oyj|aps|kft|zrt|nyrt|s\.r\.o|sro|a\.e|e\.p\.e|i\.k\.e|sp\.\s?z\s?o\.o|d\.o\.o|doo|uab|bvba|sprl|cvba|lda|snc|ead|eood|ehf)\.?(?=$|[\s,.)])/i;
/** Words that make a party a private person, not a business ("Physician", "Private individual", "Former mayor"). */
const PERSON_WORDS = /\b(?:private|individual|individuals|natural person|person|persons|people|physician|doctor|dentist|nurse|pharmacist|psychologist|therapist|mayor|councillor|councilor|politician|candidate|police|officer|officers|employee|employees|teacher|student|attorney|lawyer|notary|entrepreneur|sole trader|self[- ]employed|freelancer|owner|landlord|tenant|neighbou?r|parent|citizen|resident|blogger|youtuber|influencer|journalist|priest|athlete)\b/i;

/** A party that is a private individual, not an organisation. Such cases are never stored. */
export function isPrivateParty(party, sector = '') {
  if (PRIVATE_SECTOR.test(oneLine(sector))) return true;
  const name = oneLine(String(party || '').replace(/\([^)]*\)/g, ' '));
  if (!name) return true;
  if (LEGAL_FORM.test(name)) return false;
  return PERSON_WORDS.test(name);
}

/**
 * The parties a case names, one per entry: "Uber Technologies Inc.\nUber B.V." and "Uber Technologies Inc., Uber
 * B.V." are both two parties. A legal form cut off by a line break or a comma ("FACTOR ENERGÍA,\r\nS.A.") stays
 * with its name. The whole entry, on one line, comes first.
 */
export function partiesOf(raw) {
  const whole = oneLine(raw);
  if (!whole) return [];
  const pieces = String(raw).split(/\r?\n|,/).map(oneLine).filter(Boolean);
  const parts = [];
  for (const piece of pieces) {
    // a piece that is only a legal form ("S.A.U.", "S.C.C.") or nothing belongs to the party before it
    const rest = ` ${piece} `.replace(new RegExp(LEGAL_FORM.source, 'gi'), ' ').replace(/[\s.,]+/g, '');
    if (parts.length && (!orgTokens(piece).length || !rest)) {
      parts[parts.length - 1] = `${parts[parts.length - 1]}, ${piece}`;
    } else {
      parts.push(piece);
    }
  }
  return [...new Set([whole, ...parts])];
}

/* ------------------------------------------------------------------ */
/* The list                                                            */
/* ------------------------------------------------------------------ */

/**
 * Build the compact index from the tracker's home page. Rows:
 *   e  case number (ETid)   k  country      a  authority     d  date as given
 *   f  fine in euros        p  parties      s  sector        r  articles     t  type of violation
 * Cases against private individuals are dropped here and never stored.
 */
export function parseTracker(html) {
  const text = String(html || '');
  const m = text.match(/<script\b[^>]*\bid=["']?et-cases["']?[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) throw new Error('The CMS Enforcement Tracker page has changed format: its list of cases was not found');
  let cases;
  try { cases = JSON.parse(m[1]); } catch { throw new Error('The CMS Enforcement Tracker list of cases could not be read'); }
  if (!Array.isArray(cases)) throw new Error('The CMS Enforcement Tracker list of cases is not in the expected format');
  const wellFormed = cases.filter((c) => c && typeof c === 'object' && Number.isInteger(Number(c.e)) && typeof c.p === 'string' && typeof (c.C ?? c.c) === 'string' && typeof c.a === 'string');
  if (cases.length < MIN_CASES) throw new Error(`The CMS Enforcement Tracker listed only ${cases.length} cases, too few to be the whole list`);
  if (wellFormed.length < cases.length * 0.9) throw new Error('The CMS Enforcement Tracker list of cases is not in the expected format');
  const rows = [];
  for (const c of wellFormed) {
    if (isPrivateParty(c.p, c.s)) continue;
    const fine = Number(c.f);
    rows.push({
      e: Number(c.e),
      k: clip(c.C || c.c, 40),
      a: clip(c.a, 120),
      d: dateOf(c.d),
      ...(Number.isFinite(fine) && fine > 0 ? { f: fine } : {}),
      p: String(c.p).replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, 240),
      s: clip(c.s, 60),
      r: clip(c.r, 300),
      t: clip(c.t, 120),
    });
  }
  return { v: 1, key: 'cms-enforcement-tracker', at: new Date().toISOString(), cases: cases.length, rows };
}

async function loadTracker(deadline) {
  const entry = await cachedEntry(CACHE_KEY, DAY_MS, async ({ deadline: d }) => parseTracker((await request(TRACKER_PAGE, {
    deadline: d, timeoutMs: 20000, maxBytes: 6 * 1024 * 1024, accept: 'text/html',
  })).text), { deadline });
  const at = Number(entry.at) || Date.parse(entry.value?.at || '') || Date.now();
  return { index: entry.value, at, fresh: entry.fresh !== false, asOf: new Date(at).toISOString().slice(0, 10) };
}

/* ------------------------------------------------------------------ */
/* Screening                                                           */
/* ------------------------------------------------------------------ */

const GRADE_RANK = { exact: 0, padded: 1, leading: 2, contains: 3 };
const squash = (tokens) => tokens.join('');
const dropThe = (tokens) => (tokens.length > 1 && tokens[0] === 'the' ? tokens.slice(1) : tokens);
const containsRun = (tokens, want) => {
  for (let i = 0; i + want.length <= tokens.length; i += 1) if (want.every((t, j) => tokens[i + j] === t)) return true;
  return false;
};

/**
 * The names a company is screened under, each with its matching key: the name as typed, then the legal names
 * learned for it. Names too short or too general to match ("AI", "The Company") are left out.
 */
export function screenedNames(subject, company) {
  return companyNames(subject, company, 3)
    .map((name, i) => ({ name, key: companyKey(name), learned: i > 0 }))
    .filter((n) => n.key.full.length && squash(n.key.full).length >= 3);
}

/** Is the company named distinctively enough for its exact name alone to stand for it? (the phase 1 rule) */
const distinctive = (key) => key.specific && (key.full.length >= 2 || !isOrdinaryWordCompany(key.full.join(' ')));

/**
 * The best match of one case for the company, or null.
 * @returns {{ grade: string, party: string, via: object, strong: boolean } | null}
 */
export function matchCase(row, names) {
  const squashed = squash(orgTokens(row.p));
  let best = null;
  for (const via of names) {
    const want = squash(via.key.core.length ? via.key.core : via.key.full);
    if (!squashed.includes(want) && !squashed.includes(squash(via.key.full))) continue;
    const parts = partiesOf(row.p);
    for (const party of parts) {
      const grade = matchOrgName(via.key, party);
      if (!grade) continue;
      // A learned legal name counts only when the party carries it whole ("Uber Technologies Inc."; the bare
      // brand "Uber B.V." does not)
      const strong = grade !== 'padded' && (via.learned
        ? via.key.full.length >= 2 && containsRun(dropThe(orgTokens(party)), via.key.full)
        : distinctive(via.key));
      // the party itself rather than the whole entry, when a single party carries the same grade
      const better = !best || (strong && !best.strong) || (strong === best.strong && (GRADE_RANK[grade] < GRADE_RANK[best.grade]
        || (GRADE_RANK[grade] === GRADE_RANK[best.grade] && party.length < best.party.length)));
      if (better) best = { grade, party, via, strong };
    }
  }
  return best;
}

/** The parties of a case as shown: companies by name, anything else that looks like a person as "another party". */
function shownParties(row, matchedParty) {
  const parts = partiesOf(row.p).slice(1);
  const list = (parts.length ? parts : [oneLine(row.p)]).map((p) => (p === matchedParty || LEGAL_FORM.test(` ${p} `) || !PERSON_WORDS.test(p) ? clip(p, 120) : 'another party'));
  return [...new Set(list)];
}

const MATCH_REASON = {
  exact: (n) => `the fined organisation's name is ${n}`,
  padded: (n) => `the fined organisation's name is ${n} followed by general words`,
  leading: (n) => `the fined organisation's name begins with ${n}`,
  contains: (n) => `the fined organisation's name contains ${n}`,
};

function caseFinding(ctx, row, hit, copy) {
  const amount = euros(row.f);
  const severity = Number(row.f) >= HIGH_FINE_EUR ? 'high' : 'medium';
  const parties = shownParties(row, hit.party);
  const company = hit.via.name;
  const possible = !hit.strong;
  const why = hit.grade === 'padded'
    ? `the fined organisation's name adds a general word to ${company}, so it may be another company`
    : `"${company}" is an ordinary word other organisations also use, so it may be another company`;
  const head = `${clip(hit.party, 90)}: ${amount ? `fined ${amount}` : 'fined'} by the ${row.a}${row.k ? ` (${row.k})` : ''}${row.d ? `, ${row.d}` : ''}`;
  return makeFinding(ctx.subject, {
    source: ID, sourceLabel: LABEL, category: 'regulatory', severity,
    title: possible ? `${head}: name match only, verify it is the same company` : head,
    quote: [
      `Fined: ${parties.join('; ')}${/\.$/.test(parties[parties.length - 1]) ? '' : '.'}`,
      row.k ? `Country: ${row.k}.` : '',
      `Authority: ${row.a}.`,
      row.d ? `Date of decision: ${row.d}.` : 'Date of decision: not stated.',
      amount ? `Fine: ${amount}.` : 'Fine: amount not stated.',
      row.r ? `Articles breached: ${row.r}.` : '',
      row.t ? `Type of violation: ${row.t}.` : '',
      row.s && !/^not assigned$/i.test(row.s) ? `Sector: ${row.s}.` : '',
      `Source: ${ATTRIBUTION} (${LICENCE}).`,
    ].filter(Boolean).join(' '),
    url: caseUrl(row.e),
    date: row.d || null,
    match: possible ? 'possible' : 'company',
    matchReasons: possible ? [MATCH_REASON[hit.grade](company), why] : [MATCH_REASON[hit.grade](company)],
    data: {
      register: 'CMS Enforcement Tracker', caseId: `ETid-${row.e}`, country: row.k || null, authority: row.a, decided: row.d || null,
      fineEur: Number(row.f) > 0 ? Number(row.f) : null, articles: row.r || null, violation: row.t || null, sector: row.s || null,
      fined: hit.party, matchedName: company, nameMatch: hit.grade, attribution: ATTRIBUTION, licence: LICENCE,
      listReadAt: new Date(copy.at).toISOString(),
      ...(possible ? { excludeFromTimeline: true, companyNamesake: true } : {}),
    },
  });
}

/* ------------------------------------------------------------------ */
/* The source                                                          */
/* ------------------------------------------------------------------ */

const none = (notes, partial) => ({ findings: [], threads: [], notes, ...(partial ? { partial } : {}) });

export const gdprFinesConnector = {
  id: ID,
  label: LABEL,
  kinds: ['company'],
  prior: 0.3,
  timeoutMs: 22000,
  enabled: () => !switchedOff(),
  unavailableReason: 'This source is not enabled on this deployment.',
  plan() {
    return [{ template: 'gdpr.fines', prior: 0.3, why: 'look for EU data-protection fines against the company' }];
  },
  async run(task, ctx) {
    const value = oneLine(task?.value);
    if (task?.kind !== 'company' || !value) return none([]);
    // A "company" that is the person's own name is never screened: this list is about companies only.
    if (typeof ctx?.subject?.hasName === 'function' && ctx.subject.hasName(value)) {
      return none([`EU data-protection fines: "${value}" is the person's own name, so it was not screened; this list is searched for companies only.`]);
    }
    const names = screenedNames(ctx?.subject, value);
    if (!names.length) {
      return none([`EU data-protection fines: "${value}" is too short or too general a company name to screen, so the CMS Enforcement Tracker was not searched for it.`], [`EU data-protection fines: "${clip(value, 40)}" not screened (name too short or too general)`]);
    }
    const copy = await loadTracker(ctx?.deadline);
    const index = copy.index;
    if (!index || !Array.isArray(index.rows)) throw new Error('The CMS Enforcement Tracker list could not be read');

    const hits = [];
    for (const row of index.rows) {
      const hit = matchCase(row, names);
      if (hit) hits.push({ row, hit });
    }
    hits.sort((a, b) => Number(b.hit.strong) - Number(a.hit.strong) || String(b.row.d).localeCompare(String(a.row.d)) || (Number(b.row.f) || 0) - (Number(a.row.f) || 0));
    const findings = hits.slice(0, MAX_FINDINGS).map(({ row, hit }) => caseFinding(ctx, row, hit, copy)).filter(Boolean);

    const searched = names.map((n) => n.name).join(' or ');
    const asOf = ` (list as of ${copy.asOf})`;
    const notes = [COVERAGE_NOTE];
    if (!hits.length) notes.push(`EU data-protection fines: searched the CMS Enforcement Tracker for ${searched} and found no fine against it${asOf}.`);
    else if (!hits.some((h) => h.hit.strong)) notes.push(`EU data-protection fines: ${hits.length === 1 ? 'one fine names' : `${hits.length} fines name`} an organisation called ${names[0].name}, but nothing in ${hits.length === 1 ? 'it' : 'them'} shows it is this company; each is listed as a name match to verify${asOf}.`);
    if (hits.length > MAX_FINDINGS) notes.push(`EU data-protection fines: ${hits.length} fines match ${searched}; the first ${MAX_FINDINGS} are shown.`);
    const out = { findings, threads: [], notes };
    if (!copy.fresh) {
      notes.push(`EU data-protection fines: the latest copy of the CMS Enforcement Tracker could not be downloaded, so the copy of ${copy.asOf} was searched.`);
      out.partial = [`EU data-protection fines: list as of ${copy.asOf}`];
    }
    return out;
  },
};
