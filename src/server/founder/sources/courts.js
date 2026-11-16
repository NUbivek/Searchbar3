/**
 * Courts, enforcement and regulator records.
 *
 *   courtDocketsConnector       US federal dockets and opinions (CourtListener), needs a token
 *   courtRecordsOpenConnector   the same dockets by case title (Internet Archive copy), when there is no token
 *   dojConnector                US Department of Justice press releases
 *   brokerCheckConnector        FINRA BrokerCheck and SEC adviser registrations, disclosures and bars
 *   ukGazetteConnector          UK corporate insolvency and winding-up notices
 *   ukCaseLawConnector          judgments of UK courts and tribunals
 *   bodaccConnector             French insolvency proceedings, sales and dissolutions
 *   enforcementActionsConnector CFTC and CFPB enforcement actions
 *
 * The rule that shapes this whole file: a court record is pinned on the
 * subject only when the record itself ties them to it. Court and regulator
 * records carry structured names (a party list, a registrant's name), so a
 * name is compared part by part: "Trevor Milton Lund" and "Mary Elizabeth
 * Holmes" are other people and are thrown away; "Trevor R. Milton" and
 * "Samuel Bankman-Fried" (for Sam) are the same name. A record that carries
 * the same name and nothing else stays a possible namesake; it is confirmed
 * only when the record also names a company already tied to the subject.
 *
 * Privacy: personal bankruptcy dockets are reported only when confirmed;
 * personal insolvency notices are never read; no addresses, dates of birth,
 * ages or home towns are kept; no document text is downloaded.
 */
import * as cheerio from 'cheerio';
import { getJson, getText, htmlToText, HttpError } from '../http';
import { makeFinding, makeThread, severityFromText } from '../finding';
import { matchSubject, companyKeyStrict } from '../identity';
import { threadsFromResult } from '../extract';
import { companyKeys } from '../../founderCheck';

/* ------------------------------------------------------------------ text helpers */

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const uniq = (list) => [...new Set(list.filter(Boolean))];
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripAccents = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : w);
const plain = (html) => clean(htmlToText(String(html || '')));
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isoDay = (value) => {
  const t = Date.parse(String(value || ''));
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
};
/** "7/15/2014" (US order, as BrokerCheck writes dates) -> "2014-07-15". */
const usDay = (value) => {
  const m = String(value || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
};
const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3 };
const atLeast = (floor, severity) => (SEVERITY_RANK[severity] > SEVERITY_RANK[floor] ? severity : floor);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ------------------------------------------------------------------ people's names */

const NAME_SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'esq', 'md', 'phd', 'cpa']);
// The formal name first, then what people go by. Used both ways.
const NICKNAME_GROUPS = [
  ['samuel', 'sam'], ['michael', 'mike'], ['william', 'bill', 'will'], ['robert', 'bob', 'rob'], ['james', 'jim', 'jimmy'],
  ['joseph', 'joe'], ['thomas', 'tom'], ['daniel', 'dan'], ['david', 'dave'], ['steven', 'stephen', 'steve'],
  ['christopher', 'chris'], ['matthew', 'matt'], ['nicholas', 'nick'], ['anthony', 'tony'], ['benjamin', 'ben'],
  ['alexander', 'alex'], ['andrew', 'andy', 'drew'], ['gregory', 'greg'], ['jeffrey', 'jeff'], ['kenneth', 'ken'],
  ['lawrence', 'larry'], ['peter', 'pete'], ['richard', 'rick', 'rich', 'dick'], ['ronald', 'ron'], ['timothy', 'tim'],
  ['edward', 'ed', 'eddie'], ['frederick', 'fred'], ['charles', 'charlie', 'chuck'], ['jonathan', 'jon'], ['joshua', 'josh'],
  ['zachary', 'zach', 'zack'], ['nathaniel', 'nathan', 'nate'], ['philip', 'phillip', 'phil'], ['douglas', 'doug'],
  ['donald', 'don'], ['raymond', 'ray'], ['walter', 'walt'], ['gabriel', 'gabe'], ['maxwell', 'max'], ['patrick', 'pat'],
  ['elizabeth', 'liz', 'beth'], ['katherine', 'catherine', 'kate', 'katie', 'kathy'], ['jennifer', 'jen', 'jenny'],
  ['susan', 'sue'], ['margaret', 'meg', 'maggie', 'peggy'], ['rebecca', 'becky'], ['abigail', 'abby'], ['deborah', 'debbie', 'deb'],
  ['victoria', 'vicky'], ['christine', 'christina', 'chris', 'tina'], ['jacqueline', 'jackie'], ['pamela', 'pam'], ['cynthia', 'cindy'],
];
const NICK = new Map();
for (const group of NICKNAME_GROUPS) for (const n of group) NICK.set(n, uniq([...(NICK.get(n) || []), ...group]));
const sameGiven = (a, b) => a === b || Boolean(NICK.get(a)?.includes(b));

/**
 * Lowercase parts of a person's name, given name first. "MILTON, TREVOR R."
 * and "Trevor R. Milton" both become ["trevor", "r", "milton"]. A hyphenated
 * surname stays one part; suffixes and quoted nicknames are dropped.
 */
export function personTokens(name) {
  let s = stripAccents(name).replace(/["“”][^"“”]{0,24}["“”]/g, ' ').replace(/\([^)]{0,60}\)/g, ' ');
  const comma = s.match(/^([^,]+),\s*([^,]+)$/);
  if (comma && !NAME_SUFFIX.has(comma[2].trim().toLowerCase().replace(/\./g, ''))) s = `${comma[2]} ${comma[1]}`;
  return s.toLowerCase().replace(/['’.]/g, '').split(/[^a-z0-9-]+/).map((t) => t.replace(/^-+|-+$/g, '')).filter((t) => t && !NAME_SUFFIX.has(t));
}

const partFits = (a, b) => a === b || (a.length === 1 && b.startsWith(a)) || (b.length === 1 && a.startsWith(b));
const inOrder = (small, big) => {
  let i = 0;
  for (const t of big) if (i < small.length && partFits(small[i], t)) i += 1;
  return i === small.length;
};
/** "bankman fried" written as two parts is the same surname as "bankman-fried". */
const joinSurname = (c, surname) => (surname.includes('-') && c.length >= 3 && `${c[c.length - 2]}-${c[c.length - 1]}` === surname ? [...c.slice(0, -2), surname] : c);

function tokensMatch(candidate, subject) {
  const c = joinSurname(candidate, subject[subject.length - 1]);
  const s = joinSurname(subject, c[c.length - 1] || '');
  if (c.length < 2 || s.length < 2) return false;
  if (!sameGiven(c[0], s[0]) || c[c.length - 1] !== s[s.length - 1]) return false;
  const cm = c.slice(1, -1);
  const sm = s.slice(1, -1);
  return cm.length >= sm.length ? inOrder(sm, cm) : inOrder(cm, sm);
}

/**
 * Everything the name checks need about one person: the subject of the
 * check, or (for joint lookups) an associate given by name.
 */
export function person(subjectOrName) {
  const isSubject = subjectOrName && typeof subjectOrName === 'object';
  const name = clean(isSubject ? subjectOrName.name : subjectOrName);
  const variants = uniq([name, ...(isSubject ? subjectOrName.variants || [] : [])].map(clean));
  const forms = variants.map(personTokens).filter((t) => t.length >= 2);
  const words = name.split(' ').filter((w) => !NAME_SUFFIX.has(w.toLowerCase().replace(/[.,]/g, '')));
  const given = words[0] || '';
  const surname = words.length > 1 ? words[words.length - 1] : '';
  // The formal form of a short first name ("Sam" -> "Samuel"), for sources that file people under their legal name.
  const group = NICK.get(given.toLowerCase());
  const formal = group && group[0] !== given.toLowerCase() ? `${cap(group[0])} ${words.slice(1).join(' ')}` : '';
  return { name, variants, forms, given, surname, queryNames: uniq([name, formal]) };
}

/** Is this structured name (a party, a registrant) the person's own name, part for part? */
export function sameName(candidate, who) {
  const c = personTokens(candidate);
  return c.length >= 2 && who.forms.some((s) => tokensMatch(c, s));
}

const casings = (w) => uniq([w, w.toUpperCase(), cap(w.toLowerCase()), stripAccents(w), stripAccents(w).toUpperCase()]).map(escapeRe).join('|');
const MIDDLE = "(?:\\s+(?:[A-Z]\\.?|[A-Z][A-Za-zÀ-ÿ'’-]+)){0,2}?";

function mentionRe(who) {
  const parts = [];
  for (const variant of who.variants) {
    const words = variant.split(' ').filter((w) => !NAME_SUFFIX.has(w.toLowerCase().replace(/[.,]/g, '')));
    if (words.length < 2) continue;
    const givens = uniq([words[0], ...(NICK.get(words[0].toLowerCase()) || []).map(cap)]);
    const surname = casings(words[words.length - 1]).replace(/-/g, '[-\\s]');
    parts.push(`(?:${givens.map(casings).join('|')})${MIDDLE}\\s+(?:${surname})`);
  }
  return parts.length ? new RegExp(`(?<![A-Za-z0-9À-ÿ-])(?:${parts.join('|')})(?![A-Za-z0-9À-ÿ]|-[A-Za-z])`, 'g') : null;
}

/** Running prose (as opposed to a headline, where every word is capitalised). */
const isProse = (text) => {
  const words = String(text).split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
  return words.length >= 6 && words.filter((w) => /^[a-z]/.test(w)).length / words.length > 0.4;
};

/**
 * Where free text names the person. `extended` marks a mention that runs on
 * into another capitalised word ("Trevor Milton Lund"): in prose that is a
 * longer name, so somebody else.
 */
export function findMentions(text, who) {
  const re = mentionRe(who);
  const str = String(text || '');
  if (!re || !str) return [];
  const prose = isProse(str);
  const out = [];
  for (const m of str.matchAll(re)) {
    const end = m.index + m[0].length;
    const extended = prose && /^\s+(?:[A-Z][a-zà-ÿ'’]+|[A-Z]{2,})(?![a-z])/.test(str.slice(end, end + 40)) && !/^\s+(?:Jr|Sr|II|III|IV)\b/.test(str.slice(end, end + 8));
    out.push({ index: m.index, end, text: m[0], extended });
  }
  return out;
}

/** Does free text name the person themselves (and not only someone with a longer name)? */
export function namesPerson(text, who) {
  const mentions = findMentions(text, who);
  return mentions.length > 0 && mentions.some((m) => !m.extended);
}

/* ------------------------------------------------------------------ case names and companies */

/**
 * The parties in a case name: "Nikola Corporation v. Milton" -> ["Nikola
 * Corporation", "Milton"]; "Curtis James Holmes and Elizabeth Holmes" (a
 * joint bankruptcy) -> both debtors. Bracketed notes go to `asides`.
 */
export function caseParties(caseName) {
  const asides = [];
  const base = clean(caseName).replace(/&amp;/g, '&').replace(/\(([^)]{2,120})\)/g, (m, inner) => { asides.push(clean(inner.replace(/^(?:as successor to|formerly(?: known as)?|f\/k\/a|aka|a\/k\/a|t\/a|trading as|d\/b\/a)\s+/i, ''))); return ' '; });
  const tidy = (p) => clean(p.replace(/^(?:in\s+re:?|in the matter of|re:?|ex parte|estate of)\s+/i, '').replace(/\b(?:et\s+al\.?|and others|and another)\s*$/i, '').replace(/\s*&\s*(?:ors|anor|others|another)\.?\s*$/i, '').replace(/[,;:]+$/, ''));
  const sides = base.split(/\s+(?:v\.?|vs\.?|versus)\s+/i).map(tidy).filter(Boolean);
  const people = sides.flatMap((side) => side.split(/\s+(?:and|&)\s+|\s*;\s*/i)).map(tidy).filter(Boolean);
  return { sides, people: uniq([...sides, ...people]), asides };
}

const companyKey = (name) => companyKeys(name)[0] || '';
const plainKey = (s) => stripAccents(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/**
 * "Nikola Corporation" is Nikola; "Nikola D. Kasanin" and "Nikola Motor Works"
 * are not. Only legal forms are set aside: "Mistral AI, Inc." is Mistral AI,
 * but "Mistral, Inc." and "Mistral (SPC)" are other companies.
 */
export function sameCompany(candidate, company) {
  const a = companyKeyStrict(candidate);
  const b = companyKeyStrict(company);
  if (a && b) return a === b;
  const p = plainKey(candidate);
  return p.length > 1 && p === plainKey(company);
}
const LEGAL_FORM = /\b(?:inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|sa|sas|sarl|gmbh|ag|bv|nv|pty|lp|llp)\b/;
/**
 * Is one side of a case the company? A case title often names people by
 * surname alone, so when the company's name is one word the side must also
 * carry a legal form: "Flow, Inc." is the company; "Flow v. Payne" (a person
 * named Flow) and "Paymentwall v. We" are not.
 */
export function partyIsCompany(side, company) {
  if (!sameCompany(side, company)) return false;
  if (companyKeyStrict(company).split(' ').length >= 2) return true;
  return LEGAL_FORM.test(plainKey(side));
}
/** The words of a company name that identify it ("Nikola Corporation" -> "Nikola"). */
const companyCore = (company) => {
  const keep = new Set(companyKey(company).split(' '));
  const words = clean(company).split(' ').filter((w) => keep.has(plainKey(w)));
  return words.join(' ') || clean(company);
};
/** Companies already tied to the subject, the one given by the user first. */
const knownCompanies = (subject) => [...(subject?.anchors?.companies?.values() || [])]
  .sort((a, b) => (b.origin === 'given') - (a.origin === 'given')).map((a) => a.value);
const namesKnownCompany = (subject, text) => [...(subject?.anchors?.companies?.values() || [])].find((a) => a.test(text))?.value || '';
/**
 * Does a headline name the company itself? A side of a case-style title that
 * is the company ("Block, Inc."), or the full name with its legal form as
 * given ("Nikola Corporation Agrees to Pay ..."). The bare core word is not
 * enough: "Block Grant Fraud" and "Cash Flow Scheme" are not Block or Flow.
 */
function headlineNamesCompany(title, company) {
  if (caseParties(title).sides.some((side) => partyIsCompany(side, company))) return true;
  const full = clean(company);
  return full !== companyCore(company) && new RegExp(`(?<![A-Za-z0-9])${escapeRe(full)}(?![A-Za-z0-9])`).test(String(title || ''));
}

/* ------------------------------------------------------------------ US federal courts */

const STATES = {
  al: 'Alabama', ak: 'Alaska', az: 'Arizona', ar: 'Arkansas', ca: 'California', co: 'Colorado', ct: 'Connecticut', de: 'Delaware',
  dc: 'Columbia', fl: 'Florida', ga: 'Georgia', gu: 'Guam', hi: 'Hawaii', id: 'Idaho', il: 'Illinois', in: 'Indiana', ia: 'Iowa',
  ks: 'Kansas', ky: 'Kentucky', la: 'Louisiana', me: 'Maine', md: 'Maryland', ma: 'Massachusetts', mi: 'Michigan', mn: 'Minnesota',
  ms: 'Mississippi', mo: 'Missouri', mt: 'Montana', ne: 'Nebraska', nv: 'Nevada', nh: 'New Hampshire', nj: 'New Jersey',
  nm: 'New Mexico', ny: 'New York', nc: 'North Carolina', nd: 'North Dakota', nmi: 'the Northern Mariana Islands', oh: 'Ohio',
  ok: 'Oklahoma', or: 'Oregon', pa: 'Pennsylvania', pr: 'Puerto Rico', ri: 'Rhode Island', sc: 'South Carolina', sd: 'South Dakota',
  tn: 'Tennessee', tx: 'Texas', ut: 'Utah', vt: 'Vermont', va: 'Virginia', vi: 'the Virgin Islands', wa: 'Washington',
  wv: 'West Virginia', wi: 'Wisconsin', wy: 'Wyoming',
};
const DISTRICTS = { n: 'Northern', s: 'Southern', e: 'Eastern', w: 'Western', m: 'Middle', c: 'Central' };
const ORDINALS = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh'];

/** A federal court's name from its short code: "nysd" -> "US District Court, Southern District of New York". */
export function federalCourtName(code) {
  const c = String(code || '').toLowerCase();
  const appeals = c.match(/^ca(\d{1,2}|dc|fc)$/);
  if (appeals) return `US Court of Appeals, ${appeals[1] === 'dc' ? 'D.C.' : appeals[1] === 'fc' ? 'Federal' : ORDINALS[Number(appeals[1])] || appeals[1]} Circuit`;
  const m = c.match(/^(nmi|[a-z]{2})([nsewmc])?([db])$/);
  if (m && STATES[m[1]]) return `US ${m[3] === 'b' ? 'Bankruptcy' : 'District'} Court, ${m[2] ? `${DISTRICTS[m[2]]} District` : 'District'} of ${STATES[m[1]]}`;
  return c ? `US federal court (${c})` : 'US federal court';
}
// Court-citation abbreviations of states ("S.D.N.Y.", "N.D. Cal.", "D. Mass."), as written in releases.
const STATE_ABBR = {
  'ala': 'al', 'alaska': 'ak', 'ariz': 'az', 'ark': 'ar', 'cal': 'ca', 'calif': 'ca', 'colo': 'co', 'conn': 'ct', 'del': 'de', 'dc': 'dc',
  'fla': 'fl', 'ga': 'ga', 'haw': 'hi', 'idaho': 'id', 'ill': 'il', 'ind': 'in', 'iowa': 'ia', 'kan': 'ks', 'ky': 'ky', 'la': 'la',
  'me': 'me', 'md': 'md', 'mass': 'ma', 'mich': 'mi', 'minn': 'mn', 'miss': 'ms', 'mo': 'mo', 'mont': 'mt', 'neb': 'ne', 'nev': 'nv',
  'nh': 'nh', 'nj': 'nj', 'nm': 'nm', 'ny': 'ny', 'nc': 'nc', 'nd': 'nd', 'ohio': 'oh', 'okla': 'ok', 'or': 'or', 'ore': 'or', 'pa': 'pa',
  'pr': 'pr', 'ri': 'ri', 'sc': 'sc', 'sd': 'sd', 'tenn': 'tn', 'tex': 'tx', 'utah': 'ut', 'vt': 'vt', 'va': 'va', 'wash': 'wa',
  'wva': 'wv', 'wis': 'wi', 'wyo': 'wy',
};
const STATE_BY_NAME = new Map(Object.entries(STATES).map(([code, name]) => [name.replace(/^the /, '').toLowerCase(), code]));
const STATE_NAMES = [...STATE_BY_NAME.keys()].sort((a, b) => b.length - a.length).map((n) => escapeRe(n).replace(/ /g, '\\s+')).join('|');
const DISTRICT_WORD = '(Northern|Southern|Eastern|Western|Middle|Central)';

/**
 * The federal district courts a text names, as court codes: "the Southern
 * District of New York", "S.D.N.Y." and "USAO - New York, Southern" are all
 * "nysd"; "the District of New Jersey" and "D.N.J." are "njd".
 */
export function districtCodes(text) {
  const t = String(text || '');
  const out = [];
  const add = (dir, state) => { if (state && STATES[state]) out.push(`${state}${dir ? dir[0].toLowerCase() : ''}d`); };
  for (const m of t.matchAll(new RegExp(`\\b(?:${DISTRICT_WORD}\\s+)?District\\s+of\\s+(?:the\\s+)?(${STATE_NAMES}|Columbia)\\b`, 'gi'))) {
    add(m[1], STATE_BY_NAME.get(m[2].replace(/\s+/g, ' ').toLowerCase()));
  }
  for (const m of t.matchAll(new RegExp(`\\bUSAO\\s*-\\s*(${STATE_NAMES}|District of Columbia),\\s*${DISTRICT_WORD}?`, 'gi'))) {
    add(m[2], STATE_BY_NAME.get(m[1].replace(/\s+/g, ' ').replace(/^district of /i, '').toLowerCase()));
  }
  // "S.D.N.Y.", "N.D. Cal.", "D. Mass.", "D.N.J.", "D.D.C."
  for (const m of t.matchAll(/(?<![A-Za-z.])(?:([NSEWMC])\.\s?)?D\.\s?((?:[A-Z][a-z]*\.\s?){1,2}|(?:Alaska|Idaho|Iowa|Ohio|Utah)\b)/g)) {
    const parts = m[2].split('.').map((p) => p.trim().toLowerCase()).filter(Boolean);
    add(m[1] ? DISTRICTS[m[1].toLowerCase()] : '', STATE_ABBR[parts.join('')] || STATE_ABBR[parts[0]]);
  }
  return uniq(out);
}

const isBankruptcyCourt = (code, name = '') => /^(?:nmi|[a-z]{2})[nsewmc]?b$/.test(String(code || '').toLowerCase()) || /bankruptcy/i.test(name);
const isCriminalCase = (caseName, docketNumber = '') => /-(?:cr|mj)-/i.test(docketNumber)
  || (/^(?:united states(?: of america)?|usa|u\.s\.a?\.?|people|state|commonwealth)\b[^,]*\sv\.?\s/i.test(caseName) && !/-(?:cv|bk|ap|mc|md)-/i.test(docketNumber) && !/\$|\bfunds\b|\breal property\b/i.test(caseName));

/* ------------------------------------------------------------------ 1. CourtListener (token) */

const CL_ID = 'court-dockets';
const CL_LABEL = 'US federal court dockets and opinions (CourtListener)';
const CL_SEARCH = 'https://www.courtlistener.com/api/rest/v4/search/';
const CL_SITE = 'https://www.courtlistener.com';
const CL_CACHE_MS = 6 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
// The service allows 5 lookups a minute, 50 an hour and 125 a day. Stay under each.
const CL_PER_MINUTE = 5;
const CL_PER_HOUR = 46;
const CL_PER_DAY = 118;
const clToken = () => String(process.env.COURTLISTENER_API_TOKEN || '').trim();
let clCalls = [];
const clCache = new Map();

/** For tests. */
export function __resetCourtsForTests() {
  clCalls = [];
  clCache.clear();
  sirenCache.clear();
}

async function clAllowance(deadline) {
  const now = Date.now();
  clCalls = clCalls.filter((t) => now - t < 24 * 60 * MINUTE);
  if (clCalls.length >= CL_PER_DAY || clCalls.filter((t) => now - t < 60 * MINUTE).length >= CL_PER_HOUR) {
    throw new HttpError('Court docket lookups have used up their allowance for now', { retryable: true });
  }
  const lastMinute = clCalls.filter((t) => now - t < MINUTE);
  if (lastMinute.length < CL_PER_MINUTE) return;
  const wait = lastMinute[lastMinute.length - CL_PER_MINUTE] + MINUTE + 300 - now;
  // "Out of time" tells the loop to run this lookup again on its next step.
  if (wait > 20000 || (deadline && now + wait + 4000 > deadline)) throw new HttpError('Out of time waiting for a turn (court docket lookups are limited to five a minute)', { retryable: true });
  await sleep(wait);
}

async function clSearch(params, ctx) {
  const url = `${CL_SEARCH}?${new URLSearchParams(params)}`;
  const hit = clCache.get(url);
  if (hit && Date.now() - hit.at < CL_CACHE_MS) return hit.json;
  await clAllowance(ctx.deadline);
  clCalls.push(Date.now());
  const json = await getJson(url, { headers: { Authorization: `Token ${clToken()}` }, deadline: ctx.deadline, timeoutMs: 15000 });
  if (!json || !Array.isArray(json.results)) throw new HttpError('The court docket search returned something unexpected', { url });
  if (clCache.size > 300) clCache.delete(clCache.keys().next().value);
  clCache.set(url, { at: Date.now(), json });
  return json;
}

const quoted = (s) => `"${String(s).replace(/"/g, '')}"`;
const anyOf = (names) => (names.length > 1 ? `(${names.map(quoted).join(' OR ')})` : quoted(names[0]));

/** One docket from the search, as a finding (or the reason it was left out). */
function docketFinding(d, ctx, who, { company = '' } = {}) {
  const caseName = clean(d.caseName || d.case_name_full);
  if (!caseName || !d.docket_absolute_url) return { skip: 'incomplete' };
  const parties = uniq(arr(d.party).map(clean));
  const title = caseParties(`${caseName}`);
  const fullTitle = caseParties(d.case_name_full || '');
  const titlePeople = uniq([...title.people, ...fullTitle.people]);
  const partyHit = parties.find((p) => sameName(p, who)) || titlePeople.find((p) => sameName(p, who)) || '';
  const filings = arr(d.recap_documents).map((doc) => clean(`${plain(doc?.short_description || doc?.description)} ${plain(doc?.snippet)}`)).filter(Boolean);
  const textHit = partyHit ? '' : filings.find((t) => namesPerson(t, who)) || '';
  const companyParty = company ? [...parties, ...title.sides, ...title.asides, ...fullTitle.sides].find((p) => partyIsCompany(p, company)) || '' : '';
  if (company ? !companyParty : !(partyHit || textHit)) return { skip: 'not-named' };

  const court = clean(d.court) || federalCourtName(d.court_id);
  const docketNumber = clean(d.docketNumber);
  const filed = isoDay(d.dateFiled);
  const criminal = isCriminalCase(caseName, docketNumber);
  const bankruptcy = isBankruptcyCourt(d.court_id, court) || Boolean(d.chapter);
  const surnameSide = title.sides.some((side) => plainKey(side) === plainKey(who.surname));
  const facts = [
    parties.length ? `Parties: ${parties.slice(0, 8).join('; ')}${parties.length > 8 ? `; and ${parties.length - 8} more` : ''}.` : '',
    clean(d.suitNature) ? `Nature of suit: ${clean(d.suitNature)}.` : '',
    clean(d.cause) ? `Cause: ${clean(d.cause)}.` : '',
    d.chapter ? `Bankruptcy chapter ${clean(d.chapter)}.` : '',
    isoDay(d.dateTerminated) ? `Status: closed ${isoDay(d.dateTerminated)}.` : filed ? 'Status: no closing date on the docket.' : '',
    textHit ? `Filing: ${clip(textHit, 260)}` : '',
  ].filter(Boolean).join(' ');
  const named = Boolean(partyHit || textHit);
  const matchText = named ? [who.name, caseName, parties.join('; '), title.asides.join('; '), textHit].filter(Boolean).join(' | ') : '';
  // A personal bankruptcy is private unless the docket itself ties it to the subject.
  const personal = bankruptcy && named && titlePeople.some((p) => sameName(p, who));
  if (personal && matchSubject(ctx.subject, matchText).level !== 'confirmed') return { skip: 'personal-bankruptcy' };
  const finding = makeFinding(ctx.subject, {
    source: CL_ID,
    sourceLabel: CL_LABEL,
    category: 'litigation',
    title: `${caseName} (${[court, filed ? `filed ${filed}` : '', docketNumber ? `docket ${docketNumber}` : ''].filter(Boolean).join(', ')})`,
    quote: facts || caseName,
    url: `${CL_SITE}${d.docket_absolute_url}`,
    date: filed,
    severity: criminal && (partyHit || surnameSide || company) ? 'high' : 'medium',
    data: { caseNumber: docketNumber || null, court, ...(isoDay(d.dateTerminated) ? { closed: isoDay(d.dateTerminated) } : {}), ...(d.chapter ? { chapter: clean(d.chapter) } : {}) },
    ...(named ? { matchText } : { match: 'company', matchReasons: [`${companyParty} is a party to the case`] }),
  });
  return finding ? { finding } : { skip: 'not-named' };
}

/** One published opinion from the search, as a finding. */
function opinionFinding(o, ctx, who) {
  const caseName = clean(o.caseName || o.caseNameFull);
  if (!caseName || !o.absolute_url) return null;
  const title = caseParties(caseName);
  const titlePeople = uniq([...title.people, ...caseParties(o.caseNameFull || '').people]);
  const partyHit = titlePeople.find((p) => sameName(p, who)) || '';
  const snippet = arr(o.opinions).map((op) => plain(op?.snippet)).find((t) => namesPerson(t, who)) || '';
  if (!partyHit && !snippet) return null;
  const court = clean(o.court);
  const docketNumber = clean(o.docketNumber);
  const filed = isoDay(o.dateFiled);
  const citation = arr(o.citation).map(clean).filter(Boolean)[0] || '';
  const surnameSide = title.sides.some((side) => plainKey(side) === plainKey(who.surname));
  return makeFinding(ctx.subject, {
    source: CL_ID,
    sourceLabel: CL_LABEL,
    category: 'litigation',
    title: `${caseName} (${[court, filed ? `filed ${filed}` : '', docketNumber ? `docket ${docketNumber}` : ''].filter(Boolean).join(', ')})`,
    quote: snippet ? clip(snippet, 420) : `Court opinion in ${clean(o.caseNameFull) || caseName}${citation ? `, ${citation}` : ''}.`,
    url: `${CL_SITE}${o.absolute_url}`,
    date: filed,
    severity: isCriminalCase(caseName, docketNumber) && (partyHit || surnameSide) ? 'high' : 'medium',
    data: { caseNumber: docketNumber || null, court, kind: 'opinion', ...(citation ? { citation } : {}) },
    matchText: [who.name, caseName, clean(o.caseNameFull), title.asides.join('; '), snippet].filter(Boolean).join(' | '),
  });
}

export const courtDocketsConnector = {
  id: CL_ID,
  label: CL_LABEL,
  kinds: ['subject', 'company'],
  prior: 0.7,
  // As long as a step of the check, so a lookup that has to wait its turn is run again on the next step instead of failing.
  timeoutMs: 45000,
  enabled: () => Boolean(clToken()),
  unavailableReason: 'US federal court dockets are not enabled on this deployment.',
  plan(thread, subject) {
    if (thread.kind === 'company') {
      // The daily allowance is small: dockets are pulled for the company given and those found first, not for every later lead.
      const near = (thread.depth ?? 1) <= 1 || (subject?.company && sameCompany(thread.value, subject.company));
      return near ? [{ template: 'dockets.company', prior: 0.5, why: 'cases the company is a party to' }] : [];
    }
    return [
      { template: 'dockets.party', prior: 0.75, why: 'federal cases that list the person as a party' },
      { template: 'opinions.name', prior: 0.5, why: 'published court opinions that name the person' },
      ...(subject?.company ? [{ template: 'dockets.name-company', params: { company: subject.company }, prior: 0.8, why: 'federal cases that name the person and the company' }] : []),
    ];
  },
  async run(task, ctx) {
    const who = person(ctx.subject);
    const template = task.template || (task.kind === 'company' ? 'dockets.company' : 'dockets.party');
    const notes = [];
    if (template === 'opinions.name') {
      const json = await clSearch({ type: 'o', q: anyOf(who.queryNames), order_by: 'score desc', highlight: 'on' }, ctx);
      return { findings: json.results.map((o) => opinionFinding(o, ctx, who)).filter(Boolean).slice(0, 10), threads: [], notes };
    }
    const company = template === 'dockets.company' ? clean(task.value) : '';
    const paired = template === 'dockets.name-company' ? clean(task.params?.company || ctx.subject.company) : '';
    const q = company ? `party:${quoted(company)}` : paired ? `${anyOf(who.queryNames)} ${quoted(paired)}` : `party:${anyOf(who.queryNames)}`;
    const json = await clSearch({ type: 'r', q, order_by: 'score desc', highlight: 'on' }, ctx);
    const read = json.results.map((d) => docketFinding(d, ctx, who, { company }));
    const findings = read.map((r) => r.finding).filter(Boolean).slice(0, company ? 8 : 12);
    const count = Number(json.count) || json.results.length;
    if (count > json.results.length) notes.push(`CourtListener lists about ${count} federal dockets for ${company || who.name}; the ${json.results.length} closest matches were read.`);
    if (read.some((r) => r.skip === 'personal-bankruptcy')) notes.push(`Personal bankruptcy cases under the name ${who.name} are reported only when the docket also names a company tied to them; none shown from this lookup did.`);
    return { findings, threads: [], notes };
  },
};

/* ------------------------------------------------------------------ 2. Internet Archive copy of federal dockets (no token) */

const IA_ID = 'court-records-open';
const IA_LABEL = 'US federal court case titles (Internet Archive copy of court dockets)';
const IA_SEARCH = 'https://archive.org/advancedsearch.php';

/** Dockets whose title carries every term; `anyOf` titles are alternatives, `court` a court code. */
async function iaTitles(terms, ctx, rows = 100, { anyOf: alternatives = [], court = '' } = {}) {
  const q = ['collection:usfederalcourts', ...(court ? [`court:${court.replace(/[^a-z0-9]/g, '')}`] : []), ...terms.map((t) => `title:(${quoted(t)})`),
    ...(alternatives.length ? [`(${alternatives.map((t) => `title:(${quoted(t)})`).join(' OR ')})`] : [])].join(' AND ');
  const fields = ['identifier', 'title', 'court', 'source_url', 'publicdate'].map((f) => `fl[]=${f}`).join('&');
  const json = await getJson(`${IA_SEARCH}?q=${encodeURIComponent(q)}&${fields}&rows=${rows}&output=json`, { deadline: ctx.deadline });
  if (!json?.response || !Array.isArray(json.response.docs)) throw new HttpError('The Internet Archive court search returned something unexpected');
  return { total: Number(json.response.numFound) || 0, docs: json.response.docs.filter((d) => d && d.identifier && d.title) };
}

/** The docket's page: CourtListener's when the archive names it, else the archive's own item. */
function iaUrl(doc) {
  const m = String(doc.source_url || '').match(/^https:\/\/www\.courtlistener\.com\/docket\/(\d+)\/(?:\d+\/)?([a-z0-9-]+)\/?$/i);
  return m ? `${CL_SITE}/docket/${m[1]}/${m[2]}/` : `https://archive.org/details/${encodeURIComponent(doc.identifier)}`;
}

/**
 * How the subject is tied to a company: 'given' when the user gave it, a
 * finding id when a confirmed record tied it, '' otherwise. A company that
 * was only inferred (no company given) or that they merely invested in or
 * advised does not count.
 */
function foundedCompany(subject, company, tie) {
  if (tie === 'affiliate') return '';
  const anchor = [...(subject?.anchors?.companies?.values() || [])].find((a) => a.origin && a.origin !== 'inferred' && a.origin !== 'found' && sameCompany(a.value, company));
  return anchor ? anchor.origin : '';
}

function iaFinding(doc, ctx, who, { company = '', tie = null } = {}) {
  const caseName = clean(arr(doc.title)[0]);
  const code = clean(arr(doc.court)[0]) || (String(doc.identifier).match(/^gov\.uscourts\.([a-z0-9]+)\./) || [])[1] || '';
  const court = federalCourtName(code);
  const title = caseParties(caseName);
  const partyHit = title.people.find((p) => sameName(p, who)) || '';
  const companyParty = company ? [...title.sides, ...title.asides].find((p) => partyIsCompany(p, company)) || '' : '';
  if (company ? !companyParty : !partyHit) return { skip: 'not-named' };
  const matchText = partyHit ? `${who.name} | ${caseName}` : '';
  if (partyHit && isBankruptcyCourt(code) && matchSubject(ctx.subject, matchText).level !== 'confirmed') return { skip: 'personal-bankruptcy' };
  const surnameSide = title.sides.find((side) => plainKey(side) === plainKey(who.surname)) || '';
  // The company the person founded or runs on one side and exactly their surname on the other: likely them, never confirmed.
  const origin = !partyHit && surnameSide && title.sides.length === 2 && title.sides.includes(companyParty) && companyParty !== surnameSide
    ? foundedCompany(ctx.subject, company, tie) : '';
  const finding = makeFinding(ctx.subject, {
    source: IA_ID,
    sourceLabel: IA_LABEL,
    category: 'litigation',
    title: `${caseName} (${court}, federal court docket)`,
    quote: caseName,
    url: iaUrl(doc),
    date: null, // the archive records when the copy was made, not when the case was filed
    severity: isCriminalCase(caseName) && (partyHit || company) ? 'high' : 'medium',
    data: { caseNumber: null, court, archiveId: String(doc.identifier) },
    ...(partyHit ? { matchText } : origin ? {
      match: 'likely',
      matchReasons: [`the case is between ${companyParty} and ${surnameSide}; ${who.name} founded or runs ${company} (${origin === 'given' ? 'the company given' : 'tied to them on a confirmed record'})`],
    } : {
      match: 'company',
      matchReasons: [`${companyParty} is a party to the case`, ...(surnameSide ? [`the other side is named ${surnameSide}; the case title gives no first name`] : [])],
    }),
  });
  return finding ? { finding, surnameSide: Boolean(surnameSide) } : { skip: 'not-named' };
}

const CHARGE_SOURCES = new Set(['doj-press-releases', 'sec-filings']);
const YEAR_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * Where and when the subject was charged, from confirmed Justice Department
 * or SEC records already in this check: [{ court, dates, record }], at most two courts.
 */
function chargeDistricts(ctx) {
  let list = [];
  try { list = typeof ctx.findings === 'function' ? ctx.findings() : ctx.findings; } catch { list = []; }
  const byCourt = new Map();
  for (const f of Array.isArray(list) ? list : []) {
    if (!f || f.match !== 'confirmed' || !CHARGE_SOURCES.has(f.source) || !isoDay(f.date)) continue;
    for (const court of districtCodes(`${f.title} ${f.quote || ''} ${f.data?.office || ''}`)) {
      const entry = byCourt.get(court) || { court, dates: [], record: f.title };
      entry.dates.push(Date.parse(isoDay(f.date)));
      byCourt.set(court, entry);
    }
  }
  return [...byCourt.values()].slice(0, 2);
}

/**
 * Criminal dockets are titled by surname only ("United States v. Milton"), so
 * the full-name search cannot find them. A docket in the district that charged
 * the subject, titled with exactly their surname and first copied to the
 * archive within a year of the charges, is reported as possible: the title
 * alone cannot tell them from someone else with the same surname.
 */
async function chargedDockets(ctx, who, seen) {
  const findings = [];
  if (!who.surname) return findings;
  for (const { court, dates } of chargeDistricts(ctx)) {
    const { docs } = await iaTitles([], ctx, 50, { court, anyOf: [`United States v. ${who.surname}`, `USA v. ${who.surname}`] });
    for (const doc of docs) {
      if (seen.has(doc.identifier)) continue;
      const code = clean(arr(doc.court)[0]) || (String(doc.identifier).match(/^gov\.uscourts\.([a-z0-9]+)\./) || [])[1] || '';
      const caseName = clean(arr(doc.title)[0]);
      const { sides } = caseParties(caseName);
      const copied = Date.parse(String(arr(doc.publicdate)[0] || ''));
      if (code !== court || sides.length !== 2 || !isCriminalCase(caseName)) continue;
      if (plainKey(sides[1]) !== plainKey(who.surname) || !/^(?:united states(?: of america)?|usa)$/i.test(sides[0])) continue;
      if (Number.isNaN(copied) || !dates.some((d) => Math.abs(copied - d) <= YEAR_MS)) continue;
      seen.add(doc.identifier);
      const courtName = federalCourtName(code);
      const finding = makeFinding(ctx.subject, {
        source: IA_ID,
        sourceLabel: IA_LABEL,
        category: 'litigation',
        title: `${caseName} (${courtName}, federal court docket)`,
        quote: caseName,
        url: iaUrl(doc),
        date: null, // the archive records when the copy was made, not when the case was filed
        severity: 'high',
        data: { caseNumber: null, court: courtName, archiveId: String(doc.identifier) },
        match: 'possible',
        matchReasons: [`criminal case in the district and year of the charges against ${who.name}; the case title gives only the surname`],
      });
      if (finding) findings.push(finding);
    }
  }
  return findings.slice(0, 3);
}

export const courtRecordsOpenConnector = {
  id: IA_ID,
  label: IA_LABEL,
  kinds: ['subject', 'company'],
  prior: 0.35,
  timeoutMs: 15000,
  // The fallback for deployments without the fuller docket search.
  enabled: () => !clToken(),
  // Off by design when the fuller docket search runs in its place: not a source that failed to answer, so reports leave it out.
  replacedBy: CL_ID,
  unavailableReason: 'Not needed here: the fuller US federal court docket search is on.',
  async run(task, ctx) {
    const who = person(ctx.subject);
    const notes = [];
    if (task.kind === 'company') {
      const company = clean(task.value);
      const core = companyCore(company);
      let { total, docs } = await iaTitles([core], ctx);
      // A long list is mostly other parties with the word in their name: ask again for the titles that also carry the surname.
      if (total > docs.length && who.surname) docs = [...(await iaTitles([core, who.surname], ctx, 50)).docs, ...docs];
      const seen = new Set();
      const read = docs.filter((d) => !seen.has(d.identifier) && seen.add(d.identifier)).map((d) => iaFinding(d, ctx, who, { company, tie: task.tie || null })).filter((r) => r.finding);
      read.sort((a, b) => Number(b.surnameSide) - Number(a.surnameSide));
      if (read.length > 8) notes.push(`The archive holds ${read.length} federal dockets with ${company} in the case title; 8 are listed.`);
      return { findings: read.slice(0, 8).map((r) => r.finding), threads: [], notes };
    }
    const { docs } = await iaTitles([who.name], ctx, 50);
    const read = docs.map((d) => iaFinding(d, ctx, who));
    if (read.some((r) => r.skip === 'personal-bankruptcy')) notes.push(`Personal bankruptcy cases under the name ${who.name} are reported only when the record also names a company tied to them; none found here did.`);
    notes.push('Only case titles were searched (a public copy of federal dockets); most cases are titled by surname, so a case can exist without appearing here.');
    const named = read.map((r) => r.finding).filter(Boolean).slice(0, 8);
    const charged = await chargedDockets(ctx, who, new Set(docs.map((d) => d.identifier))).catch(() => {
      notes.push(`The search for criminal dockets in the district that charged ${who.name} did not answer.`);
      return [];
    });
    return { findings: [...named, ...charged], threads: [], notes };
  },
};

/* ------------------------------------------------------------------ 3. Department of Justice press releases */

const DOJ_ID = 'doj-press-releases';
const DOJ_LABEL = 'US Department of Justice press releases';
const DOJ_URL = 'https://www.justice.gov/api/v1/press_releases.json';
const DOJ_CRIMINAL = /\b(indict(?:ed|ment)s?|charged|charges|arrest(?:ed)?|extradit\w*|plead(?:ed|s)? guilty|pled guilty|guilty plea|found guilty|guilty verdict|convict(?:ed|ion)s?|sentenc(?:ed|ing|e))\b/i;
const ABBREVIATION = /\b(U\.S|v|vs|Inc|Corp|Ltd|Co|Mr|Mrs|Ms|Dr|Jr|Sr|St|No|Hon|Esq|a\.k\.a)\.(?=\s)/g;
const sentencesOf = (text) => clean(text).replace(ABBREVIATION, '$1\u0001').split(/(?<=[.!?])\s+(?=[A-Z"“])/).map((s) => s.replace(/\u0001/g, '.').trim()).filter(Boolean);
/** DOJ gives a defendant's age and home town after the name; neither belongs in a report. */
const dropAgeAndTown = (s) => String(s)
  .replace(/,\s*(?:aged?\s+)?\d{2},\s*(?:(?:formerly|most recently|a resident|a citizen)\s+)?(?:of|from)\s+[A-Z][A-Za-z.'’ -]+(?:,\s*[A-Z][A-Za-z.'’ ]+)?,/g, ',')
  .replace(/,\s*(?:aged?\s+)?\d{2},(?=\s)/g, ',')
  .replace(/,\s*,/g, ',').replace(/\s+,/g, ',');

async function dojReleases(titleFilter, ctx) {
  const url = `${DOJ_URL}?parameters%5Btitle%5D=${encodeURIComponent(titleFilter)}&sort=date&direction=DESC&pagesize=25&fields=title,date,url,number,component,topic,teaser,body`;
  const json = await getJson(url, { deadline: ctx.deadline, timeoutMs: 15000 });
  if (!json || !Array.isArray(json.results)) throw new HttpError('The Justice Department release search returned something unexpected', { url });
  const count = Number(json.metadata?.resultset?.count) || json.results.length;
  // The service ignores a filter it does not understand and returns every release: never read that as a match.
  if (count > 3000) return { count, releases: [], unfiltered: true };
  return { count, releases: json.results.filter((r) => r && r.title && /^https?:\/\//.test(String(r.url || ''))), unfiltered: false };
}

/** The parts of a release the checks read. */
function readRelease(r) {
  const title = plain(r.title);
  const teaser = plain(r.teaser);
  const body = plain(r.body);
  const seconds = Number(r.date);
  return {
    title, teaser, body,
    url: String(r.url),
    date: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString().slice(0, 10) : isoDay(r.date),
    data: {
      ...(clean(r.number) ? { releaseNumber: clean(r.number) } : {}),
      ...(arr(r.component).length ? { office: arr(r.component).map((c) => clean(c?.name)).filter(Boolean).join('; ') } : {}),
      ...(arr(r.topic).length ? { topics: arr(r.topic).map((t) => clean(t?.name)).filter(Boolean) } : {}),
    },
  };
}

/**
 * How a release names a person: the passage to quote and the sentences
 * around the name (where a company usually sits). null when it does not
 * name them, or names only someone with a longer name.
 */
function releaseNaming(rel, who) {
  const prose = `${rel.teaser} ${rel.body}`;
  const inProse = findMentions(prose, who);
  const inTitle = findMentions(rel.title, who);
  if (!inProse.length && !inTitle.length) return null;
  if (inProse.length && inProse.every((m) => m.extended)) return null;
  const naming = sentencesOf(prose).filter((s) => namesPerson(s, who));
  const quote = namesPerson(rel.teaser, who) ? rel.teaser : naming.slice(0, 2).join(' ') || rel.teaser || sentencesOf(rel.body)[0] || rel.title;
  return { quote: clip(dropAgeAndTown(quote), 600), context: clip(uniq(naming).slice(0, 4).join(' '), 1400) };
}

/** Threads read from a release, without links, handles or headline fragments ("Of Former Nikola Motors"). */
const usableThreads = (threads) => threads.filter((t) => t && t.kind !== 'url' && t.kind !== 'handle'
  && !(t.kind === 'company' && /^(?:of|the|a|an|and|for|by|to|in|at|with|former|ex)\s/i.test(t.value)));

const dojSeverity = (text) => (DOJ_CRIMINAL.test(text) ? 'high' : severityFromText(text));

export const dojConnector = {
  id: DOJ_ID,
  label: DOJ_LABEL,
  kinds: ['subject', 'company', 'associate'],
  prior: 0.65,
  timeoutMs: 20000,
  plan(thread, subject) {
    if (thread.kind === 'company') return [{ template: 'title.company', prior: 0.5, why: 'releases with the company in the headline' }];
    if (thread.kind === 'associate') return [{ template: 'title.associate', prior: 0.35, why: 'releases that name this person together with the subject or their company' }];
    return [
      { template: 'title.name', prior: 0.7, why: 'releases with the person in the headline' },
      ...(subject?.company ? [{ template: 'title.surname-company', params: { company: subject.company }, prior: 0.6, why: 'releases with the surname and the company in the headline' }] : []),
    ];
  },
  async run(task, ctx) {
    const who = person(ctx.subject);
    const template = task.template || (task.kind === 'company' ? 'title.company' : task.kind === 'associate' ? 'title.associate' : 'title.name');
    const base = { source: DOJ_ID, sourceLabel: DOJ_LABEL, category: 'regulatory' };
    const findings = [];
    const threads = [];
    const notes = [];
    const seen = new Set();
    const fresh = (rel) => !seen.has(rel.url) && Boolean(seen.add(rel.url));
    const search = async (filter) => {
      const { releases, unfiltered } = await dojReleases(filter, ctx);
      if (unfiltered) notes.push(`The Justice Department search could not be narrowed to "${filter}", so nothing was read from it.`);
      return releases.map(readRelease).filter(fresh);
    };
    /** A release that names the subject: graded on the headline, the quoted passage and the sentences that name them. */
    const aboutSubject = (rel, naming, extra = {}) => makeFinding(ctx.subject, {
      ...base,
      title: rel.title,
      quote: naming.quote,
      url: rel.url,
      date: rel.date,
      severity: dojSeverity(`${rel.title} ${naming.quote}`),
      data: rel.data,
      matchText: `${who.name} | ${rel.title} | ${naming.quote} | ${naming.context}`,
      ...extra,
    });

    if (template === 'title.associate') {
      const other = person(task.value);
      if (other.forms.length === 0) return { findings, threads, notes };
      for (const rel of await search(other.name)) {
        const about = releaseNaming(rel, other);
        if (!about) continue;
        const naming = releaseNaming(rel, who);
        // Only releases that name the associate together with the subject: a company mention is not the subject.
        if (!naming) continue;
        const title = `Associate ${other.name}: ${rel.title}`;
        findings.push(aboutSubject(rel, naming, { title, quote: clip(uniq([about.quote, naming.quote]).join(' '), 650) }));
      }
      return { findings: findings.filter(Boolean).slice(0, 6), threads, notes };
    }

    if (template === 'title.company') {
      const company = clean(task.value);
      for (const rel of await search(companyCore(company))) {
        if (!headlineNamesCompany(rel.title, company)) continue;
        const naming = releaseNaming(rel, who);
        const finding = naming ? aboutSubject(rel, naming) : makeFinding(ctx.subject, {
          ...base, title: rel.title, quote: clip(dropAgeAndTown(rel.teaser || sentencesOf(rel.body)[0] || rel.title), 600), url: rel.url, date: rel.date,
          severity: dojSeverity(`${rel.title} ${rel.teaser}`), data: rel.data, match: 'company', matchReasons: [`${company} is named in the headline`],
        });
        if (!finding) continue;
        findings.push(finding);
        if (naming) threads.push(...threadsFromResult(ctx.subject, { title: rel.title, snippet: naming.quote, url: rel.url }, { trusted: finding.match !== 'possible' }));
      }
      return { findings: findings.slice(0, 10), threads: usableThreads(threads), notes };
    }

    const filters = template === 'title.surname-company'
      ? [`${who.surname} ${companyCore(task.params?.company || ctx.subject.company)}`]
      // The filter matches parts of words, so "Sam" finds "Samuel"; "Mike" needs "Michael" asked separately.
      : who.queryNames.filter((n, i) => i === 0 || !n.toLowerCase().startsWith(who.given.toLowerCase())).slice(0, 2);
    for (const filter of filters) {
      for (const rel of await search(filter)) {
        const naming = releaseNaming(rel, who);
        if (!naming) continue;
        const finding = aboutSubject(rel, naming);
        if (!finding) continue;
        findings.push(finding);
        threads.push(...threadsFromResult(ctx.subject, { title: rel.title, snippet: naming.quote, url: rel.url }, { trusted: finding.match !== 'possible' }));
      }
    }
    return { findings: findings.slice(0, 15), threads: usableThreads(threads), notes };
  },
};


/* ------------------------------------------------------------------ 4. FINRA BrokerCheck and SEC adviser records */

const BC_ID = 'finra-brokercheck';
const BC_LABEL = 'FINRA BrokerCheck and SEC adviser records';
const BC_SEARCH = 'https://api.brokercheck.finra.org/search/individual';
const IAPD_SEARCH = 'https://api.adviserinfo.sec.gov/search/individual';
const bcSearchUrl = (base, name) => `${base}?query=${encodeURIComponent(name)}&hl=true&nrows=12&start=0&r=25&sort=score+desc&wt=json`;
const titleCase = (s) => clean(s).toLowerCase().replace(/(^|[\s\-'’(&/])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(Llc|Lp|Llp|Inc|Na|Usa)\b/g, (w) => w.toUpperCase());

async function bcHits(base, name, ctx) {
  const json = await getJson(bcSearchUrl(base, name), { deadline: ctx.deadline, timeoutMs: 12000 });
  if (!json || !json.hits || !Array.isArray(json.hits.hits)) throw new HttpError('The BrokerCheck search returned something unexpected', { url: base });
  return json.hits.hits.map((h) => h && h._source).filter((h) => h && h.ind_source_id);
}

/** The detail record (a JSON string inside JSON), or null when the service has none. */
async function bcDetail(crd, ctx) {
  const tryOne = async (base, key) => {
    const json = await getJson(`${base}/${encodeURIComponent(crd)}`, { deadline: ctx.deadline, timeoutMs: 12000 });
    const src = json?.hits?.hits?.[0]?._source;
    if (!src || !src[key]) return null;
    try { return JSON.parse(src[key]); } catch { throw new HttpError('The BrokerCheck record could not be read', { url: base }); }
  };
  return (await tryOne(BC_SEARCH, 'content')) || (await tryOne(IAPD_SEARCH, 'iacontent'));
}

const recordName = (h) => clean([h.ind_firstname, h.ind_middlename, h.ind_lastname].filter(Boolean).join(' '));

/** One BrokerCheck person as a finding plus the firms on the record. */
function brokerFinding(hit, detail, ctx, who) {
  const crd = String(hit.ind_source_id);
  const info = detail?.basicInformation || {};
  const name = titleCase(clean([info.firstName || hit.ind_firstname, info.middleName || hit.ind_middlename, info.lastName || hit.ind_lastname].filter(Boolean).join(' ')));
  const jobs = [
    ...arr(detail?.currentEmployments).map((e) => ({ ...e, current: true })),
    ...arr(detail?.currentIAEmployments).map((e) => ({ ...e, current: true, ia: true })),
    ...arr(detail?.previousEmployments),
    ...arr(detail?.previousIAEmployments).map((e) => ({ ...e, ia: true })),
    ...arr(hit.ind_current_employments).map((e) => ({ firmName: e.firm_name, current: true })),
  ].filter((e) => clean(e.firmName));
  const firms = [];
  const firmLines = [];
  for (const e of jobs) {
    const firm = clean(e.firmName);
    if (firms.some((f) => plainKey(f) === plainKey(firm))) continue;
    firms.push(firm);
    const from = usDay(e.registrationBeginDate);
    const to = usDay(e.registrationEndDate);
    firmLines.push(`${titleCase(firm)}${from || to ? ` (${from || '?'} to ${e.current ? 'present' : to || '?'})` : e.current ? ' (current)' : ''}`);
  }
  const disclosures = arr(detail?.disclosures);
  const count = detail ? disclosures.length : (hit.ind_bc_disclosure_fl === 'Y' || hit.ind_ia_disclosure_fl === 'Y' ? 1 : 0);
  const sanctions = arr(info.sanctions?.sanctionDetails);
  const bar = info.sanctions?.permanentBar === 'Y' || sanctions.some((x) => /bar/i.test(String(x?.category || '')))
    || disclosures.some((d) => /\bbar(?:red)?\b/i.test(JSON.stringify(d?.disclosureDetail?.SanctionDetails || '')));
  const byType = {};
  for (const d of disclosures) byType[clean(d.disclosureType) || 'Other'] = (byType[clean(d.disclosureType) || 'Other'] || 0) + 1;
  const latest = disclosures.map((d) => usDay(d.eventDate)).filter(Boolean).sort().pop() || null;
  const regulatory = disclosures.filter((d) => d.disclosureType !== 'Financial' && d.disclosureType !== 'Customer Dispute');
  const initiators = uniq(regulatory.map((d) => clean(d.disclosureDetail?.['Initiated By'])).filter(Boolean)).slice(0, 3);
  const scope = [
    hit.ind_bc_scope && hit.ind_bc_scope !== 'NotInScope' ? `broker registration ${String(hit.ind_bc_scope).toLowerCase()}` : '',
    hit.ind_ia_scope && hit.ind_ia_scope !== 'NotInScope' ? `adviser registration ${String(hit.ind_ia_scope).toLowerCase()}` : '',
  ].filter(Boolean);
  const facts = [
    `${name}, CRD ${crd}${scope.length ? `: ${scope.join('; ')}` : ''}.`,
    firmLines.length ? `Firms: ${firmLines.slice(0, 6).join('; ')}${firmLines.length > 6 ? `; and ${firmLines.length - 6} more` : ''}.` : '',
    count ? `Disclosures: ${detail ? Object.entries(byType).map(([t, n]) => `${n} ${t.toLowerCase()}`).join(', ') : 'yes'}${latest ? `, latest ${latest}` : ''}${initiators.length ? `; initiated by ${initiators.join('; ')}` : ''}.` : 'No disclosures.',
    bar ? `Barred${info.sanctions?.permanentBar === 'Y' ? ' permanently' : ''}${sanctions.length ? ` (${uniq(sanctions.map((x) => clean(x.regulator))).join(', ')})` : ''}.` : '',
    disclosures.some((d) => d.disclosureType === 'Customer Dispute') ? 'Customer disputes are allegations unless the record says otherwise.' : '',
  ].filter(Boolean).join(' ');
  // Firms and the regulators' own allegation text tie the record to companies; personal financial disclosures never do.
  const allegations = regulatory.map((d) => clip(clean(d.disclosureDetail?.Allegations), 600)).filter(Boolean).join(' | ');
  const finding = makeFinding(ctx.subject, {
    source: BC_ID,
    sourceLabel: BC_LABEL,
    category: 'regulatory',
    title: `${name} (CRD ${crd}): ${bar ? 'barred' : count ? plural(count, 'disclosure') : 'no disclosures'} on the BrokerCheck record`,
    quote: facts,
    url: hit.ind_bc_scope === 'NotInScope' && hit.ind_ia_scope && hit.ind_ia_scope !== 'NotInScope'
      ? `https://adviserinfo.sec.gov/individual/summary/${crd}`
      : `https://brokercheck.finra.org/individual/summary/${crd}`,
    date: latest || jobs.map((e) => usDay(e.registrationEndDate) || usDay(e.registrationBeginDate)).filter(Boolean).sort().pop() || null,
    severity: bar ? 'high' : count > 0 ? 'medium' : 'info',
    data: { crd, firms: firms.map(titleCase), disclosures: count, ...(detail ? { disclosureTypes: byType } : {}), bar },
    matchText: [who.name, name, firms.join('; '), allegations].filter(Boolean).join(' | '),
  });
  return { finding, firms };
}

export const brokerCheckConnector = {
  id: BC_ID,
  label: BC_LABEL,
  kinds: ['subject'],
  prior: 0.4,
  timeoutMs: 20000,
  async run(task, ctx) {
    const who = person(ctx.subject);
    // Registrations are filed under the legal name; the search tolerates "Sam" for "Samuel" but not every short form.
    const query = who.queryNames[who.queryNames.length - 1];
    const [bc, iapd] = await Promise.all([bcHits(BC_SEARCH, query, ctx), bcHits(IAPD_SEARCH, query, ctx).catch(() => [])]);
    const byCrd = new Map();
    for (const h of [...bc, ...iapd]) {
      const names = [recordName(h), ...arr(h.ind_other_names).map(clean)];
      if (!byCrd.has(h.ind_source_id) && names.some((n) => sameName(n, who))) byCrd.set(h.ind_source_id, h);
    }
    const hits = [...byCrd.values()];
    const notes = [];
    if (!hits.length) return { findings: [], threads: [], notes: ['No broker or investment adviser registration under this name (most founders were never registered).'] };
    if (hits.length > 2) notes.push(`${hits.length} registered people share the name ${who.name}; the first 2 were read.`);
    const findings = [];
    const threads = [];
    for (const hit of hits.slice(0, 2)) {
      const detail = await bcDetail(hit.ind_source_id, ctx);
      const { finding, firms } = brokerFinding(hit, detail, ctx, who);
      if (!finding) continue;
      findings.push(finding);
      if (finding.match === 'confirmed' || finding.match === 'likely') {
        for (const firm of firms) threads.push(makeThread('company', titleCase(firm), `firm on ${who.name}'s BrokerCheck record`, { trusted: true }));
      }
    }
    return { findings, threads: threads.filter(Boolean), notes };
  },
};

/* ------------------------------------------------------------------ 5. The Gazette (UK) */

const GZ_ID = 'uk-gazette';
const GZ_LABEL = 'The Gazette (UK official public record)';
const GZ_SEARCH = 'https://www.thegazette.co.uk/insolvency/notice/data.json';

async function gazetteNotices(phrases, ctx) {
  const text = phrases.map(quoted).join(' ');
  const url = `${GZ_SEARCH}?text=${encodeURIComponent(text)}&results-page-size=20&results-page=1&sort-by=latest-date`;
  const json = await getJson(url, { deadline: ctx.deadline, timeoutMs: 25000 });
  if (!json || typeof json !== 'object' || !('f:total' in json || 'entry' in json || 'title' in json)) throw new HttpError('The Gazette search returned something unexpected', { url });
  return { total: Number(json['f:total']) || 0, entries: arr(json.entry).filter((e) => e && e.id) };
}

/**
 * The parts of a notice that may be shown. Only corporate insolvency notices
 * (codes 24xx) are read at all: personal insolvency notices print home
 * addresses and dates of birth, so their text is never touched.
 */
function readNotice(e) {
  const code = clean(e['f:notice-code']);
  if (!/^24\d\d$/.test(code)) return null;
  const id = (String(e.id).match(/\/notice\/(\d+)/) || [])[1];
  if (!id) return null;
  let snippet = plain(e.content).replace(/^﻿/, '');
  snippet = snippet.split(/\b(?:Registered [Oo]ffice|Principal [Tt]rading [Aa]ddress|Trading [Aa]ddress|Office [Aa]ddress|Address|Date of [Bb]irth|Born|Residential)\b/)[0];
  snippet = clean(snippet.replace(/[\s,;:(]+$/, '').replace(/\(\s*$/, ''));
  return { id, code, title: clean(e.title), type: clean(e.category?.['@term']) || 'Insolvency notice', date: isoDay(e.published), snippet, url: `https://www.thegazette.co.uk/notice/${id}` };
}

const gazetteSeverity = (n) => (/disqualif/i.test(`${n.type} ${n.snippet}`) ? 'high' : 'medium');

export const ukGazetteConnector = {
  id: GZ_ID,
  label: GZ_LABEL,
  kinds: ['subject', 'company'],
  prior: 0.3,
  timeoutMs: 30000,
  async run(task, ctx) {
    const who = person(ctx.subject);
    const findings = [];
    const notes = [];
    if (task.kind === 'company') {
      const company = clean(task.value);
      const core = companyCore(company);
      // The whole trading name, not its first word: "T/A Flow Creative" is not Flow. A name ends at a comma,
      // a bracket, a legal form, the next field of the notice or the end of the shown text.
      const named = new RegExp(`(?:Trading Names?|Previous Names? of Company)s?:[^:]{0,120}?(?<![A-Za-z0-9])(?:T\\/A\\s+)?${escapeRe(core)}\\s*(?=$|[,;)…]|\\.{3}|\\b(?:Ltd|Limited|LLP|PLC)\\b|\\(\\s*Company Number|\\b(?:Trading Names?|Previous Names? of Company|Nature of Business|Company Number|Registered|Principal)\\b)`, 'i');
      const { entries } = await gazetteNotices([company], ctx);
      for (const n of entries.map(readNotice).filter(Boolean)) {
        if (!sameCompany(n.title, company) && !named.test(n.snippet)) continue;
        const finding = makeFinding(ctx.subject, {
          source: GZ_ID, sourceLabel: GZ_LABEL, category: 'corporate',
          title: `${n.type}: ${n.title} (The Gazette notice ${n.id})`,
          quote: n.snippet || `${n.type}: ${n.title}`,
          url: n.url, date: n.date, severity: gazetteSeverity(n),
          data: { noticeCode: n.code, noticeType: n.type },
          match: 'company', matchReasons: [`notice about ${n.title}`],
        });
        if (finding) findings.push(finding);
      }
      return { findings: findings.slice(0, 10), threads: [], notes };
    }
    // A person: only corporate notices that name them together with a company already tied to them.
    const companies = knownCompanies(ctx.subject).slice(0, 2);
    if (!companies.length) return { findings, threads: [], notes: ['UK Gazette notices are searched for a person only together with a known company (personal insolvency notices are not read).'] };
    const seen = new Set();
    for (const company of companies) {
      const { entries } = await gazetteNotices([who.name, companyCore(company)], ctx);
      for (const n of entries.map(readNotice).filter(Boolean)) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        // The Gazette matched both phrases in the full notice; the shown snippet may be cut before the name.
        const finding = makeFinding(ctx.subject, {
          source: GZ_ID, sourceLabel: GZ_LABEL, category: 'corporate',
          title: `${n.type}: ${n.title} (The Gazette notice ${n.id}, names ${who.name})`,
          quote: n.snippet || `${n.type}: ${n.title}`,
          url: n.url, date: n.date, severity: gazetteSeverity(n),
          data: { noticeCode: n.code, noticeType: n.type, company },
          matchText: `${who.name} | ${company} | ${n.title}`,
        });
        if (finding) findings.push(finding);
      }
    }
    return { findings: findings.slice(0, 10), threads: [], notes };
  },
};

/* ------------------------------------------------------------------ 6a. UK court judgments (Find Case Law) */

const TNA_ID = 'uk-case-law';
const TNA_LABEL = 'UK court judgments (National Archives Find Case Law)';
const TNA_FEED = 'https://caselaw.nationalarchives.gov.uk/atom.xml';
// Family, immigration and employment matters of a namesake are private lives, not diligence.
const PRIVATE_COURTS = /family|immigration|asylum|employment|court of protection|mental health|special educational|social entitlement|care standards/i;

async function caseLawFeed(phrases, party, ctx) {
  const url = `${TNA_FEED}?query=${encodeURIComponent(phrases.map(quoted).join(' '))}&party=${encodeURIComponent(party)}&order=-date&per_page=20`;
  const xml = await getText(url, { deadline: ctx.deadline, timeoutMs: 15000, accept: 'application/atom+xml,application/xml' });
  if (!/<feed[\s>]/.test(xml)) throw new HttpError('Find Case Law returned something other than a feed', { url });
  const $ = cheerio.load(xml, { xmlMode: true });
  return $('entry').toArray().map((el) => {
    const e = $(el);
    return {
      title: clean(e.children('title').text()),
      url: e.children('link[rel="alternate"]').filter((i, l) => !$(l).attr('type')).first().attr('href') || '',
      date: isoDay(e.children('published').text()),
      court: clean(e.children('author').children('name').text()),
      citation: clean(e.find('tna\\:identifier[type="ukncn"]').first().text()),
    };
  }).filter((x) => x.title && /^https:\/\/caselaw\.nationalarchives\.gov\.uk\//.test(x.url));
}

const isUkCriminal = (title) => /^(?:R|Regina|Rex|The King|The Queen|HM Advocate)\s+v\.?\s/i.test(title) || /\bv\.?\s+(?:R|Regina|Rex)\s*$/i.test(title);

function judgmentFinding(j, ctx, extra) {
  return makeFinding(ctx.subject, {
    source: TNA_ID, sourceLabel: TNA_LABEL, category: 'litigation',
    title: `${j.title} (${[j.court, j.citation, j.date ? `judgment ${j.date}` : ''].filter(Boolean).join(', ')})`,
    quote: `${j.title}${j.citation ? `, ${j.citation}` : ''}${j.court ? `, ${j.court}` : ''}`,
    url: j.url, date: j.date,
    data: { caseNumber: j.citation || null, court: j.court || null },
    ...extra,
  });
}

export const ukCaseLawConnector = {
  id: TNA_ID,
  label: TNA_LABEL,
  kinds: ['subject', 'company'],
  prior: 0.35,
  timeoutMs: 20000,
  async run(task, ctx) {
    const who = person(ctx.subject);
    const findings = [];
    const notes = [];
    if (task.kind === 'company') {
      const company = clean(task.value);
      const core = companyCore(company);
      for (const j of await caseLawFeed([company], core, ctx)) {
        const parties = caseParties(j.title);
        const party = [...parties.people, ...parties.asides].find((p) => partyIsCompany(p, company));
        if (!party) continue;
        const named = parties.people.find((p) => sameName(p, who));
        const f = judgmentFinding(j, ctx, {
          severity: isUkCriminal(j.title) ? 'high' : 'medium',
          ...(named ? { matchText: `${who.name} | ${j.title} | ${company}` } : { match: 'company', matchReasons: [`${party} is a party`] }),
        });
        if (f) findings.push(f);
      }
      return { findings: findings.slice(0, 10), threads: [], notes };
    }
    const seen = new Set();
    const companies = knownCompanies(ctx.subject).slice(0, 1);
    // With a known company first: judgments whose full text names both (the search ANDs quoted phrases).
    for (const company of companies) {
      for (const j of await caseLawFeed([who.name, companyCore(company)], who.surname, ctx)) {
        const parties = caseParties(j.title);
        if (!parties.people.some((p) => sameName(p, who))) continue;
        seen.add(j.url);
        const f = judgmentFinding(j, ctx, {
          severity: isUkCriminal(j.title) ? 'high' : 'medium',
          matchText: `${who.name} | ${j.title} | ${company}`,
          // The company is in the judgment, not the feed: say so.
        });
        if (f) findings.push({ ...f, matchReasons: [...f.matchReasons, `the judgment text names ${company} (Find Case Law search)`] });
      }
    }
    let privateSkipped = 0;
    for (const j of await caseLawFeed([who.name], who.surname, ctx)) {
      if (seen.has(j.url)) continue;
      const parties = caseParties(j.title);
      if (!parties.people.some((p) => sameName(p, who))) continue;
      const company = namesKnownCompany(ctx.subject, j.title);
      if (!company && PRIVATE_COURTS.test(j.court)) { privateSkipped += 1; continue; }
      const f = judgmentFinding(j, ctx, { severity: isUkCriminal(j.title) ? 'high' : 'medium', matchText: `${who.name} | ${j.title}` });
      if (f) findings.push(f);
    }
    if (privateSkipped) notes.push(`${plural(privateSkipped, 'family, immigration or employment judgment')} under the same name ${privateSkipped === 1 ? 'was' : 'were'} left out: nothing in ${privateSkipped === 1 ? 'it' : 'them'} ties ${privateSkipped === 1 ? 'it' : 'them'} to ${who.name}'s companies.`);
    return { findings: findings.slice(0, 12), threads: [], notes };
  },
};

/* ------------------------------------------------------------------ 6b. BODACC (France) */

const BD_ID = 'fr-bodacc';
const BD_LABEL = 'French official commercial bulletin (BODACC)';
const BD_RECORDS = 'https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-commerciales/records';
const GLEIF = 'https://api.gleif.org/api/v1/lei-records';
const BD_FAMILIES = ['Procédures collectives', 'Ventes et cessions', 'Radiations', 'Procédures de conciliation', 'Procédures de rétablissement professionnel'];
const BD_FIELDS = 'id,dateparution,familleavis_lib,typeavis_lib,commercant,registre,tribunal,jugement,modificationsgenerales,radiationaurcs,listepersonnes,publicationavis,parution,numeroannonce,pdf_parution_subfolder,ispdf_unitaire,url_complete';
const sirenCache = new Map();
const parseJsonField = (v) => { if (!v) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };

/** French company numbers (SIREN) for a company name, from the LEI register. */
async function sirensFor(company, ctx) {
  if (/^\d{3}\s?\d{3}\s?\d{3}$/.test(company)) return [company.replace(/\s/g, '')];
  const key = plainKey(company);
  if (sirenCache.has(key)) return sirenCache.get(key);
  const read = (json) => arr(json?.data).map((r) => r?.attributes?.entity).filter((e) => e && sameCompany(e.legalName?.name || '', company))
    .map((e) => clean(e.registeredAs).replace(/\s/g, '')).filter((s) => /^\d{9}$/.test(s));
  const ask = async (filter) => {
    const json = await getJson(`${GLEIF}?${filter}&filter%5Bentity.legalAddress.country%5D=FR&page%5Bsize%5D=10`, { deadline: ctx.deadline, timeoutMs: 12000, accept: 'application/vnd.api+json,application/json' });
    if (!json || !Array.isArray(json.data)) throw new HttpError('The LEI register returned something unexpected', { url: GLEIF });
    return read(json);
  };
  let sirens = await ask(`filter%5Bentity.legalName%5D=${encodeURIComponent(company)}`);
  if (!sirens.length) sirens = await ask(`filter%5Bfulltext%5D=${encodeURIComponent(company)}`);
  sirens = uniq(sirens).slice(0, 3);
  if (sirenCache.size > 200) sirenCache.delete(sirenCache.keys().next().value);
  sirenCache.set(key, sirens);
  return sirens;
}

/** The notice's own PDF (a distinct address per notice), else the bulletin's search page for it. */
function bodaccUrl(r) {
  const p = String(r.parution || '');
  if (r.ispdf_unitaire === 'oui' && r.publicationavis && /^\d{8}$/.test(p) && r.numeroannonce != null && r.pdf_parution_subfolder != null) {
    return `https://www.bodacc.fr/telechargements/COMMERCIALES/PDF/${r.publicationavis}/${p.slice(0, 4)}/${p}/${r.pdf_parution_subfolder}/BODACC_${r.publicationavis}_PDF_Unitaire_${p}_${String(r.numeroannonce).padStart(5, '0')}.pdf`;
  }
  return String(r.url_complete || '');
}

function bodaccFinding(r, ctx, company) {
  const family = clean(r.familleavis_lib);
  const judgment = parseJsonField(r.jugement);
  const people = parseJsonField(r.listepersonnes);
  const kinds = arr(people?.personne).map((x) => x?.typePersonne).filter(Boolean);
  if (kinds.length && !kinds.includes('pm')) return null; // a sole trader's notice is a person's own affairs
  const mods = parseJsonField(r.modificationsgenerales);
  const rad = parseJsonField(r.radiationaurcs);
  const descr = (d) => { const t = clean(d?.descriptif); return t && !/\b\d{5}\b/.test(t) ? clip(t, 220) : ''; };
  const what = clean(judgment?.nature) || descr(mods) || (rad ? 'Radiation du RCS' : '') || clean(r.typeavis_lib);
  const url = bodaccUrl(r);
  if (!url) return null;
  const facts = [
    `${clean(r.commercant)} (SIREN ${arr(r.registre)[0] || '?'})`,
    `${family}${what ? `: ${what}` : ''}${judgment?.date ? ` (${isoDay(judgment.date) || clean(judgment.date)})` : ''}`,
    clean(r.tribunal),
  ].filter(Boolean).join('. ');
  return makeFinding(ctx.subject, {
    source: BD_ID, sourceLabel: BD_LABEL, category: 'corporate',
    title: `${clean(r.commercant)}: ${family}${what ? `, ${what}` : ''} (BODACC ${clean(r.dateparution)})`,
    quote: `${facts}.`,
    url, date: r.dateparution,
    severity: family === 'Procédures collectives' ? 'medium' : 'low',
    data: { siren: arr(r.registre)[0] || null, noticeId: r.id, family, court: clean(r.tribunal) || null },
    match: 'company', matchReasons: [`${clean(r.commercant)} is ${company} in the French register (same SIREN)`],
  });
}

export const bodaccConnector = {
  id: BD_ID,
  label: BD_LABEL,
  kinds: ['company'],
  prior: 0.25,
  timeoutMs: 20000,
  async run(task, ctx) {
    const company = clean(task.value);
    const sirens = await sirensFor(company, ctx);
    if (!sirens.length) return { findings: [], threads: [], notes: [`${company} was not found as a French company in the LEI register, so the French bulletin was not searched.`] };
    const where = `(${sirens.map((s) => `registre:"${s}"`).join(' or ')}) and (familleavis_lib in (${BD_FAMILIES.map((f) => `"${f}"`).join(',')}) or search(modificationsgenerales,"dissolution"))`;
    const url = `${BD_RECORDS}?where=${encodeURIComponent(where)}&order_by=${encodeURIComponent('dateparution desc')}&limit=20&select=${encodeURIComponent(BD_FIELDS)}`;
    const json = await getJson(url, { deadline: ctx.deadline, timeoutMs: 15000 });
    if (!json || !Array.isArray(json.results)) throw new HttpError('The BODACC search returned something unexpected', { url: BD_RECORDS });
    const findings = json.results.map((r) => bodaccFinding(r, ctx, company)).filter(Boolean);
    const notes = findings.length ? [] : [`No insolvency, sale or dissolution notice for ${company} (SIREN ${sirens.join(', ')}) in the French bulletin.`];
    return { findings: findings.slice(0, 12), threads: [], notes };
  },
};

/* ------------------------------------------------------------------ 7. CFTC and CFPB enforcement actions */

const EN_ID = 'us-enforcement-actions';
const EN_LABEL = 'US CFTC and CFPB enforcement actions';
const CFTC = 'https://www.cftc.gov';
const CFPB = 'https://www.consumerfinance.gov';

async function cftcReleases(term, ctx) {
  const url = `${CFTC}/PressRoom/PressReleases?combine=${encodeURIComponent(term)}&field_press_release_types_value=All&prtid=All&year=all`;
  const html = await getText(url, { deadline: ctx.deadline, timeoutMs: 15000 });
  const $ = cheerio.load(html);
  const rows = $('tr').toArray().map((tr) => {
    const a = $(tr).find('a[href^="/PressRoom/PressReleases/"]').first();
    return a.length ? { title: clean(a.text()), url: `${CFTC}${a.attr('href')}`, date: isoDay($(tr).find('time[datetime]').attr('datetime')), agency: 'CFTC' } : null;
  }).filter((r) => r && r.title);
  if (!rows.length && !/view-empty|No results found/i.test(html)) throw new HttpError('The CFTC release search returned an unexpected page', { url });
  return rows;
}

async function cfpbActions(term, ctx) {
  const url = `${CFPB}/enforcement/actions/?title=${encodeURIComponent(term)}`;
  const html = await getText(url, { deadline: ctx.deadline, timeoutMs: 15000 });
  if (!/o-post-preview|enforcement/i.test(html)) throw new HttpError('The CFPB enforcement search returned an unexpected page', { url });
  const $ = cheerio.load(html);
  return $('article.o-post-preview').toArray().map((el) => {
    const a = $(el).find('a[href^="/enforcement/actions/"]').first();
    return a.length ? {
      title: clean(a.text()), url: `${CFPB}${a.attr('href')}`, date: isoDay($(el).find('time[datetime]').attr('datetime')),
      summary: clean($(el).find('.o-post-preview__description').text()), agency: 'CFPB',
    } : null;
  }).filter((r) => r && r.title);
}

const enforcementSeverity = (text) => atLeast('medium', severityFromText(text));
/**
 * The CFTC search covers every kind of release (comment requests, approvals,
 * appointments, speeches): only those that announce an action against someone
 * are enforcement. "Registration Order" is a noun; "Orders X to Pay" a verb.
 */
const CFTC_ACTION = /\b(?:charg|orders\b|ordered\b|orders?\s+(?:against|requiring|imposing)\b|complaint|settle|resolv|judgment|penalt|fine[sd]?\b|sanction|bar(?:s|red)\b|fraud|enforcement action|consent|restitution|disgorgement|indict|guilty|sentenc|injunction|manipulat|spoof|misappropriat)/i;
const isAction = (r) => r.agency !== 'CFTC' || CFTC_ACTION.test(r.title);

export const enforcementActionsConnector = {
  id: EN_ID,
  label: EN_LABEL,
  kinds: ['subject', 'company'],
  prior: 0.3,
  timeoutMs: 25000,
  async run(task, ctx) {
    const who = person(ctx.subject);
    const findings = [];
    const base = { source: EN_ID, sourceLabel: EN_LABEL, category: 'regulatory' };
    if (task.kind === 'company') {
      const company = clean(task.value);
      const core = companyCore(company);
      const [cftc, cfpb] = await Promise.all([cftcReleases(core, ctx), cfpbActions(core, ctx)]);
      for (const r of [...cftc, ...cfpb]) {
        // The CFTC search reads release bodies and the CFPB one descriptions: keep only actions with the company in the title.
        if (!isAction(r) || !headlineNamesCompany(r.title, company)) continue;
        const named = namesPerson(`${r.title} ${r.summary || ''}`, who);
        const f = makeFinding(ctx.subject, {
          ...base, title: `${r.agency}: ${r.title}`, quote: r.summary || r.title, url: r.url, date: r.date,
          severity: enforcementSeverity(`${r.title} ${r.summary || ''}`), data: { agency: r.agency },
          ...(named ? { matchText: `${r.title} | ${r.summary || ''}` } : { match: 'company', matchReasons: [`${company} is named in the title`] }),
        });
        if (f) findings.push(f);
      }
      return { findings: findings.slice(0, 10), threads: [], notes: [] };
    }
    for (const r of await cftcReleases(who.name, ctx)) {
      if (!isAction(r) || !namesPerson(r.title, who)) continue;
      const f = makeFinding(ctx.subject, {
        ...base, title: `${r.agency}: ${r.title}`, quote: r.title, url: r.url, date: r.date,
        severity: enforcementSeverity(r.title), data: { agency: r.agency }, matchText: r.title,
      });
      if (f) findings.push(f);
    }
    return { findings: findings.slice(0, 10), threads: [], notes: [] };
  },
};

export const COURT_CONNECTORS = [
  courtDocketsConnector, courtRecordsOpenConnector, dojConnector, brokerCheckConnector,
  ukGazetteConnector, ukCaseLawConnector, bodaccConnector, enforcementActionsConnector,
];
