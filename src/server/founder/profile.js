/**
 * The person's professional profile, read out of the records tied to them, with no model: the résumé a
 * public profile page would show (roles with years, education with degree and field, companies founded,
 * board seats, investments, recognition), the leads worth confirming with the person, a few sentences of
 * background, their public profile links, and the company's own facts (companyFacts.js).
 *
 * Only records graded `confirmed` or `likely` are read (never a name-only match), and every line keeps the
 * ids of the records that state it. In order of trust:
 *   1. structured fields already in records: Wikidata statements, SEC Form D and insider officer roles,
 *      register officer roles with dates, BrokerCheck firms and dates, schema.org Person data, ORCID and
 *      thesis entries, accelerator founder lists, patent assignees (basis "record");
 *   2. the person's own profile text: a LinkedIn search snippet on their own handle, an archived Crunchbase or
 *      X bio, the author or team page under their name, where a fragment without a name is about them;
 *   3. sentences that open on the person (their full name, their first name on a page about them, their
 *      surname in their own encyclopedia article, or "She/He/They" carried from such a sentence) (basis "text").
 * Every match is guarded: a job, school, venture, board seat or investment named after somebody else in the
 * sentence ("co-founded Ramp with Karim Atiyeh, who previously worked at Goldman Sachs") is that person's.
 * "Acquired by X" is an outcome of the venture, never an employer. A role is current only when the newest
 * dated record tied to the person says so; "CEO" is not read inside "co-CEO".
 *
 * Also used by the page reader (sources/pages.js) to pick the sentences of a page worth keeping, and by
 * profileModel.js (the shared guard and sentence rules).
 */
import { profileFromUrl, handleFitsSubject } from './extract';
import { privacyReason } from './guardrails';
import { buildCompanyFacts, startsWithCompany } from './companyFacts';
import { companyKeyStrict, isOrdinaryWordCompany } from './names';

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Sentences of a text (also split on line breaks and the "·" and "|" a search snippet uses between fields). */
export function sentencesOf(text) {
  return String(text || '')
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Inc|Corp|Co|Ltd|St|Jr|Sr|vs|U\.S|B\.S|B\.A|M\.S|M\.A|Ph\.D|M\.B\.A|Acq|acq)\./g, '$1․')
    .split(/(?<=[.!?])\s+(?=["“'(]?[A-Z0-9])|\n+|\s+[·|]\s+/)
    .map((s) => tidy(s.replace(/․/g, '.')))
    .filter((s) => s.length >= 12);
}

const EDU_WORD = /\b(?:graduat\w*|studied|studying|educated|degrees?|bachelor'?s?|master'?s?|B\.?S\.?c?|B\.?A\.?|A\.?B\.?|M\.?S\.?c?|M\.?B\.?A\.?|Ph\.?D\.?|J\.?D\.?|doctorate|alum(?:na|nus|ni)?|attended|enrolled|dropped out|drop-?out|majored|major(?:ing)? in|computer science|CS|economics|engineering|classmates?|college|undergrad\w*|education|school)\b/i;
const NAMED_SCHOOLS = 'MIT|Stanford|Harvard|Wharton|Yale|Princeton|Caltech|UC Berkeley|Berkeley|UCLA|UCSD|USC|NYU|Oxford|Cambridge|INSEAD|Columbia|Cornell|Dartmouth|Brown|UPenn|Penn|Duke|Carnegie Mellon|Georgia Tech|Waterloo|Northwestern|Kellogg|Booth|Sloan|Haas|McGill|IIT [A-Z][a-z]+|École Polytechnique|Ecole Polytechnique|HEC Paris|ENS|ESSEC|LSE|Imperial College(?: London)?|ETH Zurich|EPFL|Tsinghua|Technion';
const SCHOOL_SRC = `(?:(?:The )?University of [A-Z][\\p{L}.'-]+(?:(?:,| at)? [A-Z][\\p{L}.'-]+){0,2}`
  + `|(?:[A-Z][\\p{L}.'&-]+ ){1,4}(?:University|College|Institute of Technology|Business School|Law School|School of (?:Business|Law|Management|Engineering|Medicine|Economics|Design))`
  + `|${NAMED_SCHOOLS})`;
const SCHOOL = new RegExp(`(?<![\\p{L}\\p{N}])${SCHOOL_SRC}(?![\\p{L}\\p{N}])`, 'gu');

const TITLE = '(?:co-?\\s?founder|founder|founding (?:partner|engineer)|co-?\\s?CEO|(?<![Cc]o[-\\s]?)CEO|CTO|COO|CFO|CPO|CRO|chief [a-z]+ officer|president|managing (?:partner|director)|general partner|executive chair(?:man|woman|person)?|chair(?:man|woman|person)?)';
const TITLES = `${TITLE}(?:\\s*(?:and|&|,|/)\\s*${TITLE}){0,3}`;
const ROLE = "[\\p{L}][\\p{L}\\s'’/&-]{2,48}?";
const NOT_ORG = new Set(['the', 'a', 'an', 'she', 'he', 'they', 'her', 'his', 'their', 'i', 'we', 'it', 'this', 'that', 'in', 'on', 'at', 'as', 'ceo', 'cto', 'coo', 'cfo', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'linkedin', 'twitter', 'series', 'forbes', 'today', 'now', 'home', 'ai', 'saas', 'api', 'b2b', 'new york', 'san francisco', 'london', 'silicon valley', 'us', 'usa', 'america', 'europe', 'previously', 'before', 'after', 'yc', 'some', 'one', 'two']);
const trimOrg = (s) => tidy(String(s).replace(/(?:\s+(?:of|and|&|de|for|the))+$/i, '').replace(/[,'’]+$/, '').replace(/(?<!\b(?:Inc|Corp|Co|Ltd|Jr|Sr|St))\.$/, ''));
const BIO_WORD = new RegExp(`${EDU_WORD.source}|\\b(?:previously|formerly|prior to|before (?:founding|starting|launching|co-?founding|joining)|worked|career|joined|co-?founded|founded|started|launched|led|built|investor|engineer|analyst|banker|consultant|product manager|${TITLE})\\b`, 'i');
const CONTINUES = /^["“'(]?(?:She|He|They|Prior to|Before|Previously|Earlier|After)\b/;
// Family and childhood are not part of a professional profile, and a relative's career is not the person's.
const KIN = /\b(?:husband|wife|spouse|partner'?s|boyfriend|girlfriend|fianc[ée]e?|father|mother|dad|mom|parents?|son|daughter|brother|sister|sibling|uncle|aunt|cousin|grandfather|grandmother|children|kids?|childhood|grew up|born (?:in|on|to)|raised (?:in|by)|when (?:she|he|they) (?:was|were) (?:\d+|[a-z]+) years)\b/i;
const LEAD_IN = /^["“'(]?(?:(?:Before|Prior to|After|Previously|Earlier|Formerly|In \d{4}|Today|Now)\b[^,]{0,70},\s*)?/;

const THIS_YEAR = new Date().getUTCFullYear();
const year = (y) => { const n = Number(String(y ?? '').slice(0, 4)); return Number.isInteger(n) && n >= 1950 && n <= THIS_YEAR + 1 ? n : null; };
/**
 * The years printed right after a name in a sentence: "Stripe (2015–2017)", "Stripe, 2015 - present",
 * "Stripe from 2015 to 2017", "Paribus (2014 - Feb 2019)". Only a span beside the name counts; a year
 * elsewhere in the sentence is another fact.
 * @returns {{ from: number|null, to: number|null, current: boolean }|null}
 */
export function spanAfter(sentence, name) {
  const s = String(sentence || '');
  const i = s.toLowerCase().indexOf(String(name || '').toLowerCase());
  if (!name || i < 0) return null;
  const after = s.slice(i + String(name).length, i + String(name).length + 50);
  const MON = '(?:[A-Z][a-z]{2,8}\\.?\\s+)?';
  const m = after.match(new RegExp(`^\\s*(?:[(,]\\s*|\\s+from\\s+)${MON}(\\d{4}|\\?)\\s*(?:[-–—]|to|until)\\s*${MON}(\\d{4}|present|now|today|current|\\?)\\s*\\)?`, 'i'));
  if (!m) return null;
  const from = m[1] === '?' ? null : year(m[1]);
  const open = /^(?:present|now|today|current)$/i.test(m[2]);
  const to = open || m[2] === '?' ? null : year(m[2]);
  if (!from && !to) return null;
  if ((m[1] !== '?' && !from) || (from && to && to < from)) return null;
  return { from, to, current: open };
}

const STREET = /\b(?:street|st\.|avenue|ave\.?|road|rd\.?|boulevard|blvd|lane|drive|apt|apartment|suite|unit|floor|po box|zip|postcode|home|house)\b/i;
/** A place a person is based: a city or metro area, never an address (no numbers, no street, a few words at most). */
export function placeOnly(text) {
  const t = tidy(String(text || '').replace(/[.,;]+$/, ''));
  if (t.length < 2 || t.length > 48 || /\d|@/.test(t) || STREET.test(t) || t.split(/[\s,]+/).filter(Boolean).length > 6) return null;
  if (!/^[A-Z]/.test(t)) return null;
  return t;
}

/** The text with the person's own name blanked out, so only other people's names are left to find. */
export function maskSubject(subject, text) {
  const t = String(text || '');
  const at = typeof subject?.hasName?.positions === 'function' ? subject.hasName.positions(t) : null;
  if (at) {
    let out = '';
    let from = 0;
    for (const p of at) { out += `${t.slice(from, p.start)} • `; from = p.end; }
    return out + t.slice(from);
  }
  const vs = (subject?.variants || []).filter(Boolean);
  return vs.length ? t.replace(new RegExp(vs.map(esc).join('|'), 'gi'), ' • ') : t;
}

// Capitalised words that make a run an organisation, school, place, title or date rather than a person
const NOT_PERSON = new Set(`inc corp corporation llc ltd co company companies school schools university universities college institute academy capital partners ventures venture labs lab group bank banking fund funds foundation technologies technology tech systems holdings consulting business street code who under forbes fortune inc. google microsoft amazon meta apple facebook netflix oracle salesforce stripe ibm intel nvidia tesla uber airbnb mckinsey bain deloitte accenture goldman sachs morgan stanley jpmorgan chase credit suisse new san los las santa saint st north south east west united states state york francisco angeles city valley silicon bay area america american americas europe european asia africa india china london paris berlin boston texas california washington center centre health media network networks software studio studios global international research association society council board committee club program programme office department ministry government agency hospital medical sciences science engineering management law review times journal news post magazine week day summit conference award awards prize list series january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday previously before after prior earlier today now in at the she he they her his their a an and of for chief officer executive vice president director senior junior head manager product engineer partner founder co-founder cofounder ceo cto coo cfo cpo cro vp svp evp general managing principal associate analyst fellow member chair chairman chairwoman professor dr mr mrs ms phd mba bs ba ms ma jd md business administration computer finance economics arts one security alarm services service industries industry motors motor aircraft energy financial securities shopping studies`.split(/\s+/));
// someone else brought into the sentence: hired, recruited, a co-founder or colleague of theirs
export const HANDOFF = /(?<!\b(?:was|were|been|be|being|is|are|got|get|gets)\s+)\b(?:hired|hires|hiring|recruit(?:ed|s|ing)?|appoint(?:ed|s|ing)|brought (?:on|in)|poach(?:ed|es|ing)?|introduc(?:ed|es|ing)|married|mentor(?:ed|s|ing))\b/i;
export const RELATION = /(?:['’]s?|\b(?:her|his|their|our|its|my))\s+(?:[\p{L}-]+\s+){0,2}(?:co-?\s?founders?|cofounders?|colleagues?|partners?|husband|wife|spouse|boss|manager|mentors?|mentees?|teammates?|friends?|peers?|predecessor|successor|employees?|hires?|students?|advisors?|deputy|assistant|report)\b/iu;
export const NAME_RUN = /(?<![\p{L}\p{N}'’-])[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){1,2}(?![\p{L}\p{N}'’-])/gu;
const PERSON_BEFORE = /(?:\b(?:and|with|alongside|by|met|hired|recruited|appointed|named|told|said|says|according to|thanks|thanked|co-?\s?founders?|cofounders?|colleagues?|partners?|husband|wife|boss|manager|mentor|friend|CEO|CTO|COO|CFO|founder|president|engineer|investor|director)|&)\s*,?\s*$/i;
const PERSON_AFTER = /^(?:['’]s\b|\s*,\s*(?:a|an|the|who|whose|our|her|his|their|its|former|then|now)\b|\s+(?:and (?:she|he|they|her|him)|studied|studies|worked|works|was|is|joined|joins|led|leads|served|serves|earned|graduated|holds|held|spent|previously|formerly|had|has|attended|received|ran|runs|heads|headed|said|says|told)\b)/i;
export const isPersonRun = (run) => !run.split(/\s+/).some((w) => NOT_PERSON.has(w.toLowerCase().replace(/['’]s$/, '').replace(/[.'’]+$/, '')));

/**
 * Does a sentence (the person's own name aside) bring in somebody else, so that a "He/She" after it may be them?
 * A person-like name ("Bob Smith"), someone hired or recruited, or a co-founder or colleague of theirs.
 */
export function bringsInSomeoneElse(subject, sentence) {
  const m = maskSubject(subject, sentence);
  if (HANDOFF.test(m) || RELATION.test(m)) return true;
  for (const x of m.matchAll(NAME_RUN)) {
    if (!isPersonRun(x[0])) continue;
    const before = m.slice(Math.max(0, x.index - 40), x.index);
    const after = m.slice(x.index + x[0].length, x.index + x[0].length + 30);
    // a capitalised pair is a person only where a person stands: "and Bob Smith", "hired Bob Smith",
    // "co-founder Bob Smith", "Bob Smith, a ...", "Bob Smith joined ...", "Bob Smith's"; never "the Israeli Navy"
    if (PERSON_BEFORE.test(before) || PERSON_AFTER.test(after)) return true;
  }
  return false;
}

// Words that bring another person in just before a claim: "met Karim, ...", "interviewed by Jane Doe", "investors
// include Keith Rabois", "co-founded Ramp with Karim Atiyeh". The claim after them is that person's.
const OTHER_LEAD = /\b(?:met|meets|meeting|interviewed by|investors? include|backed by|joined by|alongside|with|hired|recruited|told|according to|thanked|introduced)\s+(?:[a-z]+\s+){0,2}[A-Z]/;
const OTHER_WHO = /[A-Z][\p{L}'’-]+\s*,\s*(?:who|whose)\b/u;

/**
 * Between the person's last mention and a claim, is the claim tied to somebody else? `before` is the text of the
 * sentence up to the organisation, school or award the claim names. "co-founded Ramp with Karim Atiyeh, who
 * previously worked at", "met Karim Atiyeh, a former engineer at", "hired Jane Doe, who graduated from",
 * "Jane Roe's co-founder Bob Smith studied at". A joint subject ("Jane Roe and Bob Smith worked at") is theirs too.
 * Shared with profileModel.js, which checks a model's reading the same way.
 */
export function leadsToSomeoneElse(subject, before) {
  const m = maskSubject(subject, before);
  // only the words after the person's last mention matter ("Bob Smith hired Jane Roe, who previously worked at")
  const cut = m.lastIndexOf('•');
  const seg = cut >= 0 ? m.slice(cut) : m;
  if (HANDOFF.test(seg) || RELATION.test(seg) || OTHER_LEAD.test(seg) || OTHER_WHO.test(seg)) return true;
  for (const x of seg.matchAll(NAME_RUN)) {
    if (!isPersonRun(x[0])) continue;
    // "Jane Roe and Bob Smith worked at Google": a joint subject, so the fact is hers too
    if (/•\s*(?:and|&)\s*$/.test(seg.slice(0, x.index))) continue;
    return true;
  }
  return false;
}

/**
 * Is the person the one this sentence is about? It must open on them (after an optional "Before founding
 * Acme," lead-in): their full name, "She/He/They", or, where allowed, their first name not followed by
 * someone else's surname, or (in their own encyclopedia article) their surname alone.
 */
export function opensOnSubject(subject, sentence, { firstName = false, surname = false } = {}) {
  const s = String(sentence || '').replace(LEAD_IN, '');
  const head = s.slice(0, 80);
  if (/^(?:She|He|They)\b/i.test(s)) return true;
  const full = String(subject.name || '').trim();
  const parts = full.split(/\s+/);
  const first = parts[0] || '';
  const last = parts[parts.length - 1] || '';
  const firstWords = head.split(/\s+/).slice(0, parts.length + 1).join(' ');
  if (subject.hasName(firstWords)) return true;
  if (surname && last.length >= 3 && new RegExp(`^${esc(last)}(?![\\p{L}\\p{N}])(?!\\s+[A-Z])`, 'u').test(s)) return true;
  return Boolean(firstName && first.length >= 4 && new RegExp(`^${esc(first)}(?![\\p{L}\\p{N}])(?!\\s+(?!and\\b)[A-Z][\\p{L}'’-]+)`, 'u').test(s));
}

/**
 * The sentences of a page that say something about the person's career or
 * education: the ones naming them, and the ones right after that carry on
 * about them ("She previously ...", "Before founding ...").
 * @returns {Array<{ text: string, kind: 'education'|'career' }>}
 */
export function bioSentences(subject, text, { max = 12, aboutThem = false } = {}) {
  const sentences = sentencesOf(text);
  // On a page that is about the person, they are called by their first name ("Shensi and Gil graduated from ...").
  const first = String(subject.name || '').trim().split(/\s+/)[0] || '';
  // never "Jane Smith" for Jane Roe: the first name must not be followed by another surname
  const byFirstName = aboutThem && first.length >= 4 ? new RegExp(`(?<![\\p{L}\\p{N}])${esc(first)}(?![\\p{L}\\p{N}])(?!\\s+(?!and\\b)[A-Z][\\p{L}'’-]+)`, 'u') : null;
  const out = [];
  const seen = new Set();
  let carry = 0; // how many more follow-on sentences may be read after one that names them
  for (const s of sentences) {
    const named = subject.hasName(s) || Boolean(byFirstName && byFirstName.test(s));
    const follows = !named && carry > 0 && CONTINUES.test(s);
    carry = (named || follows) && bringsInSomeoneElse(subject, s) ? 0 : named ? 3 : follows ? carry - 1 : 0;
    if (!(named || follows) || !BIO_WORD.test(s) || s.length > 400 || KIN.test(s) || privacyReason(s)) continue;
    // an attribution line under a quotation ("... — Reference: Acme CEO Jane Roe") says nothing of their career
    if (/[—–-]\s*(?:Reference|Source|Credit)s?\s*:/i.test(s)) continue;
    const key = s.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: s, kind: EDU_WORD.test(s) && SCHOOL.test(s) ? 'education' : 'career' });
    SCHOOL.lastIndex = 0;
    if (out.length >= max) break;
  }
  return out;
}

const TITLE_FORMS = [
  [/co-?\s?founder/i, 'Co-Founder'], [/founding partner/i, 'Founding Partner'], [/founding engineer/i, 'Founding Engineer'], [/\bfounder/i, 'Founder'],
  // "co-CEO" first: "CEO" is never read inside it
  [/\bco-?\s?CEO\b|\bco-?chief executive(?: officer)?/i, 'Co-CEO'],
  [/(?<![Cc]o[-\s]?)\bCEO\b|(?<!co-?)\bchief executive(?: officer)?\b/i, 'CEO'], [/\bCTO\b|chief technology officer/i, 'CTO'], [/\bCOO\b|chief operating officer/i, 'COO'],
  [/\bCFO\b|chief financial officer/i, 'CFO'], [/\bCPO\b|chief product officer/i, 'CPO'], [/\bCRO\b|chief revenue officer/i, 'CRO'],
  [/executive chair(?:man|woman|person)?/i, 'Executive Chairman'], [/chair(?:man|woman|person)?\b/i, 'Chair'], [/president/i, 'President'],
  [/managing partner/i, 'Managing Partner'], [/managing director/i, 'Managing Director'], [/general partner/i, 'General Partner'],
];
/** The standard titles a phrase gives ("Co-Founder & Co-CEO" -> ['Co-Founder', 'Co-CEO']). */
export function titlesIn(span) {
  const found = [];
  let rest = String(span || '');
  for (const [re, label] of TITLE_FORMS) {
    if (re.test(rest)) { found.push(label); rest = rest.replace(new RegExp(re.source, 'gi'), ' '); }
  }
  return found;
}
const FOUNDER_LABELS = new Set(['Co-Founder', 'Founder']);
const FAMILY = { CEO: 'ceo', 'Co-CEO': 'ceo', Chair: 'chair', 'Executive Chairman': 'chair' };
const joinTitles = (list) => (list.length === 2 ? list.join(' and ') : list.join(', '));
/** One title as written, in standard form when the phrase is only standard titles ("Co-Founder, CEO" -> "Co-Founder and CEO"). */
function normTitle(raw) {
  const t = tidy(String(raw || '').replace(/^[,;:\s-]+|[,;:\s-]+$/g, ''));
  if (!t || t.length > 80) return null;
  const labels = titlesIn(t);
  const left = TITLE_FORMS.reduce((acc, [re]) => acc.replace(new RegExp(re.source, 'gi'), ' '), t).replace(/\b(?:and|of|the)\b|[,&/+\s-]+/gi, '');
  if (labels.length && !left) return labels.join(' and ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
const ROLE_WORD = /\b(?:partner|founder|ceo|cto|coo|cfo|president|director|manager|engineer|investor|analyst|associate|principal|vp|vice president|head|lead|chief|officer|advis[eo]r|consultant|professor|researcher|scientist|designer|developer|chair\w*|owner|member|fellow|intern|staff|operator|entrepreneur)\b/i;

/* ----------------------------------------------------------------------- reading organisations */

const ORG_TOKEN = "(?:[A-Z0-9][\\p{L}\\p{N}&.'’-]*|[a-z][A-Z][\\p{L}\\p{N}-]*)";
const ORG_JOIN = "(?:\\s+(?:of|and|&|de|for|the)\\s+|\\s+)";
const ORG_RE = new RegExp(`${ORG_TOKEN}(?:${ORG_JOIN}${ORG_TOKEN}){0,5}(?:,?\\s+(?:Inc|LLC|Ltd|Corp|Co|PBC|GmbH)\\.?)?`, 'uy');
// what may stand before the name: "the Genome Institute", "a startup called Expanse", "an alarm sales company called X"
const ORG_LEAD = /^(?:(?:the|an?|her|his|their|its)\s+(?:[\p{L}$\d.,-]+\s+){0,5}?(?:company|startup|start-up|business|firm|bank|fund|venture|brand|app|agency|nonprofit|organi[sz]ation|lab|studio|platform)\s+(?:called|named)\s+|the\s+(?=[A-Z]))/iu;

/** The organisation that starts at `at` in `s` (after an optional "a startup called"), or null. */
function orgAt(s, at) {
  let i = at;
  const lead = s.slice(i).match(ORG_LEAD);
  if (lead) i += lead[0].length;
  ORG_RE.lastIndex = i;
  const m = ORG_RE.exec(s);
  if (!m) return null;
  return { org: trimOrg(m[0]), start: i, end: i + m[0].length };
}
/** "A, B and C" read as a list of organisations from `at`. */
function orgListAt(s, at) {
  const out = [];
  let i = at;
  for (let n = 0; n < 6; n += 1) {
    const o = orgAt(s, i);
    if (!o) break;
    // "Credit Suisse and Expanse": an "and" inside the run splits two capitalised names
    for (const part of o.org.split(/\s+and\s+(?=[A-Z])/)) out.push({ ...o, org: trimOrg(part) });
    const sep = s.slice(o.end).match(/^\s*(?:,\s*(?:and\s+)?|\s+and\s+|\s*&\s+)(?=[A-Z])/);
    if (!sep) break;
    i = o.end + sep[0].length;
  }
  return out;
}
const URLISH = /https?:|\.(?:com|io|co|ai|dev|org|net|app)\b|@/i;
/** A string that reads like a person's name rather than an organisation ("Erik Torenberg"). */
const looksLikePerson = (org) => /^[A-Z][\p{L}'’-]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][\p{L}'’-]+){1,2}$/u.test(org) && isPersonRun(org);

/** The person's full names, first names and surnames, as words (an organisation is never just these). */
const nameWordsOf = (subject) => new Set(String(subject.name || '').toLowerCase().split(/\s+/));

/** Shared organisation key: case, punctuation and legal forms aside. */
const flat = (s) => ` ${String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
const SUFFIX = /\b(?:the|inc|incorporated|llc|ltd|limited|corp|corporation|co|company|plc|gmbh|ag|sa|lp|llp|group|holdings|usa|us)\b/g;
export const orgKey = (s) => flat(s).replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();

const DEGREE = "(?:B\\.?\\s?A\\.?|A\\.?B\\.?|B\\.?S\\.?c?\\.?|B\\.?Sc\\.?|B\\.?Eng\\.?|BBA|M\\.?A\\.?|M\\.?S\\.?c?\\.?|M\\.?Eng\\.?|M\\.?B\\.?A\\.?|Ph\\.?\\s?D\\.?|J\\.?D\\.?|M\\.?D\\.?|LL\\.?B\\.?|LL\\.?M\\.?|bachelor['’]?s(?: degree)?|master['’]?s(?: degree)?|doctorate|Bachelor of [A-Z][a-z]+(?: [A-Z][a-z]+)?|Master of [A-Z][a-z]+(?: [A-Z][a-z]+)?)";
const DEGREE_NAMES = [[/^B\.?\s?A\.?$|^A\.?B\.?$/i, 'BA'], [/^B\.?S\.?c?\.?$|^B\.?Sc\.?$/i, 'BS'], [/^M\.?B\.?A\.?$/i, 'MBA'], [/^Ph\.?\s?D\.?$/i, 'PhD'], [/^J\.?D\.?$/i, 'JD'], [/^M\.?S\.?c?\.?$/i, 'MS'], [/^M\.?A\.?$/i, 'MA'], [/^M\.?D\.?$/i, 'MD'], [/^bachelor/i, "Bachelor's"], [/^master['’]?s/i, "Master's"]];
const normDegree = (d) => { const t = tidy(d).replace(/\s+degree$/i, ''); for (const [re, label] of DEGREE_NAMES) if (re.test(t)) return label; return t || null; };
const FIELD = "[A-Za-z][A-Za-z&'’ ,-]{1,70}?";

/** Degree, field and years a sentence gives beside a school. */
function schoolDetails(s, school, at) {
  const out = { degree: null, field: null, from: null, to: null, note: null };
  const before = s.slice(Math.max(0, at - 120), at);
  const after = s.slice(at + school.length, at + school.length + 120);
  let m = before.match(new RegExp(`(${DEGREE})(?:\\s+degree)?\\s+in\\s+(${FIELD})\\s*(?:,|from|at)\\s*(?:the\\s+)?$`, 'u'))
    || before.match(new RegExp(`(${DEGREE})(?:\\s+degree)?\\s*(?:from|at)\\s*(?:the\\s+)?$`, 'u'));
  if (m) { out.degree = normDegree(m[1]); if (m[2]) out.field = tidy(m[2].replace(/,$/, '')); }
  if (!out.degree) {
    m = after.match(new RegExp(`^\\s*(?:with|,)\\s+(?:an?\\s+)?(${DEGREE})(?:\\s+degree)?(?:\\s+in\\s+(${FIELD}))?(?=\\s*(?:,|\\.|;|$|\\s+and\\s+(?:was|is|has|later|then)|\\s+in\\s+\\d{4}))`, 'u'));
    if (m) { out.degree = normDegree(m[1]); if (m[2]) out.field = tidy(m[2]); }
  }
  if (!out.field) {
    m = before.match(new RegExp(`\\b(?:studied|studying|majored in|major in|degree in)\\s+(${FIELD})\\s+at\\s+(?:the\\s+)?$`, 'u'));
    if (m && !/\b(?:at|from|and then)\b/.test(m[1])) out.field = tidy(m[1]);
  }
  const span = spanAfter(s, school);
  if (span) { out.from = span.from; out.to = span.to; }
  // "Harvard '12", "Class of 2012", "graduated from Columbia in 2015", "in 2015 after ... graduated from Columbia"
  const yy = after.match(/^\s*['’](\d{2})\b/);
  if (yy) out.to = year(Number(yy[1]) + (Number(yy[1]) > THIS_YEAR % 100 ? 1900 : 2000));
  if (!out.to) { const c = after.match(/^[^.;]{0,30}?\b[Cc]lass of ((?:19|20)\d\d)\b/); if (c) out.to = year(c[1]); }
  if (!out.to && /\b(?:graduat\w*|earned|received|completed|degree)\b/i.test(s) && (out.degree || /\bgraduat\w*\b[^.;]{0,30}$/i.test(before))) { const g = after.match(/^\s*(?:in|,)\s+((?:19|20)\d\d)\b/); if (g) out.to = year(g[1]); }
  if (!out.to) { const g = before.match(/\bin ((?:19|20)\d\d)\b[^.;]{0,60}\bgraduat\w*\s+(?:from\s+)?(?:the\s+)?$/i); if (g) out.to = year(g[1]); }
  if (/\bdropped out\b|\bdrop-?out\b|\bleft without\b/i.test(s)) out.note = 'left without a degree';
  return out;
}

/* ----------------------------------------------------------------------- pages that are their own */

/** The page an archive copy is of ("https://web.archive.org/web/2020.../https://x.com/a" -> "https://x.com/a"). */
const pageOf = (url) => {
  const m = String(url || '').match(/^https?:\/\/web\.archive\.org\/web\/\d+[a-z_]*\/(.+)$/i);
  return m ? (/^https?:/i.test(m[1]) ? m[1] : `https://${m[1]}`) : String(url || '');
};
const PROFILE_PATH = /\/(?:authors?|people|person|team|speakers?|profiles?|bio|bios|members?|staff|leadership|founders?|u|in)\/([^/?#]+)\/?$/i;
/** Is this page the person's own profile (their handle, or an author or team page under their name)? */
export function isOwnPage(subject, url) {
  const u = pageOf(url);
  const p = profileFromUrl(u);
  if (p && p.platform !== 'substack' && p.platform !== 'medium') return handleFitsSubject(subject, p.handle);
  if (p) return handleFitsSubject(subject, p.handle);
  let path = '';
  try { path = new URL(u).pathname; } catch { return false; }
  const m = path.match(PROFILE_PATH);
  return Boolean(m && handleFitsSubject(subject, m[1]));
}

/** Pieces of a record to read, each with its date and how the person may be named in it. */
function unitsOf(subject, f) {
  const d = f.data || {};
  const date = String(d.capturedAt || f.date || '') || null;
  if (d.kind === 'change') {
    const own = isOwnPage(subject, d.page || f.url);
    const field = String(d.field || '');
    // a page's rewritten body may be another person's bio (an author box): only fields of the profile itself,
    // and the bio only through the ordinary sentence rules
    const asFragments = own && field !== 'bio';
    return [
      { text: d.before, date: d.fromDate || null, own: asFragments, firstName: own },
      { text: d.after, date: d.toDate || date, own: asFragments, firstName: own },
    ].filter((u) => u.text);
  }
  if (d.kind === 'snapshot') {
    const own = isOwnPage(subject, d.page || f.url);
    return [{ text: String(f.quote || '').replace(/^[^|]{2,80}\s\|\s/, ''), date, own, firstName: own }];
  }
  if (d.kind === 'bio') return [{ text: String(f.quote || ''), date, own: false, firstName: true }];
  if (f.source === 'wikipedia' || f.source === 'wikidata') {
    const title = String(f.title || '');
    const theirArticle = subject.hasName(title.split(/\s*[(:]/)[0]);
    const parts = String(subject.name || '').trim().split(/\s+/);
    const last = parts[parts.length - 1];
    // another person with their surname in the record (a parent, a sibling): the surname alone is not them
    const others = [...String(f.quote || '').matchAll(new RegExp(`\\b[A-Z][\\p{L}'’-]+(?:\\s+(?:[A-Z]\\.|[A-Z][\\p{L}'’-]+)){0,2}\\s+${esc(last)}\\b`, 'gu'))]
      .some((m) => !subject.hasName(m[0]) && !/^(?:In|On|At|By|As|After|Before|When|Since|Later|Then|The|And)\b/.test(m[0]));
    return [{ text: String(f.quote || ''), date, own: false, firstName: false, surname: theirArticle && !others }];
  }
  const own = isOwnPage(subject, f.url);
  return [{ text: `${String(f.title || '').replace(/[.!?]*$/, '')}. ${f.quote || ''}`, date, own, firstName: own }];
}

/** Clauses about family, childhood or anything private are cut from a sentence; the rest of it may still be read. */
function withoutPrivateClauses(s) {
  if (!KIN.test(s) && !privacyReason(s)) return s;
  const clauses = s.split(/,\s+(?:and|but)\s+|;\s+|,\s+(?=(?:and\s+)?(?:was|were|is|grew|lives|raised|born)\b)|\s+and\s+(?=(?:was|were)\s+(?:raised|born)\b)/);
  if (clauses.length < 2) return null;
  const kept = clauses.filter((c) => !KIN.test(c) && !privacyReason(c));
  return kept.length === clauses.length || !kept.length ? null : `${kept.join(', ').replace(/[.!?]?$/, '')}.`;
}

/* ----------------------------------------------------------------------- Wikidata statements */

const WD_KINDS = 'employer|educated at|position held|founded by|chief executive officer|chairperson|board member|director / manager|award received|member of';
/** The statements of a Wikidata record's quote: "Nikola Corporation: chief executive officer Trevor Milton (start time 2014; end time 2020-09)". */
export function wikidataStatements(quote) {
  const out = [];
  const re = new RegExp(`(?:^|\\.\\s+)([^:]{2,120}?):\\s+(${WD_KINDS})\\s+(.+?)(?:\\s+\\(([^()]*)\\))?(?=\\.\\s+[^:.]{2,120}?:\\s+(?:${WD_KINDS})\\s|\\.?$)`, 'g');
  for (const m of String(quote || '').matchAll(re)) {
    const q = {};
    for (const part of String(m[4] || '').split(/;\s*/)) {
      const k = part.match(/^(start time|end time|point in time|academic degree|academic major|of|position held)\s+(.+)$/);
      if (k) q[k[1]] = k[2].trim();
    }
    out.push({ a: tidy(m[1]), kind: m[2], b: tidy(m[3]), q });
  }
  return out;
}

/* ----------------------------------------------------------------------- the profile */

const TIED = new Set(['confirmed', 'likely']);
const BANKING = /\b(?:investment bank(?:ing|er)|banker|banking|financial analyst|finance|trader|trading desk|broker|wealth management)\b/i;
const REGISTERS = new Set(['uk-companies-house', 'fr-companies', 'us-state-registries']);
const titleCaseIfShouting = (s) => (s && s === s.toUpperCase() && /[A-Z]{3}/.test(s) ? s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Llc|Ltd|Plc|Uk|Usa|Us)\b/g, (m) => m.toUpperCase()) : s);
const cleanAssignee = (s) => tidy(String(s || '').replace(/,\s*Llc\b/i, ', LLC').replace(/,\s*Inc\b/i, ', Inc'));
const dateKey = (d) => String(d || '');

/**
 * Build the profile from records.
 * @param {object} subject from identity.createSubject / restoreSubject
 * @param {Array<object>} findings  records with { id, match, title, quote, url, source, category, data, date }
 * @param {Array<object>} [threads] trusted threads ({ kind, value, platform, why, evidence })
 * @returns {object} { headline, headlineIds, titles, basedIn, company, education, earlier, about, links,
 *   resume: { roles, education, founded, boards, investments, recognition, leads }, companyFacts, readBy }
 */
export function buildProfile(subject, findings, threads = []) {
  const company = tidy(subject.company || '');
  const all = (findings || []).filter(Boolean);
  const tied = all.filter((f) => TIED.has(f.match));
  const companyFacts = buildCompanyFacts(subject, all, threads);
  const legal = companyFacts.legalNames.map((n) => n.name);
  const coForms = company ? [company, ...legal] : [];
  const coRe = company ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${coForms.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'iu') : null;
  const coAlt = coForms.map(esc).join('|');
  const ordinary = company ? isOrdinaryWordCompany(company) : false;
  const aliasKeys = new Set([...legal.map(companyKeyStrict), ...[...(subject.anchors?.aliases?.values?.() || [])].map((a) => companyKeyStrict(a.value))]);
  /** Is this organisation the person's company (its name, a legal name, or the name with a legal form)? */
  const isCompany = (org) => {
    if (!company || !org) return false;
    const k = companyKeyStrict(org);
    if (!k) return false;
    if (k === companyKeyStrict(company) || aliasKeys.has(k)) return true;
    // "Nikola Motor Company" is Nikola; "Ramp Network" is not Ramp (an ordinary word needs its learned legal name)
    return !ordinary && startsWithCompany(org, company);
  };
  const nameWords = nameWordsOf(subject);

  const roles = []; // { org, title, from, to, current, id, date, basis, via }
  const edu = []; // { school, degree, field, from, to, note, id, basis }
  const founded = []; // { org, year, with, outcome, program, id }
  const boards = []; // { org, role, from, to, id }
  const invest = []; // { text, org, id }
  const recog = []; // { text, year, id }
  const votes = []; // { label, id, date, strong, end }
  const presence = []; // { id, date }: a dated record that has them in a role at the company
  const leads = [];
  const places = new Map();
  const about = [];
  const bankingIds = new Set();
  const rawHeadlines = []; // { text, id }

  const okOrg = (org) => {
    const o = trimOrg(org || '');
    const key = o.toLowerCase();
    if (o.length < 2 || o.length > 70 || NOT_ORG.has(key) || URLISH.test(o)) return null;
    if (key.split(/\s+/).every((w) => nameWords.has(w)) || subject.hasName(o)) return null;
    return o;
  };
  // a company they invested in may carry a name that reads like a person's ("Pied Piper"), but never theirs
  const okInvestee = (org) => {
    const o = trimOrg(org || '');
    return o.length >= 2 && o.length <= 70 && !NOT_ORG.has(o.toLowerCase()) && !URLISH.test(o) && !subject.hasName(o) ? o : null;
  };
  const okSchool = (s) => {
    SCHOOL.lastIndex = 0;
    return SCHOOL.test(s);
  };
  const addRole = (r) => {
    const org = okOrg(r.org);
    if (!org) return;
    if (okSchool(org) && !r.basis) return;
    SCHOOL.lastIndex = 0;
    roles.push({ ...r, org, title: r.title ? normTitle(r.title) : null });
  };
  const addVote = (label, id, date, strong, end = false) => votes.push({ label, id, date: date || '', strong, end });
  const addFounded = (x) => {
    const org = okOrg(x.org);
    if (!org) return;
    founded.push({ ...x, org, with: (x.with || []).filter((n) => !subject.hasName(n)) });
  };
  const addEdu = (x) => {
    const school = tidy(String(x.school || '').replace(/^The /, ''));
    if (school.length < 2 || school.length > 90) return;
    edu.push({ ...x, school });
  };
  const addPlace = (raw, id) => {
    const text = placeOnly(raw);
    if (!text) return;
    const key = text.toLowerCase();
    if (!places.has(key)) places.set(key, { text, ids: new Set() });
    places.get(key).ids.add(id);
  };
  /** People named in a founders list ("Eric Glyman, Karim Atiyeh, and Gene Lee"), the person aside. */
  const peopleIn = (text) => {
    const out = [];
    for (const part of String(text || '').split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/)) {
      const n = tidy(part.replace(/[.;:]+$/, ''));
      if (!n) continue;
      if (subject.hasName(n)) continue;
      if (!/^[A-Z][\p{L}'’-]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][\p{L}'’-]+){1,2}$/u.test(n) || !isPersonRun(n)) break;
      out.push(n);
    }
    return out;
  };

  /* ---- 1. structured fields */
  for (const f of tied) {
    const d = f.data || {};
    const fdate = String(f.date || '') || null;
    if (f.source === 'wikidata' && f.match === 'confirmed') {
      for (const st of wikidataStatements(f.quote)) {
        const mine = subject.hasName(st.a);
        const inverse = subject.hasName(st.b);
        const from = year(st.q['start time']);
        const to = year(st.q['end time']);
        const ended = Boolean(st.q['end time']);
        if (mine && st.kind === 'employer') {
          addRole({ org: st.b, title: st.q['position held'] || null, from, to, current: ended ? false : null, id: f.id, date: st.q['end time'] || st.q['start time'] || fdate, basis: 'record' });
        } else if (mine && st.kind === 'educated at') {
          addEdu({ school: st.b, degree: st.q['academic degree'] || null, field: st.q['academic major'] || null, from, to, id: f.id, basis: 'record' });
        } else if (mine && st.kind === 'position held' && st.q.of) {
          addRole({ org: st.q.of, title: st.b, from, to, current: ended ? false : null, id: f.id, date: st.q['end time'] || st.q['start time'] || fdate, basis: 'record' });
        } else if (mine && st.kind === 'award received') {
          recog.push({ text: st.b, year: year(st.q['point in time']) || from, id: f.id });
        } else if (mine && st.kind === 'member of' && !/\bparty\b/i.test(st.b)) {
          boards.push({ org: st.b, role: 'Member', from, to, id: f.id });
        } else if (inverse && st.kind === 'founded by') {
          addFounded({ org: st.a, year: from, id: f.id });
        } else if (inverse && st.kind === 'board member') {
          boards.push({ org: st.a, role: 'Board member', from, to, id: f.id });
        } else if (inverse && (st.kind === 'chief executive officer' || st.kind === 'chairperson' || st.kind === 'director / manager')) {
          const title = { 'chief executive officer': 'CEO', chairperson: 'Chair', 'director / manager': 'Director' }[st.kind];
          addRole({ org: st.a, title, from, to, current: ended ? false : null, id: f.id, date: st.q['end time'] || st.q['start time'] || fdate, basis: 'record' });
          if (isCompany(st.a) && title !== 'Director') {
            addVote(title, f.id, st.q['start time'] || fdate, true);
            if (ended) addVote(title, f.id, st.q['end time'], true, 'at');
          }
        }
      }
      continue;
    }
    // SEC Form D and insider reports: the officer roles a filing states
    if (/^sec/.test(f.source || '') && d.issuer) {
      let list = d.roles || (d.relatedPersons || []).find((p) => subject.hasName(p.name || ''))?.roles || [];
      list = list.filter((r) => !/owner of more than/i.test(r)).map((r) => String(r).replace(/^officer\s*\((.+)\)$/i, '$1').replace(/^director$/i, 'Director').replace(/^officer$/i, 'Officer'));
      if (list.length) {
        const issuer = titleCaseIfShouting(d.issuer);
        const when = d.firstReport || fdate;
        addRole({ org: issuer, title: list.join(' and '), from: null, to: null, current: null, id: f.id, date: when, basis: 'record' });
        if (isCompany(issuer)) {
          for (const label of titlesIn(list.join(' and '))) addVote(label, f.id, when, true);
          presence.push({ id: f.id, date: when });
        }
      }
    }
    // Company register officer roles with their dates
    if (REGISTERS.has(f.source) && Array.isArray(d.appointments) && d.company) {
      const org = titleCaseIfShouting(d.company);
      for (const a of d.appointments) {
        addRole({ org, title: a.role || 'Officer', from: year(a.appointed), to: year(a.resigned), current: !a.resigned, id: f.id, date: a.resigned || a.appointed || fdate, basis: 'record' });
        if (isCompany(org) && !a.resigned) presence.push({ id: f.id, date: a.appointed || fdate });
      }
    }
    // BrokerCheck: the firms and dates of a registration tied to the person
    if (f.source === 'finra-brokercheck' && Array.isArray(d.firms)) {
      for (const firm of d.firms) {
        const q = String(f.quote || '');
        const i = q.toLowerCase().indexOf(String(firm).toLowerCase());
        const m = i >= 0 ? q.slice(i + firm.length).match(/^\s*\((\d{4})(?:-\d\d-\d\d)?\s+to\s+(\d{4}|present|now)/i) : null;
        addRole({ org: firm, title: null, from: m ? year(m[1]) : null, to: m ? year(m[2]) : null, current: m ? /present|now/i.test(m[2]) : null, id: f.id, date: fdate, basis: 'record', via: 'brokercheck' });
      }
    }
    // schema.org Person data on a page matched to the person
    if (d.structured) {
      const s = d.structured;
      const titles = (s.titles || []).filter(Boolean);
      for (const org of s.employers || []) {
        const title = titles.find((t) => t.toLowerCase().includes(String(org).toLowerCase())) || ((s.employers || []).length === 1 && titles.length === 1 ? titles[0] : null);
        const clean = title ? tidy(title.replace(new RegExp(`[,@]?\\s*(?:at\\s+)?${esc(org)}`, 'i'), '')) : null;
        if (isCompany(org)) { for (const label of titlesIn(clean || '')) addVote(label, f.id, fdate, true); presence.push({ id: f.id, date: fdate }); } else addRole({ org, title: clean, from: null, to: null, current: null, id: f.id, date: fdate, basis: 'record' });
      }
      for (const school of s.schools || []) addEdu({ school, id: f.id, basis: 'record' });
      for (const org of s.foundersOf || []) addFounded({ org, with: s.cofounders || [], id: f.id });
    }
    // patents: the assignee is where the person worked when the invention was filed
    if (f.source === 'patents' && Array.isArray(d.assignees)) {
      for (const a of d.assignees.slice(0, 3)) {
        const org = cleanAssignee(a);
        if (looksLikePerson(org) || subject.hasName(org)) continue;
        addRole({ org, title: null, from: year(d.priorityDate), to: null, current: null, id: f.id, date: d.priorityDate || fdate, basis: 'record', via: 'patent' });
      }
    }
    // ORCID entries and theses
    if (f.source === 'academic-record') {
      for (const e of d.entries || []) {
        if (!e.organisation) continue;
        if (f.category === 'education') addEdu({ school: e.organisation, degree: e.role || null, field: e.department || null, from: year(e.start), to: year(e.end), id: f.id, basis: 'record' });
        else addRole({ org: e.organisation, title: e.role || null, from: year(e.start), to: year(e.end), current: e.end ? false : null, id: f.id, date: e.end || e.start || fdate, basis: 'record' });
      }
      if (d.institution && d.degree) addEdu({ school: d.institution, degree: d.degree, to: d.defended === false ? null : year(f.date), id: f.id, basis: 'record' });
    }
    // an accelerator's founder list naming them
    if (f.source === 'yc-directory' && f.category === 'career' && d.company) {
      if (/found/i.test(d.role || '') || !d.role) addFounded({ org: d.company, program: d.batch ? `Y Combinator ${d.batch}` : 'Y Combinator', id: f.id });
      if (d.role && !isCompany(d.company)) addRole({ org: d.company, title: d.role, from: null, to: null, current: null, id: f.id, date: fdate, basis: 'record' });
    }
  }

  /* ---- 2 and 3. their own profile text, and sentences about them */
  for (const f of tied) {
    if (f.source === 'wikidata') continue;
    const url = String(f.url || '');
    const li = profileFromUrl(pageOf(url));
    const onLinkedIn = li?.platform === 'linkedin';
    const liOwn = onLinkedIn && handleFitsSubject(subject, li.handle);
    const titleNamesThem = subject.hasName(String(f.title || '').split(/\s+[-–—|]\s+|:\s/)[0]) || subject.hasName(f.title || '');

    // A LinkedIn search result on their own handle: "Name - Headline - Company | LinkedIn"
    if (liOwn && titleNamesThem) {
      const parts = String(f.title || '').replace(/\s*[|·]\s*LinkedIn.*$/i, '').split(/\s+[-–—]\s+/).map(tidy);
      if (parts.length >= 2 && subject.hasName(parts[0])) {
        const rest = parts.slice(1);
        let headline = null;
        let org = null;
        if (rest.length >= 2) { headline = rest[0]; org = rest[rest.length - 1]; } else if (/\s(?:at|@)\s/.test(rest[0])) { [headline, org] = rest[0].split(/\s+(?:at|@)\s+/); } else if (titlesIn(rest[0]).length || ROLE_WORD.test(rest[0])) headline = rest[0]; else org = rest[0];
        if (headline && headline.length <= 60) {
          if (org && isCompany(org)) { for (const label of titlesIn(headline)) addVote(label, f.id, f.date, true); rawHeadlines.push({ text: normTitle(headline), id: f.id }); } else if (org) addRole({ org, title: headline, from: null, to: null, current: true, id: f.id, date: f.date, basis: 'text' }); else if (!company) rawHeadlines.push({ text: normTitle(headline), id: f.id });
        }
      }
    }
    // Labelled fields of a profile: "Experience: Merge · Education: Columbia University · Location: New York"
    if ((titleNamesThem && (!onLinkedIn || liOwn)) || isOwnPage(subject, f.data?.page || url)) {
      const whole = `${f.title || ''} | ${f.quote || ''}`;
      const ed = whole.match(/\bEducation:\s*([^·|\n]{3,160}?)(?=\s*(?:[·|]|\s(?:Location|Experience|Connections)\b|\.(?:\s|$)|$))/);
      if (ed) {
        const v = ed[1];
        SCHOOL.lastIndex = 0;
        const sm = [...v.matchAll(SCHOOL)].pop();
        if (sm) {
          const pre = v.slice(0, sm.index).replace(/[,\s]+$/, '');
          const bits = pre ? pre.split(/\s*,\s*/) : [];
          const degree = bits.length && new RegExp(`^${DEGREE}$`, 'i').test(bits[0]) ? normDegree(bits.shift()) : null;
          const span = spanAfter(v, sm[0]);
          addEdu({ school: sm[0], degree, field: bits.length ? bits.join(', ') : null, from: span?.from ?? null, to: span?.to ?? null, id: f.id, basis: 'text' });
        } else {
          const school = v.replace(/\s*\(?\d{4}.*$/, '').trim();
          if (/^[A-Z]/.test(school) && school.split(/\s+/).length <= 8) addEdu({ school, id: f.id, basis: 'text', ...(spanAfter(v, school) || {}) });
        }
        SCHOOL.lastIndex = 0;
      }
      const exp = whole.match(/\bExperience:\s*(.{2,240}?)(?=\s*(?:[·|]\s*)?(?:Education|Location|Connections|Followers|\d+\s*(?:connections|followers))\b|\s*[|\n]|\.\s|$)/i);
      if (exp && !/^\d+\s+(?:years?|months?)\b/i.test(exp[1])) {
        for (const entry of exp[1].split(/\s+[·•]\s+|;\s*/)) {
          const dm = entry.match(/\s*\(\s*((?:[A-Z][a-z]{2,8}\.?\s+)?(?:\d{4}|\?))\s*[-–—]\s*((?:[A-Z][a-z]{2,8}\.?\s+)?(?:\d{4}|\?|present|now|current))\s*\)\s*$/i);
          const body = tidy(dm ? entry.slice(0, dm.index) : entry);
          const from = dm ? year((dm[1].match(/\d{4}/) || [])[0]) : null;
          const to = dm ? year((dm[2].match(/\d{4}/) || [])[0]) : null;
          const open = dm ? /present|now|current/i.test(dm[2]) : false;
          let title = null;
          let orgsHere;
          const at = body.match(/^(.{2,60}?)\s+(?:at|@)\s+(.+)$/);
          const pieces = body.split(/,\s+/);
          if (at && ROLE_WORD.test(at[1])) { title = at[1]; orgsHere = [at[2]]; } else if (pieces.length > 1 && (titlesIn(pieces.slice(0, -1).join(', ')).length || ROLE_WORD.test(pieces[0]))) { title = pieces.slice(0, -1).join(', '); orgsHere = [pieces[pieces.length - 1]]; } else orgsHere = body.split(/,\s+(?=[A-Z])/);
          for (const raw of orgsHere) {
            const org = tidy(raw.replace(/\s*[(,]?\s*\d{4}.*$/, ''));
            if (!/^[A-Z0-9]/.test(org) || org.split(/\s+/).length > 6) continue;
            if (isCompany(org)) { for (const label of titlesIn(title || '')) addVote(label, f.id, f.data?.capturedAt || f.date, true); continue; }
            addRole({ org, title, from, to, current: open ? true : to ? false : null, id: f.id, date: f.data?.capturedAt || f.date, basis: 'text' });
            if (title && /found/i.test(title)) addFounded({ org, year: from, id: f.id });
          }
        }
      }
      const loc = whole.match(/\bLocation:\s*([^·|\n]{2,60}?)(?=\s*(?:[·|]|\.(?:\s|$)|\d+\s*(?:connections|followers)|Experience|Education|$))/i);
      if (loc) addPlace(loc[1], f.id);
    }

    for (const unit of unitsOf(subject, f)) {
      let carry = 0;
      const sentences = sentencesOf(unit.text);
      for (const raw of sentences) {
        if (raw.length > 600) { carry = 0; continue; }
        const named = subject.hasName(raw);
        const follows = !named && carry > 0 && CONTINUES.test(raw);
        const firstNamed = !named && unit.firstName && opensOnSubject(subject, raw, { firstName: true });
        const surnamed = !named && unit.surname && opensOnSubject(subject, raw, { surname: true });
        const another = bringsInSomeoneElse(subject, raw);
        // On their own profile page, a fragment that names nobody else is about them ("BA in Economics, Harvard University")
        const fragment = unit.own && !named && !another && !/^[A-Z][\p{L}'’-]+\s+[A-Z][\p{L}'’-]+\s+(?:is|was|has|joined|said)\b/u.test(raw);
        carry = (named || firstNamed || surnamed || follows) && another ? 0 : named || firstNamed || surnamed ? 2 : follows ? carry - 1 : 0;
        const who = `(?:${esc(String(subject.name).trim())}${unit.firstName && String(subject.name).trim().split(/\s+/)[0].length >= 4 ? `|${esc(String(subject.name).trim().split(/\s+/)[0])}` : ''})`;
        const doing = new RegExp(`(?<![\\p{L}\\p{N}])${who}(?:\\s+and\\s+[A-Z][\\p{L}'’-]+(?:\\s+[A-Z][\\p{L}'’-]+)?)?\\s+(?:both\\s+|also\\s+|then\\s+|later\\s+)?(?:graduated|studied|attended|earned|received|majored|worked|joined|served|spent|interned|started (?:her|his|their) career|began (?:her|his|their) career)\\b`, 'u').test(raw);
        if (!(named || follows || firstNamed || surnamed || doing || fragment)) continue;
        const s = withoutPrivateClauses(raw);
        if (!s) continue;
        const theirs = doing || fragment || surnamed || opensOnSubject(subject, s, { firstName: unit.firstName });
        const strong = Boolean(unit.own) || liOwn || f.data?.structured;
        // the claim at `at` is the person's: the sentence is theirs, and nobody else is named on the way to it
        const mine = (at) => theirs && !leadsToSomeoneElse(subject, s.slice(0, at));

        if ((theirs || named) && BANKING.test(s)) bankingIds.add(f.id);

        // --- the role at their company: "Co-Founder & Co-CEO, Ramp", "Ramp CEO Eric Glyman", "former CEO of Nikola"
        if (coRe) {
          const a = new RegExp(`(${TITLES})\\s*(?:of|at|,|@|for)\\s+(?:the\\s+)?(?:${coAlt})(?![\\p{L}\\p{N}])`, 'giu');
          const b = new RegExp(`(?<![\\p{L}\\p{N}])(?:${coAlt})(?:['’]s)?,?\\s+(${TITLES})(?![\\p{L}])`, 'giu');
          for (const re of [a, b]) {
            for (const m of s.matchAll(re)) {
              const after = s.slice(m.index + m[0].length);
              const nameNext = (subject.hasName.positions?.(after) || []).some((p) => p.start <= 3);
              const owned = re === b ? nameNext || (!leadsToSomeoneElse(subject, s.slice(0, m.index)) && (theirs || named)) : !leadsToSomeoneElse(subject, s.slice(0, m.index));
              if (!owned) continue;
              // "former CEO of Merge" is not their role now
              const former = /\b(?:former|ex-?|then-?|onetime|one-time|past)\s*$/i.test(s.slice(0, m.index));
              const present = /\b(?:is|serves as|currently|now)\s+(?:also\s+)?(?:the\s+|a\s+)?$/i.test(s.slice(0, m.index));
              for (const label of titlesIn(m[1])) addVote(label, f.id, unit.date, strong || present || former, former ? 'former' : false);
            }
          }
          // "resigned as executive chairman of Nikola", "stepped down as CEO", "left Nikola"
          const end = s.match(new RegExp(`\\b(?:resigned|resigns|stepped down|steps down|step(?:ped|s)? aside|left|departed|was ousted|was removed|retired)\\b([^.;]{0,80}?)(?:${coAlt})(?![\\p{L}\\p{N}])`, 'iu'));
          if (end && mine(end.index)) {
            const labels = titlesIn(end[1]);
            if (labels.length) for (const label of labels) addVote(label, f.id, unit.date, true, 'at');
            else addVote(null, f.id, unit.date, true, 'at');
          }
        }

        // --- education
        SCHOOL.lastIndex = 0;
        if ((theirs && (EDU_WORD.test(s) || /['’]\d{2}\b/.test(s))) || (liOwn && fragment)) {
          for (const m of s.matchAll(SCHOOL)) {
            if (!mine(m.index) && !(liOwn && fragment)) continue;
            // "Ramp Harvard University" in a compact snippet: the company before the school is not part of it
            const lead = company ? m[0].match(new RegExp(`^(?:${coAlt})\\s+(?=[A-Z])`, 'i')) : null;
            const school = lead ? m[0].slice(lead[0].length) : m[0];
            const details = schoolDetails(s, school, m.index + (lead ? lead[0].length : 0));
            addEdu({ school, ...details, id: f.id, basis: 'text' });
          }
        }
        // "Ramp was founded in March 2019 by Eric Glyman, Karim Atiyeh, and Gene Lee": they are on the founders list,
        // which ties the sentence to them wherever it opens
        for (const m of s.matchAll(new RegExp(`(${ORG_TOKEN}(?:\\s+${ORG_TOKEN}){0,4})(?:['’]s)?,?\\s+(?:was\\s+|is\\s+)?(?:co-?)?founded\\s+(?:in\\s+(?:[A-Z][a-z]+\\s+)?((?:19|20)\\d\\d)\\s+)?by\\s+([^.;]{3,200})`, 'gu'))) {
          if (!subject.hasName(m[3].split(/,\s+(?:a|an|the|who|former)\b/)[0])) continue;
          addFounded({ org: m[1], year: year(m[2]), with: peopleIn(m[3].replace(/,\s+(?:a|an|the|who|former)\b.*$/, '')), id: f.id });
        }
        SCHOOL.lastIndex = 0;
        if (!theirs) {
          if (named && BIO_WORD.test(s) && s.length >= 60 && s.length <= 300 && /[.!?]["”']?$/.test(s) && !/\s[—–|]\s/.test(s) && about.length < 40) about.push({ text: s, id: f.id, bio: f.data?.kind === 'bio', hasCo: Boolean(coRe && coRe.test(s)) });
          continue;
        }

        // --- companies founded: "co-founded Paribus (YC S15, Acq. by Capital One)", "started an alarm sales company called X"
        const foundedRe = /\b(?:co-?\s?founded|co-?founding|founded|started|launched|created|set up)\s+/gi;
        for (const m of s.matchAll(foundedRe)) {
          const at = m.index + m[0].length;
          const rest = s.slice(at);
          if (!/^(?:(?:an?|the|her|his|their)\s+(?:[\p{L}$\d.,-]+\s+){0,5}?(?:company|startup|start-up|business|firm|venture|fund|brand|app|nonprofit|organi[sz]ation|lab|studio|platform)\s+(?:called|named)\s+)?(?:[A-Z0-9]|[a-z][A-Z])/u.test(rest)) continue;
          if (/^(?:her|his|their)\s+career\b/i.test(rest)) continue;
          const o = orgAt(s, at);
          if (!o || !mine(o.start)) continue;
          const tail = s.slice(o.end, o.end + 200);
          const yr = (tail.match(/^[^.;]{0,25}?\bin\s+(?:[A-Z][a-z]+\s+)?((?:19|20)\d\d)\b/) || [])[1] || (s.match(/^["“'(]?In\s+(?:[A-Z][a-z]+\s+)?((?:19|20)\d\d)\s*,/) || [])[1] || spanAfter(s, o.org)?.from || null;
          const withNames = (tail.match(/^[^.;]{0,30}?\b(?:with|alongside|together with)\s+(?:(?:his|her|their)\s+(?:[a-z-]+\s+){0,2})?([A-Z][^.;()]{3,120})/) || [])[1];
          const joint = (maskSubject(subject, s.slice(0, m.index)).match(/•\s*(?:and|&)\s+([A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+){1,2})\s*,?\s*$/u) || [])[1];
          const acq = s.slice(o.end).match(/\b(?:acq(?:uired|\.)|bought)\s+(?:in\s+((?:19|20)\d\d)\s+)?by\s+([A-Z][\p{L}\p{N}&.'’-]*(?:\s+[A-Z][\p{L}\p{N}&.'’-]*){0,4})(?:\s+in\s+((?:19|20)\d\d))?|\bsold\s+(?:it\s+)?to\s+([A-Z][\p{L}\p{N}&.'’-]*(?:\s+[A-Z][\p{L}\p{N}&.'’-]*){0,4})(?:\s+in\s+((?:19|20)\d\d))?/u);
          const acquirer = acq ? trimOrg(acq[2] || acq[4]) : null;
          const acqYear = acq ? acq[1] || acq[3] || acq[5] || null : null;
          const yc = s.slice(o.end).match(/\b(?:YC|Y Combinator)\s+\(?([SWF]\d{2})\b/);
          addFounded({
            org: o.org, year: year(yr), id: f.id,
            with: [...peopleIn(withNames), ...(joint ? [joint] : [])],
            outcome: acquirer ? `acquired by ${acquirer}${acqYear ? ` in ${acqYear}` : ''}` : null,
            program: yc ? `Y Combinator ${yc[1]}` : null,
          });
        }
        // "co-founder of Paribus", "founder and CEO of Initech"
        for (const m of s.matchAll(/\b(?:co-?\s?founder|founder)(?:\s+(?:and|&)\s+[A-Za-z-]+(?:\s+[A-Za-z-]+)?)?\s+(?:of|at)\s+/gi)) {
          const o = orgAt(s, m.index + m[0].length);
          if (o && mine(m.index)) addFounded({ org: o.org, year: year(spanAfter(s, o.org)?.from), id: f.id });
        }
        // a title at their company that says founder
        // (the founded entry for the company itself is made from the title votes below)

        // --- earlier and other roles
        const rolePatterns = [
          { re: /\b(?:[Pp]reviously|[Ff]ormerly|[Ee]arlier|[Bb]efore (?:that|founding|starting|launching|co-?founding|joining)[^.;]{0,50}?,|[Pp]rior to [^.;]{0,50}?,)([^.;]{0,70}?)\b(?:at|for|with|joined)\s+/g, current: false, list: true, skipIf: /\b(?:co-?founded|founded|started|launched|built|created)\b/i },
          { re: /\b(?:worked|working|work|stints?|interned|internships?|career|spent\s+(?:[\w-]+\s+){0,3}(?:years?|months?))\s+(?:[\p{L}\s'’-]{0,40}?\s)?(?:at|for)\s+/gu, current: null, list: true },
          { re: new RegExp(`\\b(?:was|been|served as|worked as|started (?:out|her career|his career|their career) as)\\s+(?:an?|the)\\s+(?<role>${ROLE})\\s+(?:at|for|of|with)\\s+`, 'gu'), current: false },
          { re: new RegExp(`\\b(?:is|serves as|currently)\\s+(?:also\\s+|now\\s+|currently\\s+)*(?:an?|the)\\s+(?<role>${ROLE})\\s+(?:at|of|for)\\s+`, 'gu'), current: true },
          { re: new RegExp(`\\b[Ff]ormer(?:ly)?\\s+(?:an?\\s+|the\\s+)?(?<role>${ROLE})\\s+(?:at|of)\\s+`, 'gu'), current: false },
          { re: /\b(?:alum(?:na|nus|ni)? of|veteran of)\s+/g, current: false },
          { re: /\bjoined\s+(?!the\s+(?:advisory\s+)?board\b)/g, current: null },
        ];
        for (const p of rolePatterns) {
          for (const m of s.matchAll(p.re)) {
            if (p.skipIf && p.skipIf.test(m[1] || '')) continue;
            let role = m.groups?.role ? tidy(m.groups.role) : null;
            if (role && /\b(?:who|which|that|is|was|the|board)\b/i.test(role)) continue;
            if (role && /found/i.test(role)) continue; // a founder of X is read as founded
            const list = p.list ? orgListAt(s, m.index + m[0].length) : [orgAt(s, m.index + m[0].length)].filter(Boolean);
            // after "joined" or "with" a person may stand ("joined Erik Torenberg", "worked with Bob Smith")
            const personMayStand = /^joined|with\s*$/i.test(m[0].trim()) || /\bwith\s+$/i.test(m[0]);
            for (const o of list) {
              if (!mine(o.start)) continue;
              if (personMayStand && looksLikePerson(o.org)) continue;
              if (isCompany(o.org)) {
                if (role) for (const label of titlesIn(role)) addVote(label, f.id, unit.date, p.current === true, p.current === false ? 'former' : false);
                continue;
              }
              if (okSchool(o.org)) continue;
              const span = spanAfter(s, o.org);
              const joinedIn = /^joined/.test(m[0]) ? (s.slice(o.end).match(/^\s+in\s+(?:[A-Z][a-z]+\s+)?((?:19|20)\d\d)\b/) || [])[1] : null;
              addRole({ org: o.org, title: list.length === 1 ? role : null, from: span?.from ?? year(joinedIn), to: span?.to ?? null, current: span?.current ? true : span?.to ? false : p.current, id: f.id, date: unit.date, basis: 'text' });
            }
          }
        }
        // "Co-Founder at Ramp (@tryramp)", "Partner at Founders Fund": a bio's own headline
        if (fragment || (liOwn && !named)) {
          const hm = s.match(/^(.{2,60}?)\s+(?:at|@)\s+(?!https?:)/);
          if (hm && (titlesIn(hm[1]).length || ROLE_WORD.test(hm[1]))) {
            const o = orgAt(s, hm[0].length);
            if (o && isCompany(o.org)) { for (const label of titlesIn(hm[1])) addVote(label, f.id, unit.date, true); } else if (o && !URLISH.test(s.slice(o.start, o.end + 4))) {
              addRole({ org: o.org, title: hm[1], from: null, to: null, current: true, id: f.id, date: unit.date, basis: 'text' });
              if (/found/i.test(hm[1])) addFounded({ org: o.org, id: f.id });
            }
          }
          // "Co-Founder, CEO, Paribus (2014 - Feb 2019)"
          const cm = s.match(/^((?:[^,()]{2,40},\s+){1,3})([A-Z][^,()]{1,60}?)\s*\(\s*((?:[A-Z][a-z]{2,8}\.?\s+)?(?:\d{4}|\?))\s*[-–—]\s*((?:[A-Z][a-z]{2,8}\.?\s+)?(?:\d{4}|\?|present|now|current))\s*\)/);
          if (cm && titlesIn(cm[1]).length && !/^[A-Z][a-z]+:\s/.test(s)) {
            const title = cm[1].replace(/,\s*$/, '');
            const from = year((cm[3].match(/\d{4}/) || [])[0]);
            const to = year((cm[4].match(/\d{4}/) || [])[0]);
            const open = /present|now|current/i.test(cm[4]);
            if (isCompany(cm[2])) { for (const label of titlesIn(title)) addVote(label, f.id, unit.date, true, to ? 'at' : false); } else {
              addRole({ org: cm[2], title, from, to, current: open ? true : to ? false : null, id: f.id, date: unit.date, basis: 'text' });
              if (/found/i.test(title)) addFounded({ org: cm[2], year: from, id: f.id });
            }
          }
        }

        // --- board seats and advisory roles
        for (const m of s.matchAll(/\b(?:(?:sits|sat|serves|served|joined|has served)\s+on\s+the\s+(advisory board|board of directors|board)\s+(?:of|at|for)|board (?:member|director|seat)\s+(?:of|at)|member of the (advisory )?board(?: of directors)?\s+(?:of|at)|joined the (advisory )?board of|(?:an?\s+)?(advis[oe]r)\s+(?:to|at|of|for)|(advises)|chair(?:man|woman|person)? of the board (?:of|at))\s+/gi)) {
          const o = orgAt(s, m.index + m[0].length);
          if (!o || !mine(m.index) || !okOrg(o.org)) continue;
          const advisory = Boolean(m[2] || m[3] || m[4] || /advis/i.test(m[1] || '') || m[5]);
          const span = spanAfter(s, o.org);
          boards.push({ org: o.org, role: /chair/i.test(m[0]) ? 'Chair of the board' : advisory ? 'Advisor' : 'Board member', from: span?.from ?? null, to: span?.to ?? null, id: f.id });
        }

        // --- investments
        const angel = s.match(/\b(?:an?\s+)?(?:active\s+|early\s+|prolific\s+)?(?:[A-Z][\p{L}.]*(?:\s+[A-Z][\p{L}.]*)?-based\s+)?angel investor\b/u);
        if (angel && mine(angel.index)) {
          invest.push({ text: 'Angel investor', org: null, id: f.id });
          const inList = s.slice(angel.index + angel[0].length).match(/^\s+in\s+/);
          if (inList) for (const o of orgListAt(s, angel.index + angel[0].length + inList[0].length)) if (okInvestee(o.org)) invest.push({ text: `Investor in ${o.org}`, org: o.org, id: f.id });
        }
        for (const m of s.matchAll(/\b(?:(?:has\s+)?(?:invested|invests)\s+in|(?:an?\s+)?(?:early\s+)?(?:investor|backer)\s+in|(?:his|her|their)\s+(?:personal\s+)?investments\s+include)\s+/gi)) {
          if (/angel investor\s+in\s+$/i.test(s.slice(0, m.index + m[0].length))) continue;
          if (!mine(m.index)) continue;
          for (const o of orgListAt(s, m.index + m[0].length)) if (okInvestee(o.org) && !isCompany(o.org)) invest.push({ text: `Investor in ${o.org}`, org: o.org, id: f.id });
        }

        // --- recognition: lists and awards
        const recPatterns = [
          /\bnamed\s+(?:to|on|in|as|one of)\s+(?:the\s+)?((?:[A-Z\d][\p{L}\p{N}'’&.-]*\s+){0,6}?(?:\d{2,3}\s+Under\s+\d{2}|[A-Z][\p{L}]*\s+List|list|100|50|Award))/gu,
          /\b((?:Forbes|Fortune|Inc\.?|TIME|Time|Bloomberg|Crain['’]s|MIT Technology Review|Business Insider)\s+(?:[A-Z\d][\p{L}\p{N}'’&.-]*\s+){0,4}?(?:\d{2,3}\s+Under\s+\d{2}|100|50|List))\b/gu,
          /\b(?:won|wins|received|awarded|recipient of|honou?red with)\s+(?:the\s+|an?\s+)?((?:[A-Z\d][\p{L}\p{N}'’&.-]*\s+){1,6}(?:Award|Prize|Medal|Fellowship|Scholarship))/gu,
        ];
        const seenRec = new Set();
        for (const re of recPatterns) {
          for (const m of s.matchAll(re)) {
            const text = tidy(m[1].replace(/^the\s+/i, '').replace(/\s+list$/i, ''));
            if (text.length < 4 || seenRec.has(text.toLowerCase()) || !mine(m.index)) continue;
            seenRec.add(text.toLowerCase());
            const tail = s.slice(m.index + m[0].length, m.index + m[0].length + 30);
            const y = (tail.match(/^\s*(?:list\s+)?(?:\(|in\s+|for\s+|,\s*|class of\s+)((?:19|20)\d\d)\b/i) || [])[1] || (s.slice(Math.max(0, m.index - 12), m.index).match(/((?:19|20)\d\d)\s*$/) || [])[1] || (s.match(/\bclass of ((?:19|20)\d\d)\b/i) || [])[1];
            recog.push({ text, year: year(y), id: f.id });
          }
        }

        // --- where they are based
        const based = s.match(/\b(?:is|are|was|now|currently)?\s*based (?:in|out of)\s+([A-Z][\p{L}.'’-]+(?:(?:,\s*|\s+)[A-Z][\p{L}.'’-]+){0,3})/u);
        if (based) addPlace(based[1], f.id);
        if (named && BIO_WORD.test(s) && s.length >= 60 && s.length <= 300 && /[.!?]["”']?$/.test(s) && !/\s[—–|]\s/.test(s) && about.length < 40) about.push({ text: s, id: f.id, bio: f.data?.kind === 'bio', hasCo: Boolean(coRe && coRe.test(s)) });
      }
    }
  }

  /* ---- their role at the company: the titles most records give, the newest winning where titles conflict */
  const order = TITLE_FORMS.map(([, label]) => label);
  const byLabel = new Map();
  for (const v of votes.filter((x) => x.label)) {
    if (!byLabel.has(v.label)) byLabel.set(v.label, { label: v.label, ids: new Set(), on: [], off: [] });
    const e = byLabel.get(v.label);
    e.ids.add(v.id);
    (v.end ? e.off : e.on).push(v);
  }
  const endsAll = votes.filter((v) => !v.label && v.end);
  // titles of one family (CEO and co-CEO, chair and executive chair): the newest record decides, the person's own
  // pages and filings first (a newspaper may still write "CEO" for a co-CEO), and the family's records all count
  // towards the winner
  const newest = (e, strongOnly = false) => [...e.on, ...e.off].filter((v) => !strongOnly || v.strong).map((v) => dateKey(v.date)).sort().pop() || '';
  const familyIds = new Map();
  for (const fam of new Set([...byLabel.values()].map((e) => FAMILY[e.label]).filter(Boolean))) {
    const members = [...byLabel.values()].filter((e) => FAMILY[e.label] === fam);
    if (members.length < 2) continue;
    const strongDated = members.filter((e) => newest(e, true));
    const dated = members.filter((e) => newest(e));
    const winner = strongDated.length ? strongDated.sort((a, b) => newest(b, true).localeCompare(newest(a, true)) || b.ids.size - a.ids.size)[0]
      : dated.length ? dated.sort((a, b) => newest(b).localeCompare(newest(a)) || b.ids.size - a.ids.size)[0] : members.sort((a, b) => b.ids.size - a.ids.size)[0];
    familyIds.set(winner, new Set(members.flatMap((e) => [...e.ids])));
    for (const e of members) if (e !== winner) e.lost = true;
  }
  const support = (e) => (familyIds.get(e) || e.ids).size;
  const ranked = [...byLabel.values()].filter((e) => !e.lost).sort((a, b) => support(b) - support(a));
  const top = ranked[0] ? support(ranked[0]) : 0;
  let kept = ranked.filter((e) => support(e) >= Math.max(1, Math.ceil(top / 3)));
  // "Co-Founder" already says founder
  if (kept.some((e) => e.label === 'Co-Founder')) kept = kept.filter((e) => e.label !== 'Founder');
  kept.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
  // A title is over when a record ends it (an end time, "resigned", "former") and no stronger record after that
  // end has them in it. A newspaper calling them "Nikola CEO" years later is not such a record.
  const lastEndAll = endsAll.length ? endsAll.map((v) => dateKey(v.date)).sort().pop() : null;
  // dates compared at the shorter precision: "2020" against "2020-06-05" cannot say which came first
  const cmpDate = (a, b) => { const n = Math.min(a.length, b.length); return a.slice(0, n).localeCompare(b.slice(0, n)); };
  const latestOf = (list) => list.filter((x) => x != null).reduce((m, x) => (m == null || cmpDate(x, m) > 0 || (cmpDate(x, m) === 0 && x.length > m.length) ? x : m), null);
  const endedAt = (e) => {
    if (FOUNDER_LABELS.has(e.label)) return null;
    if (!e.off.length && lastEndAll == null) return null;
    const lastEnd = latestOf([...e.off.map((v) => dateKey(v.date)), lastEndAll]) ?? '';
    const after = latestOf([...e.on.filter((v) => v.strong).map((v) => dateKey(v.date)), ...presence.map((p) => dateKey(p.date))]);
    return after != null && after !== '' && cmpDate(after, lastEnd) > 0 ? null : lastEnd || 'undated';
  };
  // the year a tenure ended is the one a record states as its end (an end time, "resigned in 2020"); a later
  // article calling them "former CEO" says it is over, not when it ended
  const tenureEnd = (e) => latestOf([...e.off.filter((v) => v.end === 'at').map((v) => dateKey(v.date)), lastEndAll]);
  const currentLabels = kept.filter((e) => endedAt(e) == null);
  // a title fewer records give still counts as over when a record ends it ("resigned as executive chairman")
  const endedLabels = ranked.filter((e) => !FOUNDER_LABELS.has(e.label) && e.off.length && endedAt(e) != null && !currentLabels.includes(e) && (kept.includes(e) || !kept.some((k) => FAMILY[k.label] && FAMILY[k.label] === FAMILY[e.label])))
    .sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label)).slice(0, 3);
  const nonFounderNow = currentLabels.filter((e) => !FOUNDER_LABELS.has(e.label));
  const companyCurrent = Boolean(kept.length) && (nonFounderNow.length > 0 || !endedLabels.length);
  const until = endedLabels.map((e) => year(tenureEnd(e))).filter(Boolean).sort((a, b) => b - a)[0] || null;
  const labelsOf = (list) => list.map((e) => e.label);
  let headline = null;
  if (kept.length && company) {
    if (companyCurrent) headline = `${joinTitles(labelsOf(currentLabels).slice(0, 3))}, ${company}`;
    else {
      const founder = currentLabels.filter((e) => FOUNDER_LABELS.has(e.label));
      const former = `former ${joinTitles(labelsOf(endedLabels))}${until ? `, until ${until}` : ''}`;
      headline = founder.length ? `${labelsOf(founder).join(', ')}, ${company} (${former})` : `${former.charAt(0).toUpperCase()}${former.slice(1)}, ${company}`;
    }
  } else if (rawHeadlines.length) {
    headline = company ? `${rawHeadlines[0].text}, ${company}` : rawHeadlines[0].text;
  }
  const headlineIds = kept.length ? [...new Set(kept.flatMap((e) => [...e.ids]))].slice(0, 4) : rawHeadlines.slice(0, 1).map((r) => r.id);

  /* ---- résumé: roles grouped by organisation */
  const roleMap = new Map();
  for (const r of roles) {
    const k = isCompany(r.org) ? '\u0000company' : orgKey(r.org);
    if (!k) continue;
    if (!roleMap.has(k)) roleMap.set(k, { org: k === '\u0000company' ? company : r.org, names: new Map(), titles: [], from: null, to: null, facts: [], ids: new Set(), basis: 'text' });
    const e = roleMap.get(k);
    if (k !== '\u0000company') {
      e.names.set(r.org, (e.names.get(r.org) || 0) + 1);
      e.org = [...e.names.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
    }
    e.facts.push(r);
    e.ids.add(r.id);
    if (r.title && !e.titles.some((t) => t.toLowerCase() === r.title.toLowerCase())) e.titles.push(r.title);
    if (r.from && (!e.from || r.from < e.from)) e.from = r.from;
    if (r.to && (!e.to || r.to > e.to)) e.to = r.to;
    if (r.basis === 'record') e.basis = 'record';
  }
  const companyFounded = kept.some((e) => FOUNDER_LABELS.has(e.label));
  const foundedYearOfCompany = companyFacts.founded?.year || null;
  if (company && (kept.length || roleMap.has('\u0000company'))) {
    for (const v of votes) if (v.label && endedLabels.some((k) => k.label === v.label)) roleMap.get('\u0000company')?.ids.add(v.id);
    const e = roleMap.get('\u0000company') || { org: company, titles: [], from: null, to: null, facts: [], ids: new Set(), basis: 'text' };
    for (const id of headlineIds) e.ids.add(id);
    for (const v of votes) if (v.label && kept.some((k) => k.label === v.label)) e.ids.add(v.id);
    if (kept.some((k) => [...k.on, ...k.off].some((v) => v.strong && roles.some((r) => r.id === v.id && r.basis === 'record')))) e.basis = 'record';
    if (kept.length) e.titles = [joinTitles([...new Set([...labelsOf(companyCurrent ? currentLabels : kept), ...(companyCurrent ? [] : labelsOf(endedLabels))])].sort((a, b) => order.indexOf(a) - order.indexOf(b)))];
    if (companyFounded && foundedYearOfCompany && (!e.from || foundedYearOfCompany < e.from)) e.from = foundedYearOfCompany;
    e.current = companyCurrent;
    if (!companyCurrent && until) e.to = until;
    if (companyCurrent) e.to = null;
    roleMap.set('\u0000company', e);
  }
  const resumeRoles = [];
  for (const [k, e] of roleMap) {
    let current;
    if (k === '\u0000company' && e.current != null) current = e.current;
    else {
      // current only when the newest dated fact about it says so
      const sorted = [...e.facts].sort((a, b) => dateKey(b.date).localeCompare(dateKey(a.date)));
      const ends = e.facts.filter((x) => x.current === false || x.to);
      const nows = e.facts.filter((x) => x.current === true);
      const lastEnd = ends.map((x) => dateKey(x.date)).sort().pop();
      const lastNow = nows.map((x) => dateKey(x.date)).sort().pop();
      current = Boolean(nows.length) && (lastEnd == null || (lastNow != null && lastNow > lastEnd)) && !e.to;
      if (!sorted.length) current = false;
    }
    const title = e.titles.length ? (e.titles.length <= 2 ? e.titles.join('; ') : `${e.titles.slice(0, 2).join('; ')}`) : null;
    resumeRoles.push({ org: e.org, title, from: e.from, to: current ? null : e.to, current, ids: [...e.ids].slice(0, 6), basis: e.basis, ...(e.facts.length && e.facts.every((x) => x.via === 'brokercheck') ? { via: 'brokercheck' } : {}) });
  }
  resumeRoles.sort((a, b) => (Number(b.current) - Number(a.current)) || ((b.from || b.to || 0) - (a.from || a.to || 0)));

  /* ---- education grouped by school ("Harvard", "Harvard College" and "Harvard University" are one school) */
  const rootOf = (school) => {
    const s = school.replace(/^The /, '');
    const m = s.match(/^University of (.+)$/) || s.match(/^(.+?)\s+(?:University|College)$/);
    const r = (m ? m[1] : s).toLowerCase();
    return /^(?:boston|miami|washington|columbia|georgetown)$/.test(r) && m && !/^University of/.test(s) ? `${r}|${/College$/.test(s) ? 'c' : 'u'}` : r;
  };
  const eduMap = new Map();
  const eduSorted = [...edu].sort((a, b) => Number(b.basis === 'record') - Number(a.basis === 'record'));
  for (const x of eduSorted) {
    const k = rootOf(x.school);
    if (!eduMap.has(k)) eduMap.set(k, { names: new Map(), degree: null, field: null, from: null, to: null, note: null, ids: new Set(), basis: x.basis });
    const e = eduMap.get(k);
    e.names.set(x.school, (e.names.get(x.school) || 0) + 1 + (x.basis === 'record' ? 1 : 0) + (/\b(?:University|College)\b/.test(x.school) ? 0.5 : 0));
    e.ids.add(x.id);
    for (const field of ['degree', 'field', 'note']) if (!e[field] && x[field]) e[field] = x[field];
    if (x.from && (!e.from || x.from < e.from)) e.from = x.from;
    if (x.to && (!e.to || x.to > e.to)) e.to = x.to;
    if (x.basis === 'record') e.basis = 'record';
  }
  const resumeEducation = [...eduMap.values()].map((e) => ({
    school: [...e.names.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0],
    degree: e.degree, field: e.field, from: e.from, to: e.to, ...(e.note ? { note: e.note } : {}), ids: [...e.ids].slice(0, 6), basis: e.basis,
  })).sort((a, b) => b.ids.length - a.ids.length);

  /* ---- companies founded */
  if (company && companyFounded) {
    const ids = [...new Set(kept.filter((e) => FOUNDER_LABELS.has(e.label)).flatMap((e) => [...e.ids]))];
    founded.push({ org: company, year: foundedYearOfCompany, with: [], id: ids[0], ids });
  }
  const fMap = new Map();
  for (const x of founded) {
    const k = isCompany(x.org) ? '\u0000company' : orgKey(x.org);
    if (!k) continue;
    if (!fMap.has(k)) fMap.set(k, { org: k === '\u0000company' ? company : x.org, years: new Map(), with: [], outcome: null, program: null, ids: new Set() });
    const e = fMap.get(k);
    for (const id of x.ids || [x.id]) if (id) e.ids.add(id);
    if (x.year) e.years.set(x.year, (e.years.get(x.year) || 0) + 1);
    for (const n of x.with || []) if (!e.with.includes(n)) e.with.push(n);
    if (!e.outcome && x.outcome) e.outcome = x.outcome;
    if (!e.program && x.program) e.program = x.program;
  }
  const resumeFounded = [...fMap.entries()].map(([k, e]) => {
    let y = [...e.years.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] || null;
    if (k === '\u0000company' && foundedYearOfCompany) y = y || foundedYearOfCompany;
    if (k === '\u0000company' && companyFacts.founded && !y) y = companyFacts.founded.year;
    return { org: e.org, year: y, with: e.with.slice(0, 6), outcome: e.outcome, ...(e.program ? { program: e.program } : {}), ids: [...e.ids].slice(0, 6) };
  }).sort((a, b) => (b.year || 0) - (a.year || 0));
  // the year they founded their company starts their role there
  const companyRole = resumeRoles.find((r) => r.org === company);
  const companyFoundedEntry = resumeFounded.find((x) => x.org === company);
  if (companyRole && companyFoundedEntry?.year && (!companyRole.from || companyFoundedEntry.year < companyRole.from)) companyRole.from = companyFoundedEntry.year;
  // A venture they co-founded is not also listed as an earlier employer with no title
  const foundedKeys = new Set(resumeFounded.map((x) => orgKey(x.org)));

  const group = (list, keyOf, build) => {
    const m = new Map();
    for (const x of list) {
      const k = keyOf(x);
      if (!k) continue;
      if (!m.has(k)) m.set(k, { first: x, ids: new Set(), all: [] });
      const e = m.get(k);
      e.ids.add(x.id);
      e.all.push(x);
    }
    return [...m.values()].map((e) => build(e)).sort((a, b) => b.ids.length - a.ids.length);
  };
  const resumeBoards = group(boards.map((b) => ({ ...b, org: okOrg(b.org) })).filter((b) => b.org), (b) => orgKey(b.org), (e) => ({ org: e.first.org, role: e.first.role, from: e.all.map((x) => x.from).filter(Boolean).sort()[0] || null, to: e.all.map((x) => x.to).filter(Boolean).sort().pop() || null, ids: [...e.ids].slice(0, 6) }));
  const resumeInvest = group(invest, (x) => (x.org ? orgKey(x.org) : 'angel'), (e) => ({ text: e.first.text, org: e.first.org, ids: [...e.ids].slice(0, 6) }));
  const resumeRecog = group(recog, (x) => flat(x.text).replace(/\b(?:list|the)\b/g, '').trim(), (e) => ({ text: e.first.text, year: e.all.map((x) => x.year).find(Boolean) || null, ids: [...e.ids].slice(0, 6) }));

  /* ---- leads: worth asking the person, never facts */
  const gradYear = resumeEducation.map((e) => e.to).filter(Boolean).sort()[0] || null;
  for (const f of all) {
    const d = f.data || {};
    if (f.match !== 'possible' || !subject.hasName(`${f.title || ''} ${f.quote || ''}`)) continue;
    if (f.source === 'finra-brokercheck' && Array.isArray(d.firms) && bankingIds.size && !(d.disclosures > 0)) {
      for (const firm of d.firms.slice(0, 2)) {
        const q = String(f.quote || '');
        const i = q.toLowerCase().indexOf(String(firm).toLowerCase());
        const m = i >= 0 ? q.slice(i + firm.length).match(/^\s*\((\d{4})(?:-\d\d-\d\d)?\s+to\s+(\d{4}|present|now)/i) : null;
        const from = m ? year(m[1]) : null;
        const to = m ? year(m[2]) : null;
        // the dates must fit the bio: starting within a year or so of graduating, or before founding their company
        const fits = from && (gradYear ? from >= gradYear - 1 && from <= gradYear + 2 : foundedYearOfCompany ? from < foundedYearOfCompany : false);
        if (!fits) continue;
        leads.push({
          text: `${firm}${from ? `, ${from}${to ? `–${to}` : ''}` : ''}: a FINRA BrokerCheck registration under the same full name${d.crd ? ` (CRD ${d.crd})` : ''}. Ask the person to confirm it is theirs.`,
          why: 'a record tied to them mentions a start in banking or finance, and the registration dates fit; the registration itself is matched by name only',
          ids: [f.id, ...[...bankingIds].slice(0, 2)],
        });
      }
    }
    if (REGISTERS.has(f.source) && d.company && company && startsWithCompany(d.company, company)) {
      const a = (d.appointments || [])[0] || {};
      leads.push({
        text: `${titleCaseIfShouting(d.company)}: ${(a.role || 'officer').toLowerCase()}${a.appointed ? ` since ${String(a.appointed).slice(0, 4)}` : ''}${a.resigned ? ` (resigned ${String(a.resigned).slice(0, 4)})` : ''}, on a company register under the same full name. Ask whether this is their company.`,
        why: 'the registered company begins with their company\'s name, but nothing else ties the entry to them',
        ids: [f.id],
      });
    }
  }

  // Privacy: the same rules as every other line, applied to each profile line
  const clean = (list, textOf) => list.filter((x) => !privacyReason(textOf(x) || ''));
  const resume = {
    roles: clean(resumeRoles.filter((r) => r.title || !foundedKeys.has(orgKey(r.org)) || r.basis === 'record'), (r) => `${r.title || ''} ${r.org}`).slice(0, 25),
    education: clean(resumeEducation, (e) => `${e.degree || ''} ${e.field || ''} ${e.school}`).slice(0, 12),
    founded: clean(resumeFounded, (x) => `${x.org} ${x.outcome || ''}`).slice(0, 12),
    boards: clean(resumeBoards, (x) => `${x.role} ${x.org}`).slice(0, 12),
    investments: clean(resumeInvest, (x) => x.text).slice(0, 20),
    recognition: clean(resumeRecog, (x) => x.text).slice(0, 12),
    leads: clean(leads, (x) => x.text).slice(0, 8),
  };

  // A few sentences of background: from pages about them first, the ones naming the company first, no near-duplicates.
  const picked = [];
  const words = (t) => new Set(t.toLowerCase().match(/[a-z0-9]{4,}/g) || []);
  const seenAbout = new Set();
  for (const a of about.sort((x, y) => Number(y.bio) - Number(x.bio) || Number(y.hasCo) - Number(x.hasCo) || y.text.length - x.text.length)) {
    if (seenAbout.has(a.text) || privacyReason(a.text)) continue;
    seenAbout.add(a.text);
    const w = words(a.text);
    const dup = picked.some((p) => { const pw = words(p.text); const shared = [...w].filter((x) => pw.has(x)).length; return shared / Math.max(1, Math.min(w.size, pw.size)) > 0.6; });
    if (!dup) picked.push(a);
    if (picked.length >= 5) break;
  }

  // Profile links: one per platform, the best-supported first; a link whose handle is not theirs only from
  // the person's own Wikidata entry or their own page's Person data.
  const candidates = [];
  for (const t of threads || []) {
    if (t.kind !== 'url' || t.trusted === false) continue;
    const p = profileFromUrl(t.value);
    const platform = t.platform || p?.platform || null;
    if (!platform) continue;
    const why = String(t.why || '');
    const origin = /wikidata|wikipedia/i.test(why) ? 3 : /linked from a page about them|same ?as/i.test(why) ? 2 : 0;
    const fits = Boolean(p?.handle && handleFitsSubject(subject, p.handle));
    // a newsletter or blog address is the author's: an interviewer's Substack is not theirs
    if ((platform === 'substack' || platform === 'medium') && origin < 2 && !fits) continue;
    const support = (t.evidence || []).length || t.support || 1;
    candidates.push({ platform, url: t.value, origin, support, fits });
  }
  candidates.sort((a, b) => b.origin - a.origin || Number(b.fits) - Number(a.fits) || b.support - a.support);
  const links = [];
  const perPlatform = new Map();
  for (const c of candidates) {
    const n = perPlatform.get(c.platform) || 0;
    if (n >= 2 || links.some((l) => l.url === c.url)) continue;
    perPlatform.set(c.platform, n + 1);
    links.push(n === 0 ? { platform: c.platform, url: c.url } : { platform: c.platform, url: c.url, also: true });
  }
  links.sort((a, b) => Number(Boolean(a.also)) - Number(Boolean(b.also)));

  const place = [...places.values()].sort((a, b) => b.ids.size - a.ids.size)[0] || null;
  const notCompany = resume.roles.filter((r) => r.org !== company);
  return {
    headline, headlineIds,
    titles: companyCurrent ? labelsOf(currentLabels).slice(0, 3) : [],
    basedIn: place ? { text: place.text, ids: [...place.ids].slice(0, 4) } : null,
    company: company || null,
    // the older fields, kept for report.js (byEmployer) and saved pages
    education: resume.education.map((e) => ({ school: e.school, degree: e.degree, field: e.field, from: e.from, to: e.to, ids: e.ids })),
    earlier: notCompany.filter((r) => r.via !== 'patent').map((r) => ({ org: r.org, role: r.title, from: r.from, to: r.to, current: r.current, ids: r.ids, ...(r.via ? { via: r.via } : {}) })),
    about: picked.map(({ text, id }) => ({ text, id })),
    links,
    resume,
    companyFacts,
    readBy: 'patterns',
  };
}

/**
 * The profile in the report's form (design decision 2): finding ids become citation numbers, and a line
 * no cited record states is left out. Null when there is nothing to show.
 * @param {object} profile from buildProfile (or a saved profile of the same shape)
 * @param {(ids: string[]) => number[]} cite
 */
export function publishProfile(profile, cite) {
  if (!profile) return null;
  const r = profile.resume || {};
  const withCites = (list) => (list || []).map(({ ids, ...rest }) => ({ ...rest, cites: cite(ids || []) })).filter((x) => x.cites.length);
  const roles = withCites(r.roles);
  const out = {
    headline: profile.headline || null,
    headlineCites: cite(profile.headlineIds || []),
    company: profile.company || null,
    roles,
    education: withCites(r.education),
    // kept for pages saved before the résumé: the roles they no longer hold elsewhere
    earlier: roles.filter((x) => x.org !== profile.company && !x.current).map((x) => ({ org: x.org, role: x.title || null, cites: x.cites })),
    founded: withCites(r.founded),
    boards: withCites(r.boards),
    investments: withCites(r.investments),
    recognition: withCites(r.recognition),
    leads: withCites(r.leads),
    basedIn: profile.basedIn && cite(profile.basedIn.ids || []).length ? { text: profile.basedIn.text, cites: cite(profile.basedIn.ids) } : null,
    about: (profile.about || []).map((a) => ({ text: a.text, cites: cite([a.id]) })).filter((a) => a.cites.length),
    links: profile.links || [],
    readBy: profile.readBy || 'patterns',
  };
  const has = out.headline || out.roles.length || out.education.length || out.founded.length || out.boards.length || out.investments.length || out.recognition.length || out.leads.length || out.basedIn || out.about.length || out.links.length;
  return has ? out : null;
}
