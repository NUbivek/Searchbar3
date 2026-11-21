/**
 * Academic record and scholarly publications.
 *
 *   academic-record   ORCID (what the person entered about their own degrees
 *                     and jobs), and two thesis registries that do not depend
 *                     on the person: Crossref (type "dissertation") and
 *                     theses.fr (every French doctorate, with its defence
 *                     date). A thesis in a registry independently confirms a
 *                     claimed doctorate; an ORCID entry is only a claim, and
 *                     its title says so.
 *   publications      OpenAlex author records: where the person's papers say
 *                     they worked or studied, year by year, and how much they
 *                     published. A second timeline to hold a CV against.
 *
 * Many people share a name, and researchers more than most. A record is
 * kept only when its author's name is the subject's name; it is graded
 * above "possible" only when one of its institutions is a company or school
 * already known for the subject. Absence proves nothing: most universities
 * outside France do not deposit theses in an open registry.
 */
import { getJson } from '../http';
import { makeFinding, makeThread } from '../finding';
import { nameTokens, matchSubject } from '../identity';
import { companyKeyStrict, companyKeys, companyMatchForms, isOrdinaryWordCompany } from '../names';
import { cleanSentences } from '../guardrails';
import { profileFromUrl } from '../extract';

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const unique = (list) => [...new Set(list.filter(Boolean))];
const RANK = { confirmed: 3, likely: 2, company: 2, possible: 1 };
/**
 * Only the sentences the privacy rules reject are left out, so the rest of a
 * label or record survives. These are short labels (a school, a department, a
 * thesis title): the relatives rule, meant for prose, is not applied to them.
 */
const safe = (s) => clean(cleanSentences(clean(s), { kin: false }).text);

/* ------------------------------------------- organisation names in lists */

// Describing words a register may add after a distinctive company name ("Nikola Motor Company" for Nikola).
const ORG_TAIL = new Set(['motor', 'motors', 'ai', 'labs', 'lab', 'technologies', 'technology', 'tech', 'group', 'holdings', 'holding']);
const stripTail = (key) => {
  const words = String(key || '').split(' ').filter(Boolean);
  while (words.length > 1 && ORG_TAIL.has(words[words.length - 1])) words.pop();
  return words.join(' ');
};
const isDomainName = (v) => /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(String(v || ''));

/**
 * Every name a known company of the subject goes by: the name as known, and
 * the fuller legal names learned for it (identity.addCompanyAlias). Domains
 * are left out: they are not organisation names.
 */
export function companyNamesOf(subject, anchor) {
  const of = companyKeys(anchor.value)[0] || String(anchor.value).toLowerCase();
  const aliases = [...(subject?.anchors?.aliases || new Map()).values()].filter((x) => x.of === of && !isDomainName(x.value)).map((x) => x.value);
  return unique([anchor.value, ...aliases]);
}

/**
 * The known company of the subject that an organisation label from a
 * structured field (a Wikidata employer, an ORCID or OpenAlex institution, a
 * LittleSis relationship) IS, or null. Labels are compared as names, not
 * searched as text: the label's name without its legal form must equal one
 * of the company's names. A distinctive name may carry a describing tail
 * ("Nikola Motor Company" is Nikola); an ordinary word never does: "Mercury
 * Records" is not Mercury, and "Merge Labs" is not Merge. A bare prefix
 * never ties a namesake's employer to the subject.
 */
export function knownCompanyOf(subject, label) {
  const key = companyKeyStrict(label);
  if (!key) return null;
  for (const a of (subject?.anchors?.companies || new Map()).values()) {
    for (const name of companyNamesOf(subject, a)) {
      const n = companyKeyStrict(name);
      if (!n) continue;
      if (n === key) return a;
      if (isOrdinaryWordCompany(name)) continue;
      const short = stripTail(n);
      if (short.length >= 3 && short === stripTail(key) && !isOrdinaryWordCompany(short)) return a;
      // A unit of a distinctive organisation, written as one ("Inria Saclay - Île-de-France Research Centre",
      // "Theranos, Palo Alto"); "Nikola Tesla Institute" is not a unit of Nikola.
      if (key.startsWith(`${n} `) && (SEPARATED(label, name) || UNIT_WORDS.test(key.slice(n.length)))) return a;
    }
  }
  return null;
}
const escapeRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEPARATED = (label, name) => new RegExp(`^\\s*${escapeRe(clean(name))}\\s*[-–—,(/:|]`, 'i').test(clean(label));
const UNIT_WORDS = /\b(?:research (?:centre|center|unit|lab|laboratory)|campus|laboratory|division|department|branch office|subsidiary)\b/;

/**
 * Labels of a structured list that only begin with (or contain) a known
 * company's word without being that company ("Mercury Records", "Mercury
 * Insurance Group" for Mercury): organisations of namesakes.
 */
export function namesakeOrgs(subject, labels) {
  const anchors = [...(subject?.anchors?.companies || new Map()).values()];
  return unique((labels || []).map(clean)).filter((label) => {
    if (!label || knownCompanyOf(subject, label)) return false;
    const key = ` ${companyKeyStrict(label)} `;
    return anchors.some((a) => a.test(label) || companyNamesOf(subject, a).flatMap((n) => companyMatchForms(n)).some((f) => key.includes(` ${f.form} `)));
  });
}

/** The text with each namesake organisation replaced, so the grader cannot read the company's word inside it. */
export function maskOrgs(text, labels) {
  let out = String(text || '');
  for (const label of [...(labels || [])].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(label).join('another organisation');
  return out;
}

/** A year as a number, or null: "2019-05" -> 2019. */
export const yearNumber = (v) => {
  const m = String(v ?? '').match(/\b(1[89]\d{2}|20\d{2})\b/);
  return m ? Number(m[1]) : null;
};

/** "Mensch, Arthur" -> "Arthur Mensch". */
const unreverse = (s) => {
  const m = clean(s).match(/^([^,]+),\s*([^,]+)$/);
  return m ? `${m[2]} ${m[1]}` : clean(s);
};

/**
 * Is `candidate` the subject's name? Compared as words, ignoring case and
 * accents: the first and last names must be equal, and middle names may be
 * missing or abbreviated on either side ("Elizabeth A. Holmes" fits
 * "Elizabeth Holmes" and "Elizabeth Anne Holmes"), but a full middle name
 * of the subject may not be dropped ("Sam Fried" is not "Sam Bankman-Fried").
 * Stricter than a text search, because here the source gives the name as
 * its own field.
 */
export function personNameFits(subject, candidate) {
  const want = nameTokens(subject?.name);
  const got = nameTokens(unreverse(candidate));
  if (want.length < 2 || got.length < 2) return false;
  if (want.join('') === got.join('')) return true; // "Yann LeCun" / "Yann Le Cun"
  if (want[0] !== got[0] || want[want.length - 1] !== got[got.length - 1]) return false;
  const wantMid = want.slice(1, -1);
  const gotMid = got.slice(1, -1);
  if (!gotMid.length) return wantMid.every((t) => t.length === 1);
  let from = 0;
  for (const t of wantMid) {
    let hit = -1;
    for (let k = from; k < gotMid.length && hit < 0; k += 1) {
      const g = gotMid[k];
      if (g === t || (t.length === 1 && g[0] === t) || (g.length === 1 && t[0] === g)) hit = k;
    }
    if (hit < 0) return false;
    from = hit + 1;
  }
  return true;
}

/** First and last name as the person writes them, for field searches. */
function nameParts(name) {
  const parts = clean(name).split(' ').map((p) => p.replace(/^[,.]+|[,.]+$/g, '')).filter(Boolean);
  return parts.length >= 2 ? { first: parts[0], last: parts[parts.length - 1] } : null;
}

// What may follow a school's name and still be the same school ("Stanford University School of Medicine").
const SUB_UNIT = new Set(['university', 'school', 'college', 'faculty', 'department', 'graduate', 'business', 'law', 'medical', 'institute', 'center', 'centre', 'library', 'libraries', 'press']);
const GENERIC_SCHOOL_WORD = new Set(['university', 'universite', 'universitat', 'universidad', 'universita', 'college', 'school', 'institute', 'institut', 'ecole', 'of', 'the', 'de', 'du', 'des', 'la', 'le', 'and', 'for', 'at', 'in', 'state', 'national', 'technology']);
/*
 * Schools that were renamed or merged into another: each group is one school
 * under its successive names, the current name first. Data, kept short:
 * only names that registries really use for the same institution.
 */
const SCHOOL_ALIASES = [
  ['universite paris saclay', 'universite paris sud', 'universite paris 11', 'universite paris xi'],
  ['telecom paris', 'telecom paristech', 'ecole nationale superieure des telecommunications'],
  ['ecole normale superieure paris saclay', 'ens paris saclay', 'ecole normale superieure de cachan', 'ens cachan'],
];
/** A school's key under its current name ("universite paris sud faculte" -> "universite paris saclay faculte"). */
const currentName = (key) => {
  for (const [now, ...before] of SCHOOL_ALIASES) {
    for (const old of before) if (key === old || key.startsWith(`${old} `)) return `${now}${key.slice(old.length)}`;
  }
  return key;
};
const schoolKey = (s) => currentName(nameTokens(String(s || '').replace(/\([^)]*\)/g, ' ')).join(' '));
// The word for "university", "school" or "institute" in the languages registries use, read as the English word.
const SCHOOL_KIND = {
  university: 'university', universite: 'university', universitat: 'university', universidad: 'university', universita: 'university', universiteit: 'university', universidade: 'university',
  school: 'school', ecole: 'school', institute: 'institute', institut: 'institute', college: 'college',
};
/**
 * The same school named in two languages: "Université Paris-Saclay" is
 * "Paris-Saclay University". The distinctive words must be the same, in the
 * same order, and the kind of school the same, and exactly one of the names
 * must use a foreign word for it: two English names in a different order
 * ("University of Washington" / "Washington University") stay different.
 */
function translatedSchool(x, y) {
  const distinct = (k) => k.split(' ').filter((t) => !GENERIC_SCHOOL_WORD.has(t)).join(' ');
  const kinds = (k) => [...new Set(k.split(' ').map((t) => SCHOOL_KIND[t]).filter(Boolean))].sort().join(' ');
  const foreign = (k) => k.split(' ').some((t) => SCHOOL_KIND[t] && SCHOOL_KIND[t] !== t);
  const d = distinct(x);
  if (!d || d !== distinct(y) || !d.split(' ').some((t) => t.length >= 3)) return false;
  return Boolean(kinds(x)) && kinds(x) === kinds(y) && foreign(x) !== foreign(y);
}

/**
 * Are two institution names the same school? Equal once case, accents and
 * bracketed notes are removed, or one is the other followed by a sub-unit
 * ("Stanford" / "Stanford University" / "Stanford University School of
 * Medicine"), under the school's current name when it was renamed or
 * merged (SCHOOL_ALIASES: "Université Paris-Sud" is "Université
 * Paris-Saclay"), or the same name in another language (translatedSchool).
 * Deliberately narrow: "York University" is not "New York
 * University", "University of Washington" is not "Washington University".
 */
export function sameSchool(a, b) {
  const x = schoolKey(a);
  const y = schoolKey(b);
  if (!x || !y) return false;
  if (x === y || translatedSchool(x, y)) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (!short.split(' ').some((t) => t.length >= 3 && !GENERIC_SCHOOL_WORD.has(t))) return false;
  // "Boise State University, Albertsons Library" is Boise State University; two campuses
  // ("University of California, Berkeley" / "..., Los Angeles") are not each other.
  const [shortRaw, longRaw] = x.length <= y.length ? [String(a), String(b)] : [String(b), String(a)];
  if (!shortRaw.includes(',') && longRaw.includes(',') && schoolKey(longRaw.split(',')[0]) === short) return true;
  if (!long.startsWith(`${short} `)) return false;
  return SUB_UNIT.has(long.slice(short.length + 1).split(' ')[0]);
}

/**
 * The known company or school of the subject among a record's organisations,
 * if any. Each organisation is compared on its own: a company must be named
 * as itself (knownCompanyOf), never as the first word of a longer name.
 */
function knownOrganisation(subject, organisations) {
  const list = (Array.isArray(organisations) ? organisations : [organisations]).map(clean).filter(Boolean);
  for (const o of list) { const a = knownCompanyOf(subject, o); if (a) return a.value; }
  for (const a of subject.anchors.schools.values()) if (list.some((o) => a.test(o))) return a.value;
  return null;
}

/** The text a record is graded on: the name, then its organisations, with namesakes' organisations masked. */
function orgText(subject, head, organisations, tail = '') {
  const list = unique((organisations || []).map(clean));
  return maskOrgs(`${head}. ${list.join('; ')}. ${tail}`, namesakeOrgs(subject, list));
}

/**
 * How a record should be graded: the fields to hand to makeFinding.
 *
 * Normally the grader decides from `matchText` (the name plus the record's
 * institutions). One case is held back: when several researchers share the
 * name and the only thing tying this record to the subject is one school,
 * a namesake who went to the same school is a real possibility (it was
 * picked out of the namesakes because it lists that school). It then stays
 * "possible", and says why.
 */
function gradeRecord(subject, matchText, namesakes, registry) {
  const graded = matchSubject(subject, matchText);
  if (graded.level !== 'likely' || namesakes < 2 || graded.reasons.length > 1) return { fields: { matchText }, held: false };
  const onlySchool = [...subject.anchors.schools.values()].some((a) => a.test(matchText))
    && !['people', 'handles', 'domains'].some((kind) => [...subject.anchors[kind].values()].some((a) => a.test(matchText)));
  if (!onlySchool) return { fields: { matchText }, held: false };
  return {
    fields: { match: 'possible', matchReasons: [`${graded.reasons[0]}, but ${namesakes} people on ${registry} have this name and may share that school`] },
    held: true,
  };
}
/** A finding held at "possible" is not upgraded later on the strength of the same school. */
const hold = (finding, held) => { if (finding && held) finding.matchFixed = true; return finding; };

const looksLikeSchool = (name) => /univ|[ée]cole|coll[eè]ge|institut|school|polytech|academy|hochschule|politecnic|\b(?:ENS|MIT|ETH|EPFL|UCL|LSE)\b/i.test(name);
/** A school name fit for a thread: "Université Paris-Saclay (ComUE)" -> "Université Paris-Saclay". */
const schoolName = (name) => clean(String(name || '').replace(/\([^)]*\)/g, ' ').replace(/\s+$/, '')
  .replace(/,\s*[^,]*Librar(?:y|ies)$/i, '') // "Boise State University, Albertsons Library"
  .replace(/\s+Librar(?:y|ies)$/i, '')); // "West Virginia University Libraries"

function schoolThreads(names, why, trusted) {
  return unique(names.map(schoolName)).filter(looksLikeSchool).slice(0, 4).map((name) => makeThread('school', name, why, { trusted }));
}

/** Findings tied to the subject first; of the ones matched by name only, keep a few. */
function keepBest(findings, maxPossible) {
  const sorted = findings.filter(Boolean).sort((a, b) => (RANK[b.match] || 0) - (RANK[a.match] || 0));
  let possible = 0;
  return sorted.filter((f) => f.match !== 'possible' || (possible += 1) <= maxPossible);
}

/* ------------------------------------------------------------------ ORCID */

const ORCID_API = 'https://pub.orcid.org/v3.0';
const ORCID_ID = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;
const ORCID_LABEL = 'Academic record (ORCID, Crossref, theses.fr)';
const phrase = (s) => clean(String(s || '').replace(/["\\]/g, ' '));
const yearOf = (d) => (/^\d{4}$/.test(String(d?.year?.value || '')) ? String(d.year.value) : '');
const span = (start, end) => (start && end ? (start === end ? start : `${start}-${end}`) : start ? `from ${start}` : end ? `until ${end}` : '');
const ORCID_PAGE = 50;

/**
 * People registered on ORCID under the subject's name (optionally: only the
 * ones who list `school`). `namesakes` is how many people share the name.
 */
async function orcidCandidates(subject, ctx, school = '') {
  const parts = nameParts(subject.name);
  if (!parts) return { candidates: [], total: 0, namesakes: 0 };
  let q = `given-names:"${phrase(parts.first)}" AND family-name:"${phrase(parts.last)}"`;
  if (school) q += ` AND affiliation-org-name:"${phrase(school)}"`;
  const body = await getJson(`${ORCID_API}/expanded-search/?q=${encodeURIComponent(q)}&rows=${school ? 5 : ORCID_PAGE}`, { deadline: ctx.deadline });
  if (!body || typeof body !== 'object' || !('expanded-result' in body)) throw new Error('ORCID answered without a list of researchers');
  const rows = Array.isArray(body['expanded-result']) ? body['expanded-result'] : [];
  const candidates = [];
  for (const row of rows) {
    const id = clean(row?.['orcid-id']);
    if (!ORCID_ID.test(id)) continue;
    const name = clean(`${row['given-names'] || ''} ${row['family-names'] || ''}`);
    const names = [name, row['credit-name'], ...(Array.isArray(row['other-name']) ? row['other-name'] : [])].map(clean).filter(Boolean);
    const written = names.find((n) => personNameFits(subject, n));
    if (!written) continue;
    // the search result also carries e-mail addresses: never read
    candidates.push({ id, name: written, institutions: unique((row['institution-name'] || []).map(clean)) });
  }
  const total = Number(body['num-found']) || candidates.length;
  // Everyone on the page was compared by name; beyond one page the registry's own count is the best there is.
  return { candidates, total, namesakes: total > rows.length ? total : candidates.length };
}

function orcidEntries(body, key, id) {
  const out = [];
  for (const group of body?.['affiliation-group'] || []) {
    const s = group?.summaries?.[0]?.[key];
    const organisation = safe(s?.organization?.name);
    if (!organisation) continue;
    const source = s.source || {};
    // Entered by the person (or by a service acting for them) unless an organisation's own system wrote it.
    const selfReported = source['source-orcid']?.path === id || source['assertion-origin-orcid']?.path === id || !source['source-client-id'];
    out.push({
      role: safe(s['role-title']), department: safe(s['department-name']), organisation,
      start: yearOf(s['start-date']), end: yearOf(s['end-date']),
      selfReported, enteredBy: selfReported ? '' : clean(source['source-name']?.value),
    });
  }
  return out.sort((a, b) => Number(b.end || b.start || 0) - Number(a.end || a.start || 0));
}

/** The websites a record lists ("researcher-urls"): http(s) links only. */
function orcidUrls(body) {
  return (Array.isArray(body?.['researcher-url']) ? body['researcher-url'] : [])
    .map((u) => ({ name: safe(u?.['url-name']), url: clean(u?.url?.value) }))
    .filter((u) => /^https?:\/\//i.test(u.url)).slice(0, 8);
}

/**
 * What a person lists on ORCID: education, employment, qualifications
 * (licences, certifications), distinctions (awards), invited positions and
 * their own websites. Never /person, /email or /address: those sections hold
 * contact details. Education or employment must answer; the other sections
 * are a supplement and their failure is no failure of the lookup.
 */
async function orcidRecord(id, ctx) {
  const section = (name) => getJson(`${ORCID_API}/${id}/${name}`, { deadline: ctx.deadline });
  const [education, employment, qualifications, distinctions, invited, urls] = await Promise.allSettled([
    section('educations'), section('employments'), section('qualifications'), section('distinctions'), section('invited-positions'), section('researcher-urls'),
  ]);
  if (education.status === 'rejected' && employment.status === 'rejected') throw education.reason;
  const read = (r, key) => (r.status === 'fulfilled' ? orcidEntries(r.value, key, id) : []);
  return {
    education: read(education, 'education-summary'),
    employment: read(employment, 'employment-summary'),
    qualifications: read(qualifications, 'qualification-summary'),
    distinctions: read(distinctions, 'distinction-summary'),
    invited: read(invited, 'invited-position-summary'),
    urls: urls.status === 'fulfilled' ? orcidUrls(urls.value) : [],
  };
}

// Hosts where a link is a page on someone else's site, not the person's own website.
const SHARED_HOSTS = /(?:^|\.)(?:github\.com|github\.io|gitlab\.com|linkedin\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|youtube\.com|medium\.com|substack\.com|google\.com|scholar\.google\.[a-z.]+|researchgate\.net|academia\.edu|orcid\.org|wikipedia\.org|wordpress\.com|blogspot\.com|sites\.google\.com|bit\.ly|linktr\.ee)$/i;
const TWO_LEVEL_SUFFIX = /\.(?:co|com|org|ac|net|gov|edu)\.[a-z]{2}$/;

/** Threads from a website a record tied to the person lists: a known profile page, or their own domain. */
function websiteThreads(link, why) {
  let url;
  try { url = new URL(clean(link)); } catch { return []; }
  if (!/^https?:$/.test(url.protocol)) return [];
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host)) return [];
  const profile = profileFromUrl(url.href);
  if (profile) return [makeThread('url', profile.url, `${profile.platform} profile ${why}`, { trusted: true, platform: profile.platform })].filter(Boolean);
  // A university page is a department's site, not the person's own domain.
  if (SHARED_HOSTS.test(host) || /\.edu$|\.ac\.[a-z]{2}$/.test(host)) return [];
  const labels = host.split('.');
  return [makeThread('domain', labels.slice(TWO_LEVEL_SUFFIX.test(host) ? -3 : -2).join('.'), `website ${why}`, { trusted: true })].filter(Boolean);
}

/**
 * One finding for the degrees and qualifications a record lists and one for
 * the jobs, invited positions and distinctions, plus the schools (and, on a
 * record tied to the person, their own websites) as threads.
 * `exact`: the reason this very record is the person's (an ORCID iD listed on
 * an entry already tied to them); it is then 'likely', never more.
 */
function orcidFindings(subject, candidate, record, { alsoKnownAs = '', namesakes = 1, exact = '' } = {}) {
  const qualifications = record.qualifications || [];
  const distinctions = record.distinctions || [];
  const invited = (record.invited || []).map((e) => ({ ...e, role: e.role ? `${e.role} (invited)` : 'invited position' }));
  const organisations = unique([...candidate.institutions, ...record.education.map((e) => e.organisation), ...record.employment.map((e) => e.organisation), ...qualifications.map((e) => e.organisation), ...invited.map((e) => e.organisation)]);
  const grade = exact
    ? { fields: { match: 'likely', matchReasons: [exact] }, held: false }
    : gradeRecord(subject, orgText(subject, `${subject.name}. ${candidate.name}`, organisations, alsoKnownAs), namesakes, 'ORCID');
  const short = (e) => [e.role, e.organisation, span(e.start, e.end)].filter(Boolean).join(', ');
  /** As many entries (up to three) as fit in one line, without repeats ("B.S., Stanford" twice for two majors). */
  const headline = (list) => {
    const all = unique(list.map(short));
    let shown = [];
    for (const entry of all.slice(0, 3)) {
      if (shown.length && [...shown, entry].join('; ').length > 150) break;
      shown = [...shown, entry];
    }
    return `${shown.join('; ')}${all.length > shown.length ? `; and ${all.length - shown.length} more` : ''}`;
  };
  const long = (e) => `${[e.role, e.department, e.organisation, span(e.start, e.end)].filter(Boolean).join(', ')}${e.selfReported ? '' : ` [entered by ${e.enteredBy || 'the institution'}]`}`;
  const year = (v) => yearNumber(v);
  const findings = [];
  const groups = [
    { list: [...record.education, ...qualifications], category: 'education' },
    { list: [...record.employment, ...invited], category: 'career', extra: distinctions },
  ];
  for (const { list, category, extra = [] } of groups) {
    const all = [...list, ...extra];
    if (!all.length) continue;
    const allSelf = all.every((e) => e.selfReported);
    const noneSelf = all.every((e) => !e.selfReported);
    const prefix = allSelf ? 'ORCID (self-reported)' : noneSelf ? 'ORCID (entered by the institution)' : 'ORCID (partly self-reported)';
    const head = list.length ? headline(list) : `distinctions: ${headline(extra)}`;
    const quote = [
      list.length ? `${candidate.name}: ${list.slice(0, 8).map(long).join(' | ')}` : '',
      extra.length ? `Distinctions: ${extra.slice(0, 6).map(long).join(' | ')}` : '',
    ].filter(Boolean).join('. ');
    const data = {
      registry: 'ORCID', orcid: candidate.id, selfReported: allSelf,
      entries: list.slice(0, 12).map(({ role, department, organisation, start, end, selfReported }) => ({ role, department, organisation, start, end, selfReported })),
    };
    // Structured fields the profile reads (years as numbers): see apiChanges for the shape.
    if (category === 'education') {
      data.education = record.education.slice(0, 12).map((e) => ({ school: e.organisation, degree: e.role || null, field: e.department || null, from: year(e.start), to: year(e.end) }));
      if (qualifications.length) data.qualifications = qualifications.slice(0, 12).map((e) => ({ org: e.organisation, title: e.role || null, from: year(e.start), to: year(e.end) }));
    } else {
      data.employers = record.employment.slice(0, 12).map((e) => ({ org: e.organisation, title: e.role || null, from: year(e.start), to: year(e.end) }));
      if (invited.length) data.positions = invited.slice(0, 12).map((e) => ({ title: e.role || null, of: e.organisation, from: year(e.start), to: year(e.end) }));
      if (extra.length) data.awards = extra.slice(0, 12).map((e) => ({ text: [e.role, e.organisation].filter(Boolean).join(', '), year: year(e.end || e.start) }));
    }
    const first = list[0] || extra[0];
    findings.push(hold(makeFinding(subject, {
      source: 'academic-record', sourceLabel: ORCID_LABEL, category,
      title: `${prefix}: ${head}`,
      quote,
      url: `https://orcid.org/${candidate.id}`,
      date: first.end || first.start || null,
      severity: 'info',
      ...grade.fields,
      data,
    }), grade.held));
  }
  const kept = findings.filter(Boolean);
  const education = kept.find((f) => f.category === 'education');
  const threads = education
    ? schoolThreads(record.education.map((e) => e.organisation), 'listed as a place of study on their ORCID record (self-reported)', education.match !== 'possible')
    : [];
  // The person's own websites, from a record tied to them by more than the name.
  if (kept.some((f) => f.match !== 'possible')) {
    for (const u of record.urls || []) threads.push(...websiteThreads(u.url, 'listed on their ORCID record (self-reported)'));
  }
  return { findings: kept, threads };
}

/** A researcher profile under the subject's name whose record was not read: only what the search itself shows. */
function orcidSummary(subject, candidate, namesakes = 1) {
  if (!candidate.institutions.length) return null;
  const shown = candidate.institutions.slice(0, 3).join(', ');
  const grade = gradeRecord(subject, orgText(subject, `${subject.name}. ${candidate.name}`, candidate.institutions), namesakes, 'ORCID');
  return hold(makeFinding(subject, {
    source: 'academic-record', sourceLabel: ORCID_LABEL, category: 'identity',
    title: `ORCID (self-reported): a researcher profile under this name lists ${shown}${candidate.institutions.length > 3 ? ` and ${candidate.institutions.length - 3} more` : ''}`,
    quote: `${candidate.name}: ${candidate.institutions.join('; ')}`,
    url: `https://orcid.org/${candidate.id}`,
    severity: 'info',
    ...grade.fields,
    data: { registry: 'ORCID', orcid: candidate.id, selfReported: true },
  }), grade.held);
}

async function runOrcid(subject, ctx) {
  const { candidates, total, namesakes } = await orcidCandidates(subject, ctx);
  if (!candidates.length) return { findings: [], threads: [], notes: [] };
  const tied = candidates.filter((c) => knownOrganisation(subject, c.institutions));
  // Read a record only when it is tied to the subject, or when it is the only one under the name.
  const toRead = tied.length ? tied.slice(0, 2) : candidates.length === 1 ? candidates : [];
  const findings = [];
  const threads = [];
  const notes = [];
  if (toRead.length) {
    const records = await Promise.allSettled(toRead.map((c) => orcidRecord(c.id, ctx)));
    if (records.every((r) => r.status === 'rejected')) throw records[0].reason;
    records.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      const built = orcidFindings(subject, toRead[i], r.value, { namesakes });
      findings.push(...built.findings);
      threads.push(...built.threads);
      // A record with no public degrees or jobs still says where the person is registered.
      if (!built.findings.length) findings.push(orcidSummary(subject, toRead[i], namesakes));
    });
  } else {
    findings.push(...candidates.map((c) => orcidSummary(subject, c, namesakes)).filter(Boolean).slice(0, 3));
    notes.push(`ORCID lists ${total} researchers named ${subject.name}; none names a company or school already known for this person, so their records were not read.`);
  }
  return { findings: findings.filter(Boolean), threads, notes };
}

/* ------------------------------------------------------- thesis registries */

const CROSSREF = 'https://api.crossref.org/works';
const CROSSREF_FIELDS = 'DOI,title,author,publisher,degree,approved,issued';
const THESES_FR = 'https://theses.fr/api/v1/theses/recherche/';
const ABES = /agence bibliographique de l.enseignement sup/i; // the French registry itself, not a university

function thesisKind(degrees) {
  const d = (degrees || []).join(' ');
  if (!d) return 'Thesis';
  if (/\bph\.?\s?d\b|\bd\.?\s?phil\b|doctor/i.test(d)) return 'Doctoral thesis';
  if (/master|magister|\bM\.?\s?(?:A|S|Sc|Phil|Eng|F\.?A|B\.?A)\b/i.test(d)) return "Master's thesis";
  if (/bachelor|honou?rs|\bB\.?\s?(?:A|S|Sc|Eng)\b/i.test(d)) return 'Undergraduate thesis';
  return 'Thesis';
}

/*
 * Crossref asks anonymous readers for one request at a time and at most one
 * a second. Several lookups of one check can want it at once (the person,
 * then each school), so they take turns here instead of being refused.
 */
const CROSSREF_GAP_MS = 1100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let crossrefQueue = Promise.resolve();
let crossrefNextAt = 0;
let crossrefGapMs = CROSSREF_GAP_MS;

async function crossrefTurn(deadline, fn) {
  const before = crossrefQueue;
  let release;
  crossrefQueue = new Promise((resolve) => { release = resolve; });
  let started = false;
  try {
    await before;
    const wait = Math.max(0, crossrefNextAt - Date.now());
    if (deadline && Date.now() + wait + 2500 > deadline) throw new Error('Out of time waiting for a turn at the Crossref thesis registry');
    if (wait > 0) await sleep(wait);
    started = true;
    return await fn();
  } finally {
    if (started) crossrefNextAt = Date.now() + crossrefGapMs;
    release();
  }
}

const partsToDate = (parts) => {
  const [y, m, d] = Array.isArray(parts?.[0]) ? parts[0] : [];
  if (!y) return '';
  return m && d ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : String(y);
};

/** Theses in Crossref whose first-named author is the subject. `school` narrows the search to one university. */
async function crossrefTheses(subject, ctx, school = '') {
  const params = new URLSearchParams({ 'query.author': subject.name });
  if (school) { params.set('query.affiliation', school); params.set('query.publisher-name', school); }
  params.set('filter', 'type:dissertation');
  params.set('rows', '20');
  params.set('select', CROSSREF_FIELDS);
  const body = await crossrefTurn(ctx.deadline, () => getJson(`${CROSSREF}?${params}`, { deadline: ctx.deadline }));
  const items = Array.isArray(body?.message?.items) ? body.message.items : [];
  const out = [];
  for (const item of items) {
    // Some universities list the committee as further "authors": only the first-named author wrote the thesis.
    const authors = (item.author || []).filter((a) => a?.family);
    const author = authors.find((a) => a.sequence === 'first') || authors[0];
    if (!author || !item.DOI) continue;
    const written = clean(`${author.given || ''} ${author.family}`);
    if (!personNameFits(subject, written)) continue;
    const title = clean((item.title || [])[0]);
    if (!title) continue;
    const affiliations = unique((author.affiliation || []).map((a) => clean(a?.name)));
    const publisher = ABES.test(item.publisher || '') ? '' : clean(item.publisher);
    const date = partsToDate(item.approved?.['date-parts']) || partsToDate(item.issued?.['date-parts']);
    out.push({
      registry: 'Crossref', kind: thesisKind(item.degree), author: written, title, original: '',
      institution: affiliations[0] || schoolName(publisher), institutions: unique([...affiliations, publisher]),
      discipline: '', degree: (item.degree || []).map(clean).join(', '), defended: true, date,
      doi: String(item.DOI).toLowerCase(), url: `https://doi.org/${item.DOI}`, supervisors: [],
    });
  }
  return out;
}

const frenchDate = (s) => {
  const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return '';
  return m[1] === '01' && m[2] === '01' ? m[3] : `${m[3]}-${m[2]}-${m[1]}`; // 1 January is the registry's placeholder for "year only"
};

/** French doctoral theses (defended or in preparation) whose author is the subject. */
async function frenchTheses(subject, ctx) {
  const parts = nameParts(subject.name);
  if (!parts) return [];
  const words = `${parts.first} ${parts.last}`.split(/[\s-]+/).map((w) => w.replace(/[^\p{L}\p{N}'’]/gu, '')).filter(Boolean);
  if (words.length < 2) return [];
  const q = `auteursNP:(${words.join(' AND ')})`;
  const body = await getJson(`${THESES_FR}?q=${encodeURIComponent(q)}&debut=0&nombre=10`, { deadline: ctx.deadline });
  const out = [];
  for (const t of Array.isArray(body?.theses) ? body.theses : []) {
    const author = (t.auteurs || []).map((a) => clean(`${a?.prenom || ''} ${a?.nom || ''}`)).find((n) => personNameFits(subject, n));
    if (!author || !t.id) continue;
    const original = clean(t.titrePrincipal);
    const title = clean(t.titreEN) || original;
    if (!title) continue;
    const defended = t.status === 'soutenue';
    const partners = (t.partenairesDeRecherche || []).filter((p) => /tablissement/i.test(p?.type || '')).map((p) => clean(p.nom));
    out.push({
      registry: 'theses.fr', kind: defended ? 'Doctoral thesis' : 'Doctoral thesis in preparation', author, title, original: original === title ? '' : original,
      institution: clean(t.etabSoutenanceN), institutions: unique([clean(t.etabSoutenanceN), ...partners]),
      discipline: clean(t.discipline), degree: 'Doctorat', defended,
      date: defended ? frenchDate(t.dateSoutenance) : frenchDate(t.datePremiereInscriptionDoctorat),
      dateAsWritten: defended && frenchDate(t.dateSoutenance).length > 4 ? clean(t.dateSoutenance) : (defended ? frenchDate(t.dateSoutenance) : ''),
      doi: clean(t.doi).toLowerCase(), url: `https://theses.fr/${encodeURIComponent(t.id)}`,
      // the supervisor is part of the public thesis record; the jury is left out
      supervisors: (t.directeurs || []).map((d) => clean(`${d?.prenom || ''} ${d?.nom || ''}`)).filter(Boolean).slice(0, 2),
    });
  }
  return out;
}

/* A defended thesis tied to the subject three ways at once ---------------- */

/** Records of this check (when the loop hands them over) found so far. */
function earlierFindings(ctx) {
  let list = [];
  try { list = typeof ctx?.findings === 'function' ? ctx.findings() : ctx?.findings; } catch { list = []; }
  return Array.isArray(list) ? list.filter(Boolean) : [];
}

const yearsIn = (s) => (String(s || '').match(/\b(?:19|20)\d{2}\b/g) || []).map(Number);

/**
 * The schools and years a confirmed education record states: the entries of
 * an ORCID record, or "educated at X (2011-2015)" / "student at X" in the
 * title of a record from another source. A school without years is left out.
 */
function confirmedStudies(findings) {
  const out = [];
  for (const f of findings) {
    if (f.match !== 'confirmed' || f.category !== 'education') continue;
    if (Array.isArray(f.data?.entries)) {
      for (const e of f.data.entries) if (e?.organisation && (e.start || e.end)) out.push({ organisation: e.organisation, start: Number(e.start) || 0, end: Number(e.end) || 0 });
      continue;
    }
    const m = String(f.title || '').match(/\b(?:educated at|student at)\s+(.+?)(?:,|\s\(|$)/i);
    const years = yearsIn(`${f.title} ${f.quote || ''}`);
    if (m && years.length) out.push({ organisation: m[1], start: Math.min(...years), end: Math.max(...years) });
  }
  return out;
}

/** A defence in `year` falls within the stated years (the record may close a year late). */
function yearFits(year, { start, end }) {
  if (start && end) return year >= start && year <= end + 1;
  if (end) return Math.abs(year - end) <= 1;
  return year >= start && year <= start + 8;
}

/** Is the person named, first and last name together, in the text of a record? */
function namesPerson(name, f) {
  const want = nameTokens(name);
  if (want.length < 2) return false;
  const got = nameTokens(`${f.title || ''} ${f.quote || ''}`);
  for (let i = 0; i + want.length <= got.length; i += 1) if (want.every((w, k) => got[i + k] === w)) return true;
  return false;
}

/**
 * Why a thesis is the subject's own beyond doubt, or '' when it is not:
 * its school and defence year are those of a confirmed education record,
 * and its supervisor is named in a confirmed record about the subject
 * (other than this thesis). A namesake would have to share all three.
 */
function thesisConfirmation(t, earlier) {
  const year = Number(String(t.date || '').slice(0, 4));
  if (!t.defended || !year || !t.supervisors.length || !earlier.length) return '';
  const confirmed = earlier.filter((f) => f.match === 'confirmed' && f.url !== t.url);
  const study = confirmedStudies(confirmed).find((e) => t.institutions.some((i) => sameSchool(i, e.organisation)) && yearFits(year, e));
  if (!study) return '';
  const supervisor = t.supervisors.find((s) => confirmed.some((f) => namesPerson(s, f)));
  if (!supervisor) return '';
  return `defended at ${study.organisation} in ${year}, the school and years of a confirmed education record, under ${supervisor}, who is named in a confirmed record about the subject`;
}

function thesisFinding(subject, t, { alsoKnownAs = '', namesakes = 1, earlier = [] } = {}) {
  const year = t.date.slice(0, 4);
  const where = [t.institution, t.defended ? year : year && `registered ${year}`].filter(Boolean).join(', ');
  const topic = safe(t.title); // a thesis about a medical subject is not a statement about its author, but the filter cannot tell
  const discipline = safe(t.discipline);
  const title = `${t.kind}${topic ? `: ${topic}` : discipline ? ` in ${discipline}` : ''}${where ? ` (${where})` : ''}`;
  const quote = t.registry === 'theses.fr'
    ? [t.author, topic && safe(t.original || t.title), discipline, t.institution, t.defended ? (t.dateAsWritten ? `Soutenue le ${t.dateAsWritten}` : 'Soutenue') : 'Thèse en préparation', t.supervisors.length ? `Sous la direction de ${t.supervisors.join(', ')}` : ''].filter(Boolean).join('. ')
    : [t.author, topic, safe(t.degree), t.institutions.join('; '), t.date].filter(Boolean).join('. ');
  const confirmation = thesisConfirmation(t, earlier);
  const grade = confirmation
    ? { fields: { match: 'likely', matchReasons: [confirmation] }, held: false }
    : gradeRecord(subject, orgText(subject, `${subject.name}. ${t.author}`, t.institutions, alsoKnownAs), namesakes, 'the thesis registries');
  return hold(makeFinding(subject, {
    source: 'academic-record', sourceLabel: ORCID_LABEL, category: 'education',
    title, quote, url: t.url, date: t.date || null, severity: 'info',
    ...grade.fields,
    data: {
      registry: t.registry, degree: t.degree, defended: t.defended, institution: t.institution, institutions: t.institutions.slice(0, 6), ...(t.doi ? { doi: t.doi } : {}),
      // the degree as the profile reads it; a thesis in preparation is no degree yet
      ...(t.defended && t.institution ? { education: [{ school: t.institution, degree: t.degree || t.kind, field: discipline || null, from: null, to: yearNumber(year) }] } : {}),
    },
  }), grade.held);
}

/**
 * How many different people the theses under one name belong to, at least:
 * nobody writes two doctorates, so doctoral theses at different
 * universities are different people.
 */
function thesisAuthors(theses) {
  const schools = [];
  for (const t of theses) {
    if (!/^Doctoral/.test(t.kind) || !t.institution) continue;
    if (!schools.some((s) => sameSchool(s, t.institution))) schools.push(t.institution);
  }
  return Math.max(1, schools.length);
}

/** The same thesis is often in both registries: keep the French registry's copy, which carries the defence date. */
function dedupeTheses(list) {
  const key = (t) => nameTokens(t.title).join(' ');
  const french = list.filter((t) => t.registry === 'theses.fr');
  const dois = new Set(french.map((t) => t.doi).filter(Boolean));
  const titles = new Set(french.flatMap((t) => [key(t), nameTokens(t.original).join(' ')]).filter(Boolean));
  const seen = new Set();
  return list.filter((t) => {
    if (t.registry !== 'theses.fr' && (dois.has(t.doi) || titles.has(key(t)))) return false;
    if (seen.has(t.url)) return false;
    seen.add(t.url);
    return true;
  });
}

function thesisResult(subject, theses, { alsoKnownAs = '', namesakes = thesisAuthors(theses), earlier = [] } = {}) {
  const pairs = theses.map((t) => ({ t, f: thesisFinding(subject, t, { alsoKnownAs, namesakes, earlier }) })).filter((p) => p.f);
  const findings = keepBest(pairs.map((p) => p.f), 3);
  const threads = [];
  for (const { t, f } of pairs) {
    if (findings.includes(f)) threads.push(...schoolThreads([t.institution], `granted the ${t.kind.toLowerCase()} recorded in ${t.registry}`, f.match !== 'possible'));
  }
  return { findings, threads };
}

async function runTheses(subject, ctx) {
  const [crossref, french] = await Promise.allSettled([crossrefTheses(subject, ctx), frenchTheses(subject, ctx)]);
  if (crossref.status === 'rejected' && french.status === 'rejected') throw crossref.reason;
  const notes = [];
  if (crossref.status === 'rejected') notes.push('The Crossref thesis registry did not answer; only the French registry (theses.fr) was searched for a thesis.');
  if (french.status === 'rejected') notes.push('The French thesis registry (theses.fr) did not answer; only Crossref was searched for a thesis.');
  const theses = dedupeTheses([...(french.value || []), ...(crossref.value || [])]);
  return { ...thesisResult(subject, theses, { earlier: earlierFindings(ctx) }), notes };
}

/** A French school, whose doctorates are all in theses.fr. */
const FRENCH_SCHOOL = /[éèêàâçô]|\b(?:universit[ée]|[ée]cole|sorbonne|paris|saclay|lyon|grenoble|toulouse|marseille|bordeaux|lille|strasbourg|nantes|montpellier|rennes|inria|cnrs|ENS|INSA|polytechnique|sciences po|mines|centrale|t[ée]l[ée]com)\b/i;

/** Thesis and ORCID records found earlier in this check (when the loop hands them over) that already name the school. */
function earlierRecordsAt(ctx, school) {
  return earlierFindings(ctx).filter((f) => f?.source === 'academic-record' && f.data && [
    f.data.institution, ...(f.data.institutions || []), ...(f.data.entries || []).map((e) => e?.organisation),
  ].some((i) => i && sameSchool(i, school)));
}

/** What ties the subject to one school: an ORCID record that lists it, or a thesis it granted. */
async function runSchool(subject, school, ctx) {
  const orcid = (async () => {
    // Everyone under the name first: it shows who lists the school, and how many namesakes there are.
    const everyone = await orcidCandidates(subject, ctx);
    const lists = (c) => c.institutions.some((i) => sameSchool(i, school));
    let candidate = everyone.candidates.find(lists);
    if (!candidate && everyone.total > ORCID_PAGE) candidate = (await orcidCandidates(subject, ctx, school)).candidates.find(lists);
    if (!candidate) return { findings: [], threads: [] };
    const record = await orcidRecord(candidate.id, ctx);
    return orcidFindings(subject, candidate, record, { alsoKnownAs: school, namesakes: everyone.namesakes });
  })();
  const french = FRENCH_SCHOOL.test(school);
  const theses = (async () => {
    const [crossref, fr] = await Promise.allSettled([
      crossrefTheses(subject, ctx, school),
      french ? frenchTheses(subject, ctx) : Promise.resolve([]),
    ]);
    if (crossref.status === 'rejected' && fr.status === 'rejected') throw crossref.reason;
    const found = dedupeTheses([...(fr.value || []), ...(crossref.value || [])]);
    // The searches also return the name's theses elsewhere: they show whether the name is shared.
    const result = thesisResult(subject, found.filter((t) => t.institutions.some((i) => sameSchool(i, school))), { alsoKnownAs: school, namesakes: thesisAuthors(found), earlier: earlierFindings(ctx) });
    return { ...result, partial: crossref.status === 'rejected' || fr.status === 'rejected' };
  })();
  const [a, b] = await Promise.allSettled([orcid, theses]);
  if (a.status === 'rejected' && b.status === 'rejected') throw a.reason;
  const findings = [...(a.value?.findings || []), ...(b.value?.findings || [])];
  const notes = [];
  // A thesis or ORCID record found earlier in the check may already name the school: then saying "none" would be false.
  if (!findings.length && !earlierRecordsAt(ctx, school).length) {
    const partial = a.status === 'rejected' || b.status === 'rejected' || b.value?.partial;
    notes.push(`No thesis or ORCID entry ties ${subject.name} to ${school} in the open academic registries${partial ? ' that answered' : ''}. Most universities do not deposit theses there, so this neither confirms nor contradicts the claim.`);
  }
  // The school is already being followed; only its findings are new.
  return { findings, threads: [], notes };
}

/** "https://orcid.org/0000-0002-1825-0097" -> "0000-0002-1825-0097", or '' for any other link. */
export function orcidIdFromUrl(url) {
  const m = clean(url).match(/^https?:\/\/(?:www\.)?orcid\.org\/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\/?$/i);
  return m && ORCID_ID.test(m[1].toUpperCase()) ? m[1].toUpperCase() : '';
}

/**
 * The exact ORCID record a source tied to the person links to (a Wikidata
 * entry resolved by more than the name lists the iD). It is read without a
 * name search, so namesakes do not hide it, and graded 'likely': the link,
 * not the record's own words, ties it to the person.
 */
async function runOrcidId(subject, task, ctx) {
  const id = orcidIdFromUrl(task.value);
  if (!id || !(task.trusted || task.params?.trusted)) return { findings: [], threads: [], notes: [] };
  const record = await orcidRecord(id, ctx);
  const built = orcidFindings(subject, { id, name: subject.name, institutions: [] }, record, { exact: 'the exact ORCID record that a source tied to the person links to' });
  return { findings: built.findings, threads: built.threads, notes: built.findings.length ? [] : [`The ORCID record ${id} lists no public degrees or jobs.`] };
}

export const academicRecordConnector = {
  id: 'academic-record',
  label: ORCID_LABEL,
  kinds: ['subject', 'school', 'url'],
  prior: 0.4,
  timeoutMs: 18000,
  plan(thread) {
    // The loop's task does not carry the thread's trust, so the plan passes it on in params.
    if (thread.kind === 'url') return orcidIdFromUrl(thread.value) && thread.trusted ? [{ template: 'orcid-id', prior: 0.5, why: 'the ORCID record a tied entry links to', params: { trusted: true } }] : [];
    if (thread.kind === 'school') return [{ template: 'school', prior: 0.35, why: `thesis or ORCID entry at ${thread.value}` }];
    return [
      { template: 'orcid', prior: 0.4, why: 'degrees and jobs the person lists on ORCID' },
      { template: 'theses', prior: 0.4, why: 'thesis registries (Crossref, theses.fr)' },
    ];
  },
  async run(task, ctx) {
    const { subject } = ctx;
    if (task.kind === 'school') return runSchool(subject, clean(task.value), ctx);
    if (task.kind === 'url') return runOrcidId(subject, task, ctx);
    if (task.kind !== 'subject') return { findings: [], threads: [], notes: [] };
    if (task.template === 'orcid') return runOrcid(subject, ctx);
    if (task.template === 'theses') return runTheses(subject, ctx);
    // No query pattern given: both halves.
    const [orcid, theses] = await Promise.allSettled([runOrcid(subject, ctx), runTheses(subject, ctx)]);
    if (orcid.status === 'rejected' && theses.status === 'rejected') throw orcid.reason;
    const parts = [orcid, theses].filter((r) => r.status === 'fulfilled').map((r) => r.value);
    return {
      findings: parts.flatMap((p) => p.findings),
      threads: parts.flatMap((p) => p.threads),
      notes: [
        ...parts.flatMap((p) => p.notes),
        ...(orcid.status === 'rejected' ? ['ORCID did not answer; only the thesis registries were searched.'] : []),
        ...(theses.status === 'rejected' ? ['The thesis registries did not answer; only ORCID was searched.'] : []),
      ],
    };
  },
};

/* ---------------------------------------------------------------- OpenAlex */

const OPENALEX = 'https://api.openalex.org/authors';
const OPENALEX_FIELDS = 'id,orcid,display_name,display_name_alternatives,works_count,cited_by_count,summary_stats,affiliations';
const PUBLICATIONS_LABEL = 'Scholarly publications (OpenAlex)';
const count = (n) => Number(n || 0).toLocaleString('en-US');

/** [2016, 2017, 2018, 2020] -> "2016-2018, 2020". */
function yearRanges(years) {
  const ys = [...new Set(years.map(Number).filter((y) => y > 1800 && y < 2200))].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < ys.length; i += 1) {
    let j = i;
    while (j + 1 < ys.length && ys[j + 1] === ys[j] + 1) j += 1;
    out.push(j > i ? `${ys[i]}-${ys[j]}` : `${ys[i]}`);
    i = j;
  }
  return out.join(', ');
}

/** One person is often split over several author records; the ones that share an ORCID iD are read as one. */
function mergeAuthorRecords(records) {
  const byInstitution = new Map();
  for (const r of records) {
    for (const a of r.affiliations || []) {
      const name = safe(a?.institution?.display_name);
      if (!name) continue;
      const entry = byInstitution.get(name) || { institution: name, type: clean(a.institution.type), country: clean(a.institution.country_code), years: [] };
      entry.years.push(...(a.years || []));
      byInstitution.set(name, entry);
    }
  }
  const affiliations = [...byInstitution.values()]
    .map((a) => ({ ...a, years: [...new Set(a.years.map(Number))].sort((x, y) => y - x) }))
    .sort((a, b) => (b.years[0] || 0) - (a.years[0] || 0));
  return {
    ids: records.map((r) => String(r.id)),
    name: clean(records[0].display_name),
    orcid: clean(records[0].orcid).replace(/^https?:\/\/orcid\.org\//, ''),
    works: records.reduce((n, r) => n + (Number(r.works_count) || 0), 0),
    citations: records.reduce((n, r) => n + (Number(r.cited_by_count) || 0), 0),
    hIndex: Math.max(0, ...records.map((r) => Number(r.summary_stats?.h_index) || 0)),
    affiliations,
  };
}

/**
 * One author record as a finding. Graded like ORCID: when several author
 * records carry the name and only a shared school ties this one to the
 * subject, it is held at 'possible' (a namesake at the same school is a real
 * possibility). Institutions that only begin with a company's word are masked.
 */
function authorFinding(subject, author, namesakes = 1) {
  const lines = author.affiliations.map((a) => `${a.institution}: ${yearRanges(a.years)}`);
  const head = `Scholarly author record: ${author.name}, ${count(author.works)} works, ${count(author.citations)} citations`;
  // The most recent affiliations, as many (up to three) as fit in one line.
  let recent = '';
  for (const a of author.affiliations.slice(0, 3)) {
    const next = `${recent ? `${recent}; ` : ''}${a.institution} ${yearRanges(a.years)}`;
    if (recent && head.length + next.length > 190) break;
    recent = next;
  }
  const split = author.ids.length > 1 ? ` (${author.ids.length} author records sharing one ORCID iD)` : '';
  const grade = gradeRecord(subject, orgText(subject, `${subject.name}. ${author.name}`, author.affiliations.map((a) => a.institution)), namesakes, 'OpenAlex');
  return hold(makeFinding(subject, {
    source: 'publications', sourceLabel: PUBLICATIONS_LABEL, category: 'ip',
    title: `${head}${recent ? `; papers place them at ${recent}` : ''}`,
    quote: `${author.name}${split}. ${lines.slice(0, 12).join('; ') || 'No affiliation recorded.'}`,
    url: author.ids[0],
    date: author.affiliations[0]?.years[0] ? String(author.affiliations[0].years[0]) : null,
    severity: 'info',
    ...grade.fields,
    data: {
      openalex: author.ids, ...(author.orcid ? { orcid: author.orcid } : {}),
      works: author.works, citations: author.citations, hIndex: author.hIndex,
      affiliations: author.affiliations.slice(0, 15),
    },
  }), grade.held);
}

/* ---------------------------------------------------- OpenAlex dissertations */

const OPENALEX_WORKS = 'https://api.openalex.org/works';
const DISSERTATION_FIELDS = 'id,display_name,publication_year,authorships,type';
const dissertationSearches = new Map(); // name -> { at, results }

async function openAlexDissertations(name, ctx) {
  const key = nameTokens(name).join(' ');
  const hit = dissertationSearches.get(key);
  if (hit && Date.now() - hit.at < AUTHOR_TTL_MS) return hit.results;
  const params = new URLSearchParams({ filter: `type:dissertation,raw_author_name.search:${name.replace(/[,|:]/g, ' ')}`, 'per-page': '10', select: DISSERTATION_FIELDS });
  if (process.env.OPENALEX_API_KEY) params.set('api_key', process.env.OPENALEX_API_KEY);
  const body = await getJson(`${OPENALEX_WORKS}?${params}`, { deadline: ctx.deadline, retries: 0 });
  if (!Array.isArray(body?.results)) throw new Error('OpenAlex answered without a list of works');
  if (dissertationSearches.size >= 100) dissertationSearches.delete(dissertationSearches.keys().next().value);
  dissertationSearches.set(key, { at: Date.now(), results: body.results });
  return body.results;
}

const bareOrcid = (v) => clean(v).replace(/^https?:\/\/orcid\.org\//i, '').toUpperCase();

/**
 * Dissertations OpenAlex indexes under the person's name (ProQuest, HAL and
 * repository theses), with the awarding institution and year. Only the title,
 * year, institution and the author's ORCID iD are kept: affiliation strings
 * (which can hold street addresses) are never read. A dissertation is 'likely'
 * the person's when its author's ORCID iD is that of a record already tied to
 * them, or (graded like a thesis) its institution is a known school; else it
 * stays 'possible'. 'Dissertation' sometimes covers a master's thesis, so no
 * degree is claimed.
 */
export function dissertationFindings(subject, works, { tiedOrcids = [] } = {}) {
  const tied = new Set(tiedOrcids.map(bareOrcid).filter(Boolean));
  const items = [];
  for (const w of Array.isArray(works) ? works : []) {
    if (!w?.id || !/^https:\/\/openalex\.org\/W\d+$/i.test(clean(w.id))) continue;
    const authorship = (w.authorships || []).find((a) => [a?.raw_author_name, a?.author?.display_name].some((n) => n && personNameFits(subject, n)));
    if (!authorship) continue;
    const institutions = unique((authorship.institutions || []).map((i) => safe(i?.display_name)));
    const title = safe(w.display_name);
    const year = Number(w.publication_year) || null;
    items.push({ w, authorship, institutions, title, year, orcid: bareOrcid(authorship.author?.orcid) });
  }
  // Dissertations at different institutions are different people (nobody writes two).
  const schools = [];
  for (const it of items) if (it.institutions[0] && !schools.some((x) => sameSchool(x, it.institutions[0]))) schools.push(it.institutions[0]);
  const namesakes = Math.max(1, schools.length);
  const findings = [];
  for (const it of items) {
    const institution = it.institutions[0] || '';
    const byOrcid = it.orcid && tied.has(it.orcid);
    const grade = byOrcid
      ? { fields: { match: 'likely', matchReasons: [`the author's ORCID iD (${it.orcid}) is that of a record already tied to the person`] }, held: false }
      : gradeRecord(subject, orgText(subject, `${subject.name}. ${clean(it.authorship.raw_author_name || it.authorship.author?.display_name)}`, it.institutions), namesakes, 'OpenAlex');
    const where = [institution, it.year].filter(Boolean).join(', ');
    const made = hold(makeFinding(subject, {
      source: 'publications', sourceLabel: PUBLICATIONS_LABEL, category: 'education',
      title: `Dissertation${it.title ? `: ${it.title}` : ''}${where ? ` (${where})` : ''}`,
      quote: [clean(it.authorship.raw_author_name || it.authorship.author?.display_name), it.title, institution, it.year].filter(Boolean).join('. '),
      url: clean(it.w.id),
      date: it.year ? String(it.year) : null,
      severity: 'info',
      ...grade.fields,
      data: {
        registry: 'OpenAlex', kind: 'dissertation', institution: institution || null, institutions: it.institutions.slice(0, 4), year: it.year,
        ...(it.orcid ? { orcid: it.orcid } : {}),
        ...(institution ? { education: [{ school: institution, degree: null, field: null, from: null, to: it.year }] } : {}),
      },
    }), grade.held);
    if (made) findings.push(made);
  }
  return keepBest(findings, 2).slice(0, 4);
}

const ALLOWANCE_NOTE = 'Scholarly publications (OpenAlex) could not be searched: the daily allowance shared by this deployment\'s network address is used up. It resets each day.';

/*
 * Every search is counted against a small daily allowance, so the answer for
 * a name is kept for a few hours in this server instance's memory (never in
 * the database: it is about the person being checked).
 */
const AUTHOR_TTL_MS = 6 * 60 * 60 * 1000;
const authorSearches = new Map(); // name -> { at, results }

async function openAlexAuthors(name, ctx) {
  const key = nameTokens(name).join(' ');
  const hit = authorSearches.get(key);
  if (hit && Date.now() - hit.at < AUTHOR_TTL_MS) return hit.results;
  const params = new URLSearchParams({ search: name, 'per-page': '10', select: OPENALEX_FIELDS });
  if (process.env.OPENALEX_API_KEY) params.set('api_key', process.env.OPENALEX_API_KEY);
  // One request, never repeated on a refusal.
  const body = await getJson(`${OPENALEX}?${params}`, { deadline: ctx.deadline, retries: 0 });
  if (!Array.isArray(body?.results)) throw new Error('OpenAlex answered without a list of authors');
  if (authorSearches.size >= 100) authorSearches.delete(authorSearches.keys().next().value);
  authorSearches.set(key, { at: Date.now(), results: body.results });
  return body.results;
}

/** For tests: forget remembered answers and the Crossref queue. */
export function __resetScholarForTests({ crossrefGapMs: gap = CROSSREF_GAP_MS } = {}) {
  authorSearches.clear();
  dissertationSearches.clear();
  crossrefQueue = Promise.resolve();
  crossrefNextAt = 0;
  crossrefGapMs = gap;
}

export const publicationsConnector = {
  id: 'publications',
  label: PUBLICATIONS_LABEL,
  kinds: ['subject'],
  prior: 0.35,
  timeoutMs: 12000,
  async run(task, ctx) {
    const { subject } = ctx;
    if (task.kind !== 'subject' || nameTokens(subject.name).length < 2) return { findings: [], threads: [], notes: [] };
    let results;
    try {
      results = await openAlexAuthors(subject.name, ctx);
    } catch (error) {
      if ([429, 402, 403].includes(error?.status)) return { findings: [], threads: [], notes: [ALLOWANCE_NOTE] };
      throw error;
    }
    const records = results
      .filter((r) => r?.id && [r.display_name, ...(r.display_name_alternatives || [])].some((n) => personNameFits(subject, n)));
    const groups = new Map();
    for (const r of records) {
      const key = r.orcid || r.id;
      groups.set(key, [...(groups.get(key) || []), r]);
    }
    const all = [...groups.values()].map((g) => authorFinding(subject, mergeAuthorRecords(g), groups.size)).filter(Boolean);
    // A record matched by name only that places its author nowhere says nothing about anyone.
    const useful = all.filter((f) => f.match !== 'possible' || f.data.affiliations.length > 0);
    const findings = keepBest(useful, 3).slice(0, 3);
    const left = all.length - findings.length;
    const notes = left > 0
      ? [`OpenAlex holds ${left} more author record${left === 1 ? '' : 's'} under the name ${subject.name} that could not be tied to this person; ${left === 1 ? 'it was' : 'they were'} left out.`]
      : [];
    // Dissertations: a supplement; its failure is said, never shown as "no dissertation".
    try {
      const works = await openAlexDissertations(subject.name, ctx);
      const tiedOrcids = [
        ...findings.filter((f) => f.match !== 'possible').map((f) => f.data?.orcid),
        ...earlierFindings(ctx).filter((f) => f.match !== 'possible' && f.match !== 'company').map((f) => f.data?.orcid),
      ].filter(Boolean);
      findings.push(...dissertationFindings(subject, works, { tiedOrcids }));
    } catch (error) {
      if ([429, 402, 403].includes(error?.status)) notes.push('Dissertations on OpenAlex could not be searched: the daily allowance shared by this deployment\'s network address is used up.');
      else if (error?.status !== 404) notes.push(`Dissertations on OpenAlex could not be searched (${clean(error?.message) || 'no answer'}).`);
    }
    // Affiliations come from paper bylines (a visiting line is not a job), so they are reported, not followed.
    return { findings, threads: [], notes };
  },
};
