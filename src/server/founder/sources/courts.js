/**
 * Courts, enforcement and regulator records.
 *
 *   courtDocketsConnector       US federal dockets and opinions (CourtListener), needs a token
 *   courtRecordsOpenConnector   the same dockets by case title (Internet Archive copy), when there is no token
 *   dojConnector                US Department of Justice press releases
 *   brokerCheckConnector        FINRA BrokerCheck and SEC adviser registrations, disclosures and bars; the
 *                               Form ADV record of a fund or adviser firm tied to the person
 *
 * A company is searched and matched under every name it is known by in the
 * check (companyNames: the name typed and the legal names identity.js learned
 * from records tied to the person). Once a legal name is known, a company
 * typed as an ordinary word ("Ramp") is no longer matched by that bare word.
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
import { companyMention, isOrdinaryWordCompany } from '../names';
import { mentionsMinor, isSensitive } from '../guardrails';
import { withAliasHold } from './alias';

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
// What follows the company in a class or derivative caption: "In re Nikola Corporation Securities Litigation",
// "In re Tesla Motors, Inc. Stockholder Litigation". Only stripped after "In re", so that a real party called
// "... Litigation Trust" stays whole.
const LITIGATION_TAIL = /,?\s+(?:Consolidated\s+)?(?:(?:(?:Stockholders?|Shareholders?)['’]?|Securities|Derivative|ERISA|Merger|Appraisal|Section\s+\d+\w*|Antitrust|Data\s+(?:Security\s+)?Breach|Consumer(?:\s+Privacy)?|Privacy|Class\s+Action|Customer\s+Data(?:\s+Security\s+Breach)?|Products?\s+Liability|Sales\s+Practices)\s+(?:(?:and|&)\s+(?:Securities|Derivative|ERISA)\s+)?)?(?:Litigation|Litig\.?|Actions?|Cases?)\s*$/i;

export function caseParties(caseName) {
  const asides = [];
  const base = clean(caseName).replace(/&amp;/g, '&').replace(/\(([^)]{2,120})\)/g, (m, inner) => { asides.push(clean(inner.replace(/^(?:as successor to|formerly(?: known as)?|f\/k\/a|aka|a\/k\/a|t\/a|trading as|d\/b\/a)\s+/i, ''))); return ' '; });
  const tidy = (p) => {
    const inRe = /^\s*(?:in\s+re:?|in the matter of:?)\s+/i.test(p);
    let s = clean(p.replace(/^(?:in\s+re:?|in the matter of:?|re:?|ex parte|estate of)\s+/i, '').replace(/\b(?:et\s+al\.?|and others|and another)\s*$/i, '').replace(/\s*&\s*(?:ors|anor|others|another)\.?\s*$/i, '').replace(/[,;:]+$/, ''));
    // The party of a class or derivative caption is the company before the descriptor.
    if (inRe) { const core = clean(s.replace(LITIGATION_TAIL, '').replace(/[,;:]+$/, '')); if (core) s = core; }
    return s;
  };
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

const isDomainName = (v) => /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(String(v || '')) && /\.[a-z]{2,}$/i.test(String(v || ''));
/**
 * Every name the company is known by in this check: the name of the thread
 * first, then the fuller legal names learned from records tied to the person
 * (identity.js addCompanyAlias: "Ramp" -> "Ramp Business Corporation").
 * Domains are returned apart: registers and courts are searched by name.
 */
export function companyNames(subject, company) {
  const given = clean(company);
  if (!given) return { names: [], domains: [], legal: [] };
  const key = companyKeys(given)[0] || given.toLowerCase();
  const aliases = [...(subject?.anchors?.aliases?.values() || [])].filter((a) => a && a.of === key).map((a) => clean(a.value)).filter(Boolean);
  const legal = uniq(aliases.filter((a) => !isDomainName(a)));
  return { names: uniq([given, ...legal]).filter((n, i, all) => all.findIndex((m) => companyKeyStrict(m) === companyKeyStrict(n)) === i), domains: uniq(aliases.filter(isDomainName)), legal };
}

/**
 * Is one side of a case any known name of the company? A company typed as an
 * ordinary word ("Ramp", "Merge") whose legal name is known must be matched by
 * that legal name: "Ramp, Inc." is then another company, not "Ramp Business
 * Corporation". Without a learned legal name the old rule holds ("Flow, Inc." is Flow).
 */
/** The names a record's company name may equal: every known name, less the bare ordinary word once a legal name is known. */
export function matchNames(subject, company) {
  const { names, legal } = companyNames(subject, company);
  return legal.length && isOrdinaryWordCompany(company) ? names.slice(1) : names;
}

export function partyIsKnownCompany(side, company, subject = null) {
  return matchNames(subject, company).some((n) => partyIsCompany(side, n));
}

/**
 * How a headline names the company: 'strong' (a side of a case-style title, a
 * legal form, a learned legal name), 'weak' (the name written as a name, an
 * ordinary word used as a company: "Theranos Founder Charged", "Judgment
 * Against FTX"), or '' when it does not ("Block Grant Fraud", "Cash Flow Scheme").
 * The phase 1 company matcher (names.js companyMention) decides the text forms.
 */
function headlineNaming(title, company, subject = null) {
  if (caseParties(title).sides.some((side) => partyIsKnownCompany(side, company, subject))) return 'strong';
  const { names, legal } = companyNames(subject, company);
  const strictOnly = legal.length > 0 && isOrdinaryWordCompany(company);
  let weak = false;
  for (const n of names.length ? names : [company]) {
    const m = companyMention(n, String(title || ''), { aliases: legal });
    if (!m.named) continue;
    if (strictOnly && n === names[0] && !m.spans.some((s) => s.how === 'legal-name')) continue;
    if (m.strength === 'strong') return 'strong';
    weak = true;
  }
  return weak ? 'weak' : '';
}
/** Does free text name the company strongly (a legal form, a learned legal name or a domain)? */
const textNamesCompanyStrongly = (text, company, subject = null) => {
  const { names, legal, domains } = companyNames(subject, company);
  return (names.length ? names : [company]).some((n) => {
    const m = companyMention(n, String(text || ''), { aliases: [...legal, ...domains] });
    return m.named && m.strength === 'strong';
  });
};

/* ------------------------------------------------------------------ private matters, shared by every court source */

/**
 * Matters this check never reads: family and children, guardianship, estates,
 * immigration and asylum, health and disability benefits, prisoners' own petitions.
 * Shared by courts.js and courtsMore.js so every court path uses one list.
 */
export const PRIVATE_MATTER = /\b(?:family court|custody|guardianship|guardian ad litem|adult protective|disabled person|incapacitat\w*|minor child|juvenile|adoption|divorce|name change|estate of|in re (?:the )?(?:estate|trust|will|guardianship)|immigration|citizenship|refugee|asylum|international protection|residence permit|third-country national|family reunification|deport\w*|removal order|expulsion|visa|permanent resident|public safety and emergency preparedness|mental health|psychiatric|sickness|invalidity|disability benefits?|commissioner of social security|social security (?:administration|disability|benefits?|income)|supplemental security income|DIW[CW]|SSID|black lung|prisoner petitions?|prison conditions|civil detainee|medical malpractice)\b/i;
/**
 * A US federal nature of suit about a person's benefits, health or custody:
 * Social Security (861-865), prisoner petitions (510-560), medical malpractice (362).
 */
const PRIVATE_SUIT = /^\s*(?:86[1-5]|5[1-6]\d|362)\b|social security|\bDIW[CW]\b|\bSSID\b|\bRSI\b|black lung|prisoner|habeas corpus|prison condition|civil detainee|medical malpractice/i;
/** Malpractice is private for a person, but a suit against a company (a clinic chain, a health startup) is its business. */
const PERSONAL_ONLY_SUIT = /^\s*362\b|medical malpractice/i;
/** Is a case about a private matter, or does its caption name a minor? */
function privateCase(caption, suitNature = '', { personal = true } = {}) {
  if (PRIVATE_MATTER.test(caption) || mentionsMinor(caption)) return true;
  const suit = clean(suitNature);
  if (suit && PRIVATE_SUIT.test(suit) && (personal || !PERSONAL_ONLY_SUIT.test(suit))) return true;
  return personal && isSensitive(caption);
}

/* ------------------------------------------------------------------ companies in free text (shared with courtsMore.js) */

const LEGAL_FORM_WORDS = 'inc|incorporated|llc|l\\.l\\.c|ltd|limited|corp|corporation|co|company|plc|sa|s\\.a|sas|sarl|gmbh|ag|bv|b\\.v|nv|n\\.v|pty|lp|l\\.p|llp|sl|s\\.l|spa|s\\.p\\.a|ab|as|oy|kk';
const TRAILING_FORM = new RegExp(`(?:[\\s,]+(?:${LEGAL_FORM_WORDS})\\.?)+$`, 'i');
/** The words that identify a company: "Nikola Corporation" -> "Nikola", "The Boring Company" -> "Boring". */
export function formCore(company) {
  const core = clean(String(company || '').replace(/["“”]/g, '')).replace(TRAILING_FORM, '').replace(/^the\s+/i, '').replace(/[,.]+$/, '');
  return clean(core) || clean(company);
}
/**
 * Does free text name the company? Several words must appear together; a
 * one-word name must be followed by a legal form or "of <place>" ("Apple
 * Inc.", "Apple. Inc", "Intel Corporation of Santa Clara"), so "apple juice"
 * or "Block grants" are not the company.
 */
export function textNamesCompany(text, company) {
  const core = formCore(company);
  if (!core || core.length < 2) return false;
  const body = escapeRe(core).replace(/\\?\s+/g, '\\s+');
  const multi = core.split(' ').length >= 2;
  if (multi) return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'i').test(String(text || ''));
  // A one-word name: written with a capital, and followed by a legal form or "of <Place>".
  const re = new RegExp(`(?<![A-Za-z0-9])${body}[.,]?\\s*(?:(?:${LEGAL_FORM_WORDS})\\b\\.?|of\\s+[A-Z])`, 'gi');
  return [...String(text || '').matchAll(re)].some((m) => /^[A-Z0-9]/.test(m[0]) && !/of\s+[a-z]$/.test(m[0]));
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
// The prosecuting government as the whole first side of a case: "United States", "People of the State of
// California", "State of Delaware", "Commonwealth". "State Farm ...", "People's United Bank" and "United States
// Commodity Futures Trading Commission" (a civil enforcement agency) are not.
const PROSECUTOR = /^(?:the\s+)?(?:united states(?: of america)?|u\.?\s?s\.?(?:\s?a\.?)?|people(?: of the state of [a-z .]+)?|state(?: of [a-z .]+)?|commonwealth(?: of [a-z .]+)?)$/i;
const CIVIL_ENFORCER = /^(?:the\s+)?(?:u\.\s?s\.\s+|united states\s+)?(?:securities\s+(?:and|&)\s+exchange\s+commission|sec|commodity\s+futures\s+trading\s+commission|cftc|federal\s+trade\s+commission|ftc|consumer\s+financial\s+protection\s+bureau|cfpb)$/i;
export const isCriminalCase = (caseName, docketNumber = '') => {
  if (/-(?:cr|mj)-/i.test(docketNumber)) return true;
  if (/-(?:cv|bk|ap|mc|md)-/i.test(docketNumber) || /\$|\bfunds\b|\breal property\b/i.test(caseName)) return false;
  const { sides } = caseParties(caseName);
  return sides.length >= 2 && PROSECUTOR.test(clean(sides[0]).replace(/[,.]+$/, '')) && !CIVIL_ENFORCER.test(clean(sides[0]));
};
/** A civil case brought by a federal enforcement agency ("SEC v. Milton", "U.S. Commodity Futures Trading Commission v. X"). */
const isCivilEnforcement = (caseName) => { const { sides } = caseParties(caseName); return sides.length >= 2 && CIVIL_ENFORCER.test(clean(sides[0])); };

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
    throw new HttpError('Court docket lookups have used up their allowance for now', { retryable: true, code: 'allowance' });
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
/**
 * A name as a phrase that allows up to two words in between, so "Trevor Milton"
 * also finds "Trevor R. Milton" and "Arthur Gau" finds "Arthur Ching-Fu Gau".
 * sameName then checks the record's name part by part.
 */
const nearPhrase = (name) => `${quoted(name)}~3`;
const anyNear = (names) => (names.length > 1 ? `(${names.map(nearPhrase).join(' OR ')})` : nearPhrase(names[0]));
/** The forms to search a person by: the name as typed (and its formal given name), and given name plus surname. */
const searchNames = (who) => uniq([...who.queryNames, ...who.variants.filter((v) => v.split(' ').length === 2)]).slice(0, 3);

/** Parties shown in a report: the person and their known companies only; everyone else is counted, never named. */
function shownParties(parties, who, subject, company = '') {
  const known = uniq([company, ...knownCompanies(subject)]);
  const keep = parties.filter((p) => sameName(p, who) || known.some((c) => partyIsKnownCompany(p, c, subject)));
  const others = parties.length - keep.length;
  if (!parties.length) return '';
  if (!keep.length) return `${plural(others, 'party', 'parties')} on the docket.`;
  return `Parties include: ${keep.slice(0, 6).join('; ')}${others ? `; and ${plural(others, 'other party', 'other parties')}` : ''}.`;
}

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
  const companyParty = company ? [...parties, ...title.sides, ...title.asides, ...fullTitle.sides].find((p) => partyIsKnownCompany(p, company, ctx.subject)) || '' : '';
  if (company ? !companyParty : !(partyHit || textHit)) return { skip: 'not-named' };
  // Disability benefits, prisoners' petitions, a person's malpractice suit, a minor's initials: never reported.
  const captionText = `${caseName}. ${clean(d.case_name_full)}. ${parties.join('; ')}`;
  if (privateCase(captionText, d.suitNature, { personal: Boolean(partyHit || textHit) })) return { skip: 'private' };

  const court = clean(d.court) || federalCourtName(d.court_id);
  const docketNumber = clean(d.docketNumber);
  const filed = isoDay(d.dateFiled);
  const criminal = isCriminalCase(caseName, docketNumber);
  const bankruptcy = isBankruptcyCourt(d.court_id, court) || Boolean(d.chapter);
  const surnameSide = title.sides.some((side) => plainKey(side) === plainKey(who.surname));
  const facts = [
    shownParties(parties, who, ctx.subject, company),
    clean(d.suitNature) ? `Nature of suit: ${clean(d.suitNature)}.` : '',
    clean(d.cause) ? `Cause: ${clean(d.cause)}.` : '',
    d.chapter ? `Bankruptcy chapter ${clean(d.chapter)}.` : '',
    isoDay(d.dateTerminated) ? `Status: closed ${isoDay(d.dateTerminated)}.` : filed ? 'Status: no closing date on the docket.' : '',
    textHit ? `Filing: ${clip(textHit, 260)}` : '',
  ].filter(Boolean).join(' ');
  const named = Boolean(partyHit || textHit);
  // Graded on the caption, the person's own party entry and the known companies among the parties (never on strangers' names).
  const gradeParties = parties.filter((p) => sameName(p, who) || uniq([company, ...knownCompanies(ctx.subject)]).some((c) => partyIsKnownCompany(p, c, ctx.subject)));
  const matchText = named ? [who.name, caseName, gradeParties.join('; '), title.asides.join('; '), textHit].filter(Boolean).join(' | ') : '';
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
  if (privateCase(`${caseName}. ${clean(o.caseNameFull)}`, o.suitNature || '')) return null;
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
  kinds: ['subject', 'alias', 'company'],
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
    try {
      return await clRun(task, ctx);
    } catch (error) {
      // The daily allowance is kept in this server's memory, and the service may refuse with 429 before it runs
      // out: then the case titles of the public archive copy are searched instead, and the result says so.
      if (!(error instanceof HttpError) || !(error.code === 'allowance' || error.status === 429)) throw error;
      const what = 'US federal court dockets (case titles only: the fuller docket search was busy)';
      const template = task.template || '';
      if (template === 'opinions.name') {
        return { findings: [], threads: [], notes: ['Court opinions were not searched: the fuller docket search was busy.'], partial: ['US court opinions (not searched: the docket search was busy)'] };
      }
      const fallback = await courtRecordsOpenConnector.run({ ...task, kind: task.kind === 'company' ? 'company' : 'subject' }, ctx);
      return { ...fallback, notes: ['The fuller docket search was busy, so the public archive of federal case titles was searched instead.', ...(fallback.notes || [])], partial: uniq([...(fallback.partial || []), what]) };
    }
  },
};

async function clRun(task, ctx) {
  const who = person(ctx.subject);
  const template = task.template || (task.kind === 'company' ? 'dockets.company' : 'dockets.party');
  const notes = [];
  const partial = [];
  const names = searchNames(who);
  if (template === 'opinions.name') {
    const json = await clSearch({ type: 'o', q: anyNear(names), order_by: 'score desc', highlight: 'on' }, ctx);
    const count = Number(json.count) || json.results.length;
    if (count > json.results.length) partial.push(`US court opinions (${json.results.length} of about ${count} read)`);
    const out = { findings: json.results.map((o) => opinionFinding(o, ctx, who)).filter(Boolean).slice(0, 10), threads: [], notes };
    return partial.length ? { ...out, partial } : out;
  }
  const company = template === 'dockets.company' ? clean(task.value) : '';
  const paired = template === 'dockets.name-company' ? clean(task.params?.company || ctx.subject.company) : '';
  // Every known name of the company: the name typed and the legal names learned from records tied to the person.
  const companyForms = company ? companyNames(ctx.subject, company).names.slice(0, 3) : [];
  const pairedForms = paired ? companyNames(ctx.subject, paired).names.slice(0, 3) : [];
  const q = company ? `party:${anyOf(companyForms)}` : paired ? `${anyNear(names)} ${anyOf(pairedForms)}` : `party:${anyNear(names)}`;
  const json = await clSearch({ type: 'r', q, order_by: 'score desc', highlight: 'on' }, ctx);
  const read = json.results.map((d) => docketFinding(d, ctx, who, { company }));
  const findings = read.map((r) => r.finding).filter(Boolean).slice(0, company ? 8 : 12);
  const count = Number(json.count) || json.results.length;
  if (count > json.results.length) {
    notes.push(`CourtListener lists about ${count} federal dockets for ${company || who.name}; the ${json.results.length} closest matches were read.`);
    partial.push(`US federal court dockets (${json.results.length} of about ${count} read)`);
  }
  if (read.some((r) => r.skip === 'personal-bankruptcy')) notes.push(`Personal bankruptcy cases under the name ${who.name} are reported only when the docket also names a company tied to them; none shown from this lookup did.`);
  if (read.some((r) => r.skip === 'private')) notes.push('Cases about benefits, health, prisoners\' petitions or minors are never reported.');
  return partial.length ? { findings, threads: [], notes, partial } : { findings, threads: [], notes };
}

/* ------------------------------------------------------------------ 2. Internet Archive copy of federal dockets (no token) */

const IA_ID = 'court-records-open';
const IA_LABEL = 'US federal court case titles (Internet Archive copy of court dockets)';
const IA_SEARCH = 'https://archive.org/advancedsearch.php';

/** Dockets whose title carries every term; `anyOf` titles are alternatives, `court` a court code. */
async function iaTitles(terms, ctx, rows = 100, { anyOf: alternatives = [], court = '', raw = '' } = {}) {
  const q = ['collection:usfederalcourts', ...(court ? [`court:${court.replace(/[^a-z0-9]/g, '')}`] : []), ...terms.map((t) => `title:(${quoted(t)})`),
    ...(alternatives.length ? [`(${alternatives.map((t) => `title:(${quoted(t)})`).join(' OR ')})`] : []), ...(raw ? [raw] : [])].join(' AND ');
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

function iaFinding(doc, ctx, who, { company = '', tie = null, charges = [] } = {}) {
  const caseName = clean(arr(doc.title)[0]);
  const code = clean(arr(doc.court)[0]) || (String(doc.identifier).match(/^gov\.uscourts\.([a-z0-9]+)\./) || [])[1] || '';
  const court = federalCourtName(code);
  const title = caseParties(caseName);
  const partyHit = title.people.find((p) => sameName(p, who)) || '';
  const companyParty = company ? [...title.sides, ...title.asides].find((p) => partyIsKnownCompany(p, company, ctx.subject)) || '' : '';
  if (company ? !companyParty : !partyHit) return { skip: 'not-named' };
  if (privateCase(caseName, '', { personal: Boolean(partyHit) })) return { skip: 'private' };
  const matchText = partyHit ? `${who.name} | ${caseName}` : '';
  if (partyHit && isBankruptcyCourt(code) && matchSubject(ctx.subject, matchText).level !== 'confirmed') return { skip: 'personal-bankruptcy' };
  const surnameSide = title.sides.find((side) => plainKey(side) === plainKey(who.surname)) || '';
  // The company the person founded or runs on one side and exactly their surname on the other: likely them, never confirmed.
  const origin = !partyHit && surnameSide && title.sides.length === 2 && title.sides.includes(companyParty) && companyParty !== surnameSide
    ? foundedCompany(ctx.subject, company, tie) : '';
  // Their own criminal case, filed where and when a confirmed record says they were charged: likely, never confirmed.
  const charged = partyHit ? chargeTie(doc, code, caseName, who, charges) : null;
  const raise = charged && matchSubject(ctx.subject, matchText).level !== 'confirmed';
  const caseNumber = raise ? charged.caseNumber || null : null;
  const finding = makeFinding(ctx.subject, {
    source: IA_ID,
    sourceLabel: IA_LABEL,
    category: 'litigation',
    title: `${caseName} (${court}, federal court docket${caseNumber ? ` ${caseNumber}` : ''})`,
    quote: caseName,
    url: iaUrl(doc),
    date: null, // the archive records when the copy was made, not when the case was filed
    severity: isCriminalCase(caseName) && (partyHit || company) ? 'high' : 'medium',
    data: { caseNumber, court, archiveId: String(doc.identifier), ...(isCivilEnforcement(caseName) ? { kind: 'civil enforcement' } : {}) },
    ...(raise ? {
      match: 'likely',
      matchReasons: [`filed in the ${court} within ${charged.days} day${charged.days === 1 ? '' : 's'} of the charge in "${charged.record}"`],
    } : partyHit ? { matchText } : origin ? {
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
const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 366 * DAY_MS;
// A docket first copied to the archive this many days after the charges were announced can be the charged case.
const CHARGE_DOCKET_DAYS = 7;

/**
 * The one federal case number a record gives ("21-cr-478", "1:21-cr-00478",
 * "21 Cr. 478"), as "21-cr-478"; '' when it gives none or several (a
 * release about several defendants), so a number is never given to the wrong case.
 */
export function caseNumberIn(text) {
  const found = new Set();
  const t = String(text || '');
  for (const m of t.matchAll(/\b(\d{1,2})[-:](cr|cv)[-:](\d{3,5})\b/gi)) found.add(`${m[1]}-${m[2].toLowerCase()}-${Number(m[3])}`);
  for (const m of t.matchAll(/\b(\d{2})\s+(Cr|Civ)\.\s+(\d{1,5})\b/g)) found.add(`${m[1]}-${m[2] === 'Cr' ? 'cr' : 'cv'}-${Number(m[3])}`);
  return found.size === 1 ? [...found][0] : '';
}

/**
 * Where and when the subject was charged, from confirmed Justice Department
 * or SEC records already in this check: [{ court, dates, record, charges }], at most two courts.
 * `charges` holds each record's date, title and case number.
 */
function chargeDistricts(ctx) {
  let list = [];
  try { list = typeof ctx.findings === 'function' ? ctx.findings() : ctx.findings; } catch { list = []; }
  const byCourt = new Map();
  for (const f of Array.isArray(list) ? list : []) {
    if (!f || f.match !== 'confirmed' || !CHARGE_SOURCES.has(f.source) || !isoDay(f.date)) continue;
    const date = Date.parse(isoDay(f.date));
    const caseNumber = caseNumberIn(`${f.title} ${f.quote || ''} ${f.data?.caseNumber || ''}`);
    for (const court of districtCodes(`${f.title} ${f.quote || ''} ${f.data?.office || ''}`)) {
      const entry = byCourt.get(court) || { court, dates: [], record: f.title, charges: [] };
      entry.dates.push(date);
      entry.charges.push({ date, record: f.title, caseNumber });
      byCourt.set(court, entry);
    }
  }
  return [...byCourt.values()].slice(0, 2);
}

/**
 * A criminal docket the subject is a party to by their exact full name
 * ("United States v. Trevor Milton"), in the district of a confirmed charge
 * record and first copied to the archive within a week after it: likely the
 * charged case. Never confirmed: the archive gives the title, not the parties.
 */
function chargeTie(doc, code, caseName, who, charges) {
  if (!charges?.length || !who.name) return null;
  const { sides } = caseParties(caseName);
  if (sides.length !== 2 || !isCriminalCase(caseName) || !/^(?:united states(?: of america)?|usa)$/i.test(sides[0])) return null;
  if (plainKey(sides[1]) !== plainKey(who.name)) return null;
  const copied = Date.parse(String(arr(doc.publicdate)[0] || ''));
  if (Number.isNaN(copied)) return null;
  for (const { court, charges: list } of charges) {
    if (court !== code) continue;
    for (const c of list || []) {
      const days = Math.floor((copied - c.date) / DAY_MS);
      if (days >= 0 && days <= CHARGE_DOCKET_DAYS) return { court, days, record: c.record, caseNumber: c.caseNumber };
    }
  }
  return null;
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
  const partial = [];
  if (!who.surname) return { findings, partial };
  for (const { court, dates } of chargeDistricts(ctx)) {
    // The criminal case, and the parallel civil cases of the market regulators (filed the same day, also by surname).
    const { total, docs } = await iaTitles([], ctx, 50, { court, anyOf: [
      `United States v. ${who.surname}`, `USA v. ${who.surname}`,
      `Securities and Exchange Commission v. ${who.surname}`, `SEC v. ${who.surname}`,
      `Commodity Futures Trading Commission v. ${who.surname}`,
    ] });
    if (total > docs.length) partial.push(`US federal dockets in the charging district (${docs.length} of ${total} titles read)`);
    for (const doc of docs) {
      if (seen.has(doc.identifier)) continue;
      const code = clean(arr(doc.court)[0]) || (String(doc.identifier).match(/^gov\.uscourts\.([a-z0-9]+)\./) || [])[1] || '';
      const caseName = clean(arr(doc.title)[0]);
      const { sides } = caseParties(caseName);
      const copied = Date.parse(String(arr(doc.publicdate)[0] || ''));
      if (code !== court || sides.length !== 2 || plainKey(sides[1]) !== plainKey(who.surname)) continue;
      const criminal = isCriminalCase(caseName) && /^(?:united states(?: of america)?|usa)$/i.test(sides[0]);
      const civil = !criminal && isCivilEnforcement(caseName);
      if (!criminal && !civil) continue;
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
        severity: criminal ? 'high' : 'medium',
        data: { caseNumber: null, court: courtName, archiveId: String(doc.identifier), ...(civil ? { kind: 'civil enforcement' } : {}) },
        match: 'possible',
        matchReasons: [criminal
          ? `criminal case in the district and year of the charges against ${who.name}; the case title gives only the surname`
          : `civil enforcement case by a market regulator in the district and year of the charges against ${who.name}; the case title gives only the surname`],
      });
      if (finding) findings.push(finding);
    }
  }
  return { findings: findings.slice(0, 4), partial };
}

export const courtRecordsOpenConnector = {
  id: IA_ID,
  label: IA_LABEL,
  kinds: ['subject', 'alias', 'company'],
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
    const partial = [];
    const done = (findings) => (partial.length ? { findings, threads: [], notes, partial: uniq(partial) } : { findings, threads: [], notes });
    if (task.kind === 'company') {
      const company = clean(task.value);
      // Every known name of the company: "Ramp" and "Ramp Business Corporation" are searched alike.
      const cores = uniq(companyNames(ctx.subject, company).names.map(companyCore)).slice(0, 3);
      let docs = [];
      let cut = false;
      for (const core of cores) {
        const first = await iaTitles([core], ctx);
        let found = first.docs;
        // A long list is mostly other parties with the word in their name: ask again for the titles that also carry the surname.
        if (first.total > first.docs.length) {
          cut = true;
          if (who.surname) found = [...(await iaTitles([core, who.surname], ctx, 50)).docs, ...found];
        }
        docs = [...docs, ...found];
      }
      if (cut) partial.push(`US federal case titles naming ${company} (the first 100 of a longer list read)`);
      const seen = new Set();
      const read = docs.filter((d) => !seen.has(d.identifier) && seen.add(d.identifier)).map((d) => iaFinding(d, ctx, who, { company, tie: task.tie || null })).filter((r) => r.finding);
      read.sort((a, b) => Number(b.surnameSide) - Number(a.surnameSide));
      if (read.length > 8) notes.push(`The archive holds ${read.length} federal dockets with ${company} in the case title; 8 are listed.`);
      return done(read.slice(0, 8).map((r) => r.finding));
    }
    // Given name AND surname, not the quoted name: dockets carry the legal middle name ("Elizabeth A Holmes"),
    // and sameName still requires the person's own name part for part.
    const forms = uniq(searchNames(who).map((n) => { const w = n.split(' ').filter(Boolean); return w.length >= 2 ? `title:(${quoted(w[0])} AND ${quoted(w[w.length - 1])})` : ''; })).filter(Boolean);
    const rows = 100;
    const { total, docs } = forms.length ? await iaTitles([], ctx, rows, { raw: forms.length > 1 ? `(${forms.join(' OR ')})` : forms[0] }) : await iaTitles([who.name], ctx, rows);
    if (total > docs.length) {
      notes.push(`The archive lists ${total} federal case titles with ${who.given} and ${who.surname}; the first ${docs.length} were read.`);
      partial.push(`US federal case titles (${docs.length} of ${total} read)`);
    }
    const charges = chargeDistricts(ctx);
    const read = docs.map((d) => iaFinding(d, ctx, who, { charges }));
    if (read.some((r) => r.skip === 'personal-bankruptcy')) notes.push(`Personal bankruptcy cases under the name ${who.name} are reported only when the record also names a company tied to them; none found here did.`);
    notes.push('Only case titles were searched (a public copy of federal dockets); most cases are titled by surname, so a case can exist without appearing here.');
    const named = read.map((r) => r.finding).filter(Boolean).slice(0, 8);
    const charged = await chargedDockets(ctx, who, new Set(docs.map((d) => d.identifier))).catch(() => {
      notes.push(`The search for criminal dockets in the district that charged ${who.name} did not answer.`);
      partial.push('US federal dockets in the charging district (did not answer)');
      return { findings: [], partial: [] };
    });
    partial.push(...charged.partial);
    return done([...named, ...charged.findings]);
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

const DOJ_PAGE = 25;
const DOJ_MAX_PAGES = 3;
// A further page is asked for only while this much time is left, so paging never costs the lookup itself.
const DOJ_PAGE_MARGIN_MS = 8000;

async function dojPage(titleFilter, page, ctx) {
  const url = `${DOJ_URL}?parameters%5Btitle%5D=${encodeURIComponent(titleFilter)}&sort=date&direction=DESC&pagesize=${DOJ_PAGE}&page=${page}&fields=title,date,url,number,component,topic,teaser,body`;
  const json = await getJson(url, { deadline: ctx.deadline, timeoutMs: 15000 });
  if (!json || !Array.isArray(json.results)) throw new HttpError('The Justice Department release search returned something unexpected', { url });
  return { count: Number(json.metadata?.resultset?.count) || json.results.length, results: json.results };
}

/** Releases whose headline carries the filter, newest first, paged while time allows: { count, read, releases, unfiltered }. */
async function dojReleases(titleFilter, ctx) {
  const first = await dojPage(titleFilter, 0, ctx);
  const { count } = first;
  // The service ignores a filter it does not understand and returns every release: never read that as a match.
  if (count > 3000) return { count, read: 0, releases: [], unfiltered: true };
  const results = [...first.results];
  for (let page = 1; page < DOJ_MAX_PAGES && results.length < count && first.results.length >= DOJ_PAGE; page += 1) {
    if (ctx.deadline && Date.now() + DOJ_PAGE_MARGIN_MS > ctx.deadline) break;
    const next = await dojPage(titleFilter, page, ctx).catch(() => null);
    if (!next || !next.results.length) break;
    results.push(...next.results);
  }
  return { count, read: results.length, releases: results.filter((r) => r && r.title && /^https?:\/\//.test(String(r.url || ''))), unfiltered: false };
}

/** The parts of a release the checks read. */
function readRelease(r) {
  const title = plain(r.title);
  const teaser = plain(r.teaser);
  const body = plain(r.body);
  const seconds = Number(r.date);
  const caseNumber = caseNumberIn(`${title} ${teaser} ${body}`);
  return {
    title, teaser, body,
    url: String(r.url),
    date: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString().slice(0, 10) : isoDay(r.date),
    data: {
      ...(clean(r.number) ? { releaseNumber: clean(r.number) } : {}),
      ...(caseNumber ? { caseNumber } : {}),
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
  kinds: ['subject', 'alias', 'company', 'associate'],
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
    const partial = [];
    const seen = new Set();
    const fresh = (rel) => !seen.has(rel.url) && Boolean(seen.add(rel.url));
    const search = async (filter) => {
      const { releases, unfiltered, count, read } = await dojReleases(filter, ctx);
      if (unfiltered) {
        notes.push(`The Justice Department search could not be narrowed to "${filter}", so nothing was read from it.`);
        partial.push(`Justice Department releases for "${filter}" (search could not be narrowed)`);
      } else if (count > read) {
        notes.push(`The Justice Department has ${count} releases with "${filter}" in the headline; the newest ${read} were read.`);
        partial.push(`Justice Department releases for "${filter}" (${read} of ${count} read)`);
      }
      return releases.map(readRelease).filter(fresh);
    };
    const done = (out) => (partial.length ? { ...out, partial: uniq(partial) } : out);
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
      return done({ findings: findings.filter(Boolean).slice(0, 6), threads, notes });
    }

    if (template === 'title.company') {
      const company = clean(task.value);
      // Every known name of the company, so "Ramp Business Corporation" headlines are asked for as well as "Ramp".
      const filters = uniq(companyNames(ctx.subject, company).names.map(companyCore)).slice(0, 3);
      for (const filter of filters) {
        for (const rel of await search(filter)) {
          const headline = headlineNaming(rel.title, company, ctx.subject);
          if (!headline) continue;
          const naming = releaseNaming(rel, who);
          // A headline naming a one-word company without its legal form ("Theranos Founder ... Charged") is kept only
          // when the release names the person, or names the company with its legal form in the body.
          const bodyNames = headline === 'strong' || textNamesCompanyStrongly(`${rel.teaser} ${rel.body}`, company, ctx.subject);
          if (headline === 'weak' && !naming && !bodyNames) continue;
          const finding = naming ? aboutSubject(rel, naming) : makeFinding(ctx.subject, {
            ...base, title: rel.title, quote: clip(dropAgeAndTown(rel.teaser || sentencesOf(rel.body)[0] || rel.title), 600), url: rel.url, date: rel.date,
            severity: dojSeverity(`${rel.title} ${rel.teaser}`), data: rel.data, match: 'company',
            matchReasons: [headline === 'strong' ? `${company} is named in the headline` : `${company} is named in the headline and, with its legal form, in the release`],
          });
          if (!finding) continue;
          findings.push(finding);
          if (naming) threads.push(...threadsFromResult(ctx.subject, { title: rel.title, snippet: naming.quote, url: rel.url }, { trusted: finding.match !== 'possible' }));
        }
      }
      return done({ findings: findings.slice(0, 10), threads: usableThreads(threads), notes });
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
    return done({ findings: findings.slice(0, 15), threads: usableThreads(threads), notes });
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

const IAPD_FIRM_SEARCH = 'https://api.adviserinfo.sec.gov/search/firm';
// A company whose name reads like an investment adviser or a fund's manager.
const ADVISER_NAME = /\b(?:capital|partners|partnership|management|advisors?|advisers?|advisory|ventures?|fund|funds|investments?|asset|assets|holdings|equity|gp)\b/i;

/** Investment-adviser firms (Form ADV) with this name: [{ id, name, names, scope, disclosures, secNumber }]. */
async function adviserFirms(name, ctx) {
  const json = await getJson(bcSearchUrl(IAPD_FIRM_SEARCH, name), { deadline: ctx.deadline, timeoutMs: 12000 });
  if (!json || !json.hits || !Array.isArray(json.hits.hits)) throw new HttpError('The SEC adviser firm search returned something unexpected', { url: IAPD_FIRM_SEARCH });
  // The office address the record carries is never read.
  return json.hits.hits.map((h) => h && h._source).filter((h) => h && h.firm_source_id && h.firm_name).map((h) => ({
    id: String(h.firm_source_id),
    name: clean(h.firm_name),
    names: uniq([clean(h.firm_name), ...arr(h.firm_other_names).map((n) => clean(String(n).replace(/\((?:relying adviser|exempt reporting adviser)\)/i, '')))]),
    scope: clean(h.firm_ia_scope),
    disclosures: h.firm_ia_disclosure_fl === 'Y',
    secNumber: clean(h.firm_ia_full_sec_number),
  }));
}

/**
 * A fund or adviser the person runs: its Form ADV record (registration
 * status and whether it reports disclosures). Only for a company tied to the
 * person by a record or given by the user, never for one found by name alone.
 * Several adviser firms of the same name stay possible.
 */
async function adviserFirmLookup(task, ctx) {
  const company = clean(task.value);
  const names = companyNames(ctx.subject, company).names.slice(0, 2);
  const firms = new Map();
  for (const n of names) {
    for (const f of await adviserFirms(n, ctx)) if (f.names.some((x) => names.some((m) => sameCompany(x, m)))) firms.set(f.id, f);
  }
  const list = [...firms.values()];
  if (!list.length) return { findings: [], threads: [], notes: [`No SEC-registered investment adviser named ${company}.`] };
  const ambiguous = list.length > 1;
  const findings = list.slice(0, 3).map((f) => makeFinding(ctx.subject, {
    source: BC_ID,
    sourceLabel: BC_LABEL,
    category: 'regulatory',
    title: `${titleCase(f.name)}: investment adviser record (Form ADV)${f.disclosures ? ', reports disclosures' : ''}`,
    quote: `${titleCase(f.name)}${f.secNumber ? `, SEC file ${f.secNumber}` : ''}: adviser registration ${f.scope ? f.scope.toLowerCase() : 'status not given'}. ${f.disclosures ? 'The firm reports disclosures (regulatory, civil or criminal events) on its Form ADV.' : 'No disclosures reported on the Form ADV.'}`,
    url: `https://adviserinfo.sec.gov/firm/summary/${f.id}`,
    date: null,
    severity: f.disclosures ? 'medium' : 'info',
    data: { firmCrd: f.id, secNumber: f.secNumber || null, disclosures: f.disclosures, status: f.scope || null },
    ...(ambiguous
      ? { match: 'possible', matchReasons: [`${list.length} adviser firms share the name ${company}; verify which is the person's`] }
      : { match: 'company', matchReasons: [`${titleCase(f.name)} is ${company} in the SEC adviser register`] }),
  })).filter(Boolean);
  return { findings, threads: [], notes: [] };
}

/** Rank namesakes by how many of the person's known companies appear among their firms, so the likeliest are read first. */
function firmOverlap(hit, subject) {
  const firms = arr(hit.ind_current_employments).map((e) => clean(e?.firm_name)).filter(Boolean);
  const known = knownCompanies(subject);
  return firms.filter((f) => known.some((c) => partyIsKnownCompany(f, c, subject) || sameCompany(f, c))).length;
}

export const brokerCheckConnector = {
  id: BC_ID,
  label: BC_LABEL,
  kinds: ['subject', 'alias', 'company'],
  prior: 0.4,
  timeoutMs: 20000,
  plan(thread, subject) {
    if (thread.kind === 'company') {
      // Only a fund or adviser tied to the person by more than its name: given by the user, or on a record about them.
      const tied = Boolean(foundedCompany(subject, thread.value, thread.tie));
      return tied && ADVISER_NAME.test(String(thread.value || '')) ? [{ template: 'adviser.firm', prior: 0.35, why: 'the investment adviser record (Form ADV) of a fund or adviser the person runs' }] : [];
    }
    return [{ template: 'registrations.name', prior: 0.4, why: 'broker and investment adviser registrations under the person\'s name' }];
  },
  async run(task, ctx) {
    if (task.kind === 'company') return adviserFirmLookup(task, ctx);
    const who = person(ctx.subject);
    // Registrations are filed under the legal name; the search tolerates "Sam" for "Samuel" but not every short form.
    const query = who.queryNames[who.queryNames.length - 1];
    let iapdFailed = false;
    const [bc, iapd] = await Promise.all([bcHits(BC_SEARCH, query, ctx), bcHits(IAPD_SEARCH, query, ctx).catch(() => { iapdFailed = true; return []; })]);
    const byCrd = new Map();
    for (const h of [...bc, ...iapd]) {
      const names = [recordName(h), ...arr(h.ind_other_names).map(clean)];
      if (!byCrd.has(h.ind_source_id) && names.some((n) => sameName(n, who))) byCrd.set(h.ind_source_id, h);
    }
    // The namesakes who worked at one of the person's known companies are read first.
    const hits = [...byCrd.values()].map((h, i) => ({ h, i, o: firmOverlap(h, ctx.subject) })).sort((a, b) => (b.o - a.o) || (a.i - b.i)).map((x) => x.h);
    const notes = [];
    const partial = [];
    if (iapdFailed) {
      notes.push('The SEC investment adviser search did not answer; only FINRA BrokerCheck was read.');
      partial.push('SEC adviser records (did not answer)');
    }
    if (!hits.length) {
      notes.push(iapdFailed ? 'No broker registration under this name in FINRA BrokerCheck.' : 'No broker or investment adviser registration under this name (most founders were never registered).');
      return partial.length ? { findings: [], threads: [], notes, partial } : { findings: [], threads: [], notes };
    }
    if (hits.length > 2) {
      notes.push(`${hits.length} registered people share the name ${who.name}; the 2 likeliest were read.`);
      partial.push(`Broker and adviser registrations (2 of ${hits.length} people with the name read)`);
    }
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
    return partial.length ? { findings, threads: threads.filter(Boolean), notes, partial } : { findings, threads: threads.filter(Boolean), notes };
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
  kinds: ['subject', 'alias', 'company'],
  prior: 0.3,
  timeoutMs: 30000,
  async run(task, ctx) {
    const who = person(ctx.subject);
    const findings = [];
    const notes = [];
    const partial = [];
    const done = (out) => (partial.length ? { ...out, partial: uniq(partial) } : out);
    const readAll = (label, { total, entries }) => {
      if (total > entries.length) partial.push(`UK Gazette notices for ${label} (${entries.length} of ${total} read)`);
      return entries;
    };
    if (task.kind === 'company') {
      const company = clean(task.value);
      const { names } = companyNames(ctx.subject, company);
      // The whole trading name, not its first word: "T/A Flow Creative" is not Flow. A name ends at a comma,
      // a bracket, a legal form, the next field of the notice or the end of the shown text.
      const namedAs = (core) => new RegExp(`(?:Trading Names?|Previous Names? of Company)s?:[^:]{0,120}?(?<![A-Za-z0-9])(?:T\\/A\\s+)?${escapeRe(core)}\\s*(?=$|[,;)…]|\\.{3}|\\b(?:Ltd|Limited|LLP|PLC)\\b|\\(\\s*Company Number|\\b(?:Trading Names?|Previous Names? of Company|Nature of Business|Company Number|Registered|Principal)\\b)`, 'i');
      const matchable = matchNames(ctx.subject, company);
      const patterns = matchable.map((n) => namedAs(companyCore(n)));
      const seen = new Set();
      const entries = [];
      // Every known name of the company: the name typed and the legal names learned from records tied to the person.
      for (const n of names.slice(0, 3)) entries.push(...readAll(n, await gazetteNotices([n], ctx)));
      for (const n of entries.map(readNotice).filter(Boolean)) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        if (!matchable.some((name) => sameCompany(n.title, name)) && !patterns.some((re) => re.test(n.snippet))) continue;
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
      return done({ findings: findings.slice(0, 10), threads: [], notes });
    }
    // A person: only corporate notices that name them together with a company already tied to them.
    const companies = knownCompanies(ctx.subject).slice(0, 2);
    if (!companies.length) return { findings, threads: [], notes: ['UK Gazette notices are searched for a person only together with a known company (personal insolvency notices are not read).'] };
    const seen = new Set();
    for (const company of companies) {
      // The company's legal name when one is known: notices print the registered name.
      const named = companyNames(ctx.subject, company);
      const label = named.legal[0] || companyCore(company);
      const entries = readAll(`${who.name} and ${label}`, await gazetteNotices([who.name, label], ctx));
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
    return done({ findings: findings.slice(0, 10), threads: [], notes });
  },
};

/* ------------------------------------------------------------------ 6a. UK court judgments (Find Case Law) */

const TNA_ID = 'uk-case-law';
const TNA_LABEL = 'UK court judgments (National Archives Find Case Law)';
const TNA_FEED = 'https://caselaw.nationalarchives.gov.uk/atom.xml';
// Family, immigration and employment matters of a namesake are private lives, not diligence.
const PRIVATE_COURTS = /family|immigration|asylum|employment|court of protection|mental health|special educational|social entitlement|care standards/i;

const TNA_PAGE = 20;
async function caseLawFeed(phrases, party, ctx) {
  const url = `${TNA_FEED}?query=${encodeURIComponent(phrases.map(quoted).join(' '))}&party=${encodeURIComponent(party)}&order=-date&per_page=${TNA_PAGE}`;
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
  kinds: ['subject', 'alias', 'company'],
  prior: 0.35,
  timeoutMs: 20000,
  async run(task, ctx) {
    const who = person(ctx.subject);
    const findings = [];
    const notes = [];
    const partial = [];
    const done = (out) => (partial.length ? { ...out, partial: uniq(partial) } : out);
    // The feed gives no total: a full page means there may be more.
    const feed = async (phrases, party, label) => {
      const list = await caseLawFeed(phrases, party, ctx);
      if (list.length >= TNA_PAGE) partial.push(`UK court judgments for ${label} (newest ${TNA_PAGE} read)`);
      return list;
    };
    if (task.kind === 'company') {
      const company = clean(task.value);
      const seenUrls = new Set();
      // Every known name of the company: the name typed and the legal names learned from records tied to the person.
      for (const name of companyNames(ctx.subject, company).names.slice(0, 3)) {
      for (const j of await feed([name], companyCore(name), name)) {
        if (seenUrls.has(j.url)) continue;
        seenUrls.add(j.url);
        const parties = caseParties(j.title);
        const party = [...parties.people, ...parties.asides].find((p) => partyIsKnownCompany(p, company, ctx.subject));
        if (!party) continue;
        const named = parties.people.find((p) => sameName(p, who));
        const f = judgmentFinding(j, ctx, {
          severity: isUkCriminal(j.title) ? 'high' : 'medium',
          ...(named ? { matchText: `${who.name} | ${j.title} | ${company}` } : { match: 'company', matchReasons: [`${party} is a party`] }),
        });
        if (f) findings.push(f);
      }
      }
      return done({ findings: findings.slice(0, 10), threads: [], notes });
    }
    const seen = new Set();
    const companies = knownCompanies(ctx.subject).slice(0, 1);
    // With a known company first: judgments whose full text names both (the search ANDs quoted phrases).
    for (const company of companies) {
      const label = companyNames(ctx.subject, company).legal[0] || companyCore(company);
      for (const j of await feed([who.name, label], who.surname, `${who.name} and ${label}`)) {
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
    for (const j of await feed([who.name], who.surname, who.name)) {
      if (seen.has(j.url)) continue;
      const parties = caseParties(j.title);
      if (!parties.people.some((p) => sameName(p, who))) continue;
      const company = namesKnownCompany(ctx.subject, j.title);
      if (!company && (PRIVATE_COURTS.test(j.court) || privateCase(j.title))) { privateSkipped += 1; continue; }
      const f = judgmentFinding(j, ctx, { severity: isUkCriminal(j.title) ? 'high' : 'medium', matchText: `${who.name} | ${j.title}` });
      if (f) findings.push(f);
    }
    if (privateSkipped) notes.push(`${plural(privateSkipped, 'family, immigration or employment judgment')} under the same name ${privateSkipped === 1 ? 'was' : 'were'} left out: nothing in ${privateSkipped === 1 ? 'it' : 'them'} ties ${privateSkipped === 1 ? 'it' : 'them'} to ${who.name}'s companies.`);
    return done({ findings: findings.slice(0, 12), threads: [], notes });
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

const FR_REGISTER = 'https://recherche-entreprises.api.gouv.fr/search';
// A lookup the check's own clock cut short is run again by the loop, so it is passed on, not read as a failed register.
const cutShort = (error) => error?.code === 'deadline' || /^Out of time/.test(String(error?.message || ''));
const SIREN_RE = /^\d{9}$/;

/**
 * SIRENs already on records of this check that are tied to the company: a
 * French company register entry (fr-companies) or an LEI record about it,
 * graded above a bare name match. The surest source, and it costs no request.
 */
function tiedSirens(ctx, company) {
  let list = [];
  try { list = typeof ctx.findings === 'function' ? ctx.findings() : ctx.findings; } catch { list = []; }
  const names = matchNames(ctx.subject, company);
  const out = [];
  for (const f of Array.isArray(list) ? list : []) {
    if (!f || !['fr-companies', 'lei-register'].includes(f.source) || !['confirmed', 'likely', 'company'].includes(f.match)) continue;
    const siren = clean(f.data?.siren || f.data?.registeredAs || '').replace(/\s/g, '');
    if (!SIREN_RE.test(siren)) continue;
    const named = clean(f.data?.company || f.data?.legalName || f.title);
    if (names.some((n) => sameCompany(named, n) || textNamesCompany(named, n) || companyMention(n, named).named)) out.push(siren);
  }
  return uniq(out);
}

/**
 * French company numbers (SIREN) for a company, under every known name:
 * first from records already tied to it, then from the LEI register, then
 * from the French company register itself (most small French companies have
 * no LEI). Returns { sirens, failed } where `failed` names registers that did not answer.
 */
async function sirensFor(company, ctx) {
  if (/^\d{3}\s?\d{3}\s?\d{3}$/.test(company)) return { sirens: [company.replace(/\s/g, '')], failed: [] };
  const tied = tiedSirens(ctx, company);
  if (tied.length) return { sirens: tied.slice(0, 3), failed: [] };
  const names = matchNames(ctx.subject, company).slice(0, 3);
  const key = names.map(plainKey).join('|');
  if (sirenCache.has(key)) return { sirens: sirenCache.get(key), failed: [] };
  const failed = [];
  const fits = (n) => names.some((m) => sameCompany(n || '', m));
  const readLei = (json) => arr(json?.data).map((r) => r?.attributes?.entity).filter((e) => e && fits(e.legalName?.name))
    .map((e) => clean(e.registeredAs).replace(/\s/g, '')).filter((s) => SIREN_RE.test(s));
  const askLei = async (filter) => {
    const json = await getJson(`${GLEIF}?${filter}&filter%5Bentity.legalAddress.country%5D=FR&page%5Bsize%5D=10`, { deadline: ctx.deadline, timeoutMs: 12000, accept: 'application/vnd.api+json,application/json' });
    if (!json || !Array.isArray(json.data)) throw new HttpError('The LEI register returned something unexpected', { url: GLEIF });
    return readLei(json);
  };
  let sirens = [];
  try {
    for (const n of names) {
      sirens.push(...await askLei(`filter%5Bentity.legalName%5D=${encodeURIComponent(n)}`));
      if (sirens.length) break;
    }
    if (!sirens.length) sirens.push(...await askLei(`filter%5Bfulltext%5D=${encodeURIComponent(names[0] || company)}`));
  } catch (error) {
    if (cutShort(error)) throw error;
    failed.push('LEI register');
  }
  if (!sirens.length) {
    // The French company register: companies only (a sole trader's entry is a person's own affairs), and only
    // where the registered name, full name or acronym is a known name of the company.
    try {
      for (const n of names.slice(0, 2)) {
        const json = await getJson(`${FR_REGISTER}?${new URLSearchParams({ q: n, per_page: '10' })}`, { deadline: ctx.deadline, timeoutMs: 9000 });
        if (!Array.isArray(json?.results)) throw new HttpError('The French company register returned something unexpected', { url: FR_REGISTER });
        for (const r of json.results) {
          const siren = String(r?.siren || '').replace(/\D/g, '');
          if (!SIREN_RE.test(siren) || /^1/.test(String(r?.nature_juridique || '')) || !r?.nom_raison_sociale) continue;
          if ([r.nom_raison_sociale, r.nom_complet, r.sigle].some((x) => x && fits(clean(x)))) sirens.push(siren);
        }
        if (sirens.length) break;
      }
    } catch (error) {
      if (cutShort(error)) throw error;
      failed.push('French company register');
    }
  }
  sirens = uniq(sirens).slice(0, 3);
  if (!failed.length) {
    if (sirenCache.size > 200) sirenCache.delete(sirenCache.keys().next().value);
    sirenCache.set(key, sirens);
  }
  return { sirens, failed };
}

/** Is the company tied to France in this check (a French register record, or a .fr domain)? */
function tiedToFrance(ctx, company) {
  let list = [];
  try { list = typeof ctx.findings === 'function' ? ctx.findings() : ctx.findings; } catch { list = []; }
  if ((Array.isArray(list) ? list : []).some((f) => f && f.source === 'fr-companies' && f.match !== 'possible')) return true;
  return companyNames(ctx.subject, company).domains.some((d) => /\.fr$/i.test(d));
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
    const { sirens, failed } = await sirensFor(company, ctx);
    if (!sirens.length) {
      if (failed.length) {
        return { findings: [], threads: [], notes: [`The ${failed.join(' and the ')} did not answer, so ${company}'s French company number could not be looked up and the French bulletin was not searched.`], partial: ['French bulletin (company number not found: a register did not answer)'] };
      }
      const note = `${company} was not found as a French company in the French company register or the LEI register, so the French bulletin was not searched.`;
      // A company known to be French but not found is a gap, never a clean result.
      return tiedToFrance(ctx, company)
        ? { findings: [], threads: [], notes: [note], partial: ['French bulletin (the French company number was not found)'] }
        : { findings: [], threads: [], notes: [note] };
    }
    const where = `(${sirens.map((s) => `registre:"${s}"`).join(' or ')}) and (familleavis_lib in (${BD_FAMILIES.map((f) => `"${f}"`).join(',')}) or search(modificationsgenerales,"dissolution"))`;
    const url = `${BD_RECORDS}?where=${encodeURIComponent(where)}&order_by=${encodeURIComponent('dateparution desc')}&limit=20&select=${encodeURIComponent(BD_FIELDS)}`;
    const json = await getJson(url, { deadline: ctx.deadline, timeoutMs: 15000 });
    if (!json || !Array.isArray(json.results)) throw new HttpError('The BODACC search returned something unexpected', { url: BD_RECORDS });
    const findings = json.results.map((r) => bodaccFinding(r, ctx, company)).filter(Boolean);
    const notes = findings.length ? [] : [`No insolvency, sale or dissolution notice for ${company} (SIREN ${sirens.join(', ')}) in the French bulletin.`];
    const total = Number(json.total_count) || json.results.length;
    if (total > json.results.length) {
      notes.push(`The French bulletin holds ${total} such notices for ${company}; the newest ${json.results.length} were read.`);
      return { findings: findings.slice(0, 12), threads: [], notes, partial: [`French bulletin (${json.results.length} of ${total} notices read)`] };
    }
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
  // Every page of that site says "enforcement": only the result cards, or the site's own empty-result wording,
  // show that the search really answered. Anything else (a new layout, a maintenance page) is a failure, not "no match".
  if (!/class="[^"]*\bo-post-preview\b/i.test(html) && !/no results based on your filter selections/i.test(html)) throw new HttpError('The CFPB enforcement search returned an unexpected page', { url });
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
  kinds: ['subject', 'alias', 'company'],
  prior: 0.3,
  timeoutMs: 25000,
  async run(task, ctx) {
    const who = person(ctx.subject);
    const findings = [];
    const base = { source: EN_ID, sourceLabel: EN_LABEL, category: 'regulatory' };
    const notes = [];
    const partial = [];
    /** Both agencies are asked; one that fails is reported as partial, both failing is a failed lookup. */
    const both = async (term) => {
      const [cftc, cfpb] = await Promise.allSettled([cftcReleases(term, ctx), cfpbActions(term, ctx)]);
      if (cftc.status === 'rejected' && cfpb.status === 'rejected') throw cftc.reason;
      for (const [r, label] of [[cftc, 'CFTC'], [cfpb, 'CFPB']]) {
        if (r.status === 'rejected') { notes.push(`The ${label} search did not answer for "${term}".`); partial.push(`${label} enforcement actions (did not answer)`); }
      }
      return [...(cftc.status === 'fulfilled' ? cftc.value : []), ...(cfpb.status === 'fulfilled' ? cfpb.value : [])];
    };
    const done = (out) => (partial.length ? { ...out, partial: uniq(partial) } : out);
    if (task.kind === 'company') {
      const company = clean(task.value);
      const seen = new Set();
      // Every known name of the company: the name typed and the legal names learned from records tied to the person.
      for (const core of uniq(companyNames(ctx.subject, company).names.map(companyCore)).slice(0, 2)) {
        for (const r of await both(core)) {
          if (seen.has(r.url)) continue;
          seen.add(r.url);
          // The CFTC search reads release bodies and the CFPB one descriptions: keep only actions with the company in the title.
          if (!isAction(r)) continue;
          const headline = headlineNaming(r.title, company, ctx.subject);
          if (!headline) continue;
          const text = `${r.title} ${r.summary || ''}`;
          const named = namesPerson(text, who);
          // A one-word name without its legal form ("Judgment Against FTX and Alameda"): the company's own only when
          // the description names it with its legal form; otherwise kept, but as a possible match to verify.
          const strong = headline === 'strong' || textNamesCompanyStrongly(r.summary || '', company, ctx.subject);
          const f = makeFinding(ctx.subject, {
            ...base, title: `${r.agency}: ${r.title}`, quote: r.summary || r.title, url: r.url, date: r.date,
            severity: enforcementSeverity(text), data: { agency: r.agency },
            ...(named ? { matchText: `${r.title} | ${r.summary || ''}` }
              : strong ? { match: 'company', matchReasons: [`${company} is named in the title`] }
                : { match: 'possible', matchReasons: [`the title names ${company} without a legal form; verify it is the same company`] }),
          });
          if (f) findings.push(f);
        }
      }
      return done({ findings: findings.slice(0, 10), threads: [], notes });
    }
    // The CFPB names individuals in its action titles too ("... and Jane Roe"), so both agencies are asked.
    for (const r of await both(who.name)) {
      if (!isAction(r) || !namesPerson(r.title, who)) continue;
      const f = makeFinding(ctx.subject, {
        ...base, title: `${r.agency}: ${r.title}`, quote: r.summary || r.title, url: r.url, date: r.date,
        severity: enforcementSeverity(`${r.title} ${r.summary || ''}`), data: { agency: r.agency }, matchText: `${r.title} | ${r.summary || ''}`,
      });
      if (f) findings.push(f);
    }
    return done({ findings: findings.slice(0, 10), threads: [], notes });
  },
};

export const COURT_CONNECTORS = [
  courtDocketsConnector, courtRecordsOpenConnector, dojConnector, brokerCheckConnector,
  ukGazetteConnector, ukCaseLawConnector, bodaccConnector, enforcementActionsConnector,
];

// A record found only under another name of the person the user did not type is 'likely' at most (alias.js).
for (const c of [courtDocketsConnector, courtRecordsOpenConnector, dojConnector, brokerCheckConnector, ukGazetteConnector, ukCaseLawConnector, enforcementActionsConnector]) c.run = withAliasHold(c.run);
