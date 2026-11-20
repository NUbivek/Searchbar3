/**
 * The person's professional profile, read out of the records tied to them:
 * current role, education, earlier roles, a few sentences of background and
 * their public profile links.
 *
 * Everything here is read from sentences that name the person in records
 * graded `confirmed` or `likely`; nothing is inferred, and every line keeps
 * the record it came from. Used by the page reader (sources/pages.js) to
 * pick the sentences of a page worth keeping, and by the report.
 */
import { profileFromUrl } from './extract';

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Sentences of a text (also split on line breaks and the "·" a search snippet uses between fields). */
export function sentencesOf(text) {
  return String(text || '')
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Inc|Corp|Co|Ltd|St|Jr|Sr|vs|U\.S|B\.S|B\.A|M\.S|M\.A|Ph\.D|M\.B\.A)\./g, '$1․')
    .split(/(?<=[.!?])\s+(?=["“'(]?[A-Z0-9])|\n+|\s+[·|]\s+/)
    .map((s) => tidy(s.replace(/․/g, '.')))
    .filter((s) => s.length >= 12);
}

const EDU_WORD = /\b(?:graduat\w*|studied|studying|degrees?|bachelor'?s?|master'?s?|B\.?S\.?c?|B\.?A\.?|M\.?S\.?c?|M\.?B\.?A\.?|Ph\.?D\.?|J\.?D\.?|doctorate|alum(?:na|nus|ni)?|attended|dropped out|drop-?out|majored|major(?:ing)? in|computer science|CS|economics|engineering|classmates?|college|undergrad\w*|education|school)\b/i;
const NAMED_SCHOOLS = 'MIT|Stanford|Harvard|Wharton|Yale|Princeton|Caltech|UC Berkeley|Berkeley|UCLA|UCSD|USC|NYU|Oxford|Cambridge|INSEAD|Columbia|Cornell|Dartmouth|Brown|UPenn|Penn|Duke|Carnegie Mellon|Georgia Tech|Waterloo|Northwestern|Kellogg|Booth|Sloan|Haas|McGill|IIT [A-Z][a-z]+|École Polytechnique|Ecole Polytechnique|HEC Paris|ENS|ESSEC|LSE|Imperial College(?: London)?|ETH Zurich|EPFL|Tsinghua|Technion';
const SCHOOL = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:(?:The )?University of [A-Z][\\p{L}.'-]+(?:(?:,| at)? [A-Z][\\p{L}.'-]+){0,2}`
  + `|(?:[A-Z][\\p{L}.'&-]+ ){1,4}(?:University|College|Institute of Technology|Business School|Law School|School of (?:Business|Law|Management|Engineering|Medicine|Economics|Design))`
  + `|${NAMED_SCHOOLS})(?![\\p{L}\\p{N}])`, 'gu');

const TITLE = '(?:co-?\\s?founder|founder|founding (?:partner|engineer)|CEO|CTO|COO|CFO|CPO|CRO|chief [a-z]+ officer|president|managing (?:partner|director)|general partner|chair(?:man|woman|person)?|executive chairman)';
const TITLES = `${TITLE}(?:\\s*(?:and|&|,|/)\\s*${TITLE}){0,2}`;
const ORG = "[A-Z][\\p{L}\\p{N}&.'’-]*(?:\\s+(?:[A-Z][\\p{L}\\p{N}&.'’-]*|of|and|&|de)){0,4}";
const ORG_LIST = `${ORG}(?:,\\s+${ORG}){0,3}(?:,?\\s+and\\s+${ORG})?`;
const ROLE = "[\\p{L}][\\p{L}\\s'’/&-]{2,48}?";
const PRIOR = [
  // "previously worked at X", "before founding Merge, she was an analyst at X", "prior to Merge, she led product at X"
  new RegExp(`\\b(?:[Pp]reviously|[Ff]ormerly|[Ee]arlier|[Bb]efore (?:that|founding|starting|launching|co-?founding|joining)[^.;]{0,50}?,|[Pp]rior to [^.;]{0,50}?,)[^.;]{0,70}?\\b(?:at|for|with|joined)\\s+(?<orgs>${ORG_LIST})`, 'gu'),
  new RegExp(`\\b(?:worked|working|work|stints?|roles?|positions?|interned|internships?|years|time|career)\\s+(?:[\\p{L}\\s'’-]{0,40}?\\s)?at\\s+(?<orgs>${ORG_LIST})`, 'gu'),
  new RegExp(`\\b(?:was|as|been|served as|worked as|started (?:out|her career|his career|their career) as)\\s+(?:an?|the)\\s+(?<role>${ROLE})\\s+(?:at|for)\\s+(?<orgs>${ORG})`, 'gu'),
  new RegExp(`\\b[Ff]ormer(?:ly)?\\s+(?:an?\\s+|the\\s+)?(?<role>${ROLE})\\s+(?:at|of)\\s+(?<orgs>${ORG})`, 'gu'),
  new RegExp(`\\b(?:alum(?:na|nus|ni)? of|veteran of|ex-)\\s*(?<orgs>${ORG})`, 'gu'),
];
const NOT_ORG = new Set(['the', 'a', 'an', 'she', 'he', 'they', 'her', 'his', 'their', 'i', 'we', 'it', 'this', 'that', 'in', 'on', 'at', 'as', 'ceo', 'cto', 'coo', 'cfo', 'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'linkedin', 'twitter', 'series', 'forbes', 'today', 'now', 'home', 'ai', 'saas', 'api', 'b2b', 'new york', 'san francisco', 'london', 'silicon valley', 'us', 'usa', 'america', 'europe']);
const trimOrg = (s) => tidy(String(s).replace(/(?:\s+(?:of|and|&|de))+$/i, '').replace(/[.,'’]+$/, ''));
const BIO_WORD = new RegExp(`${EDU_WORD.source}|\\b(?:previously|formerly|prior to|before (?:founding|starting|launching|co-?founding|joining)|worked|career|joined|co-?founded|founded|started|launched|led|built|investor|engineer|analyst|banker|consultant|product manager|${TITLE})\\b`, 'i');
const CONTINUES = /^["“'(]?(?:She|He|They|Prior to|Before|Previously|Earlier|After)\b/;
// Family and childhood are not part of a professional profile, and a relative's career is not the person's.
const KIN = /\b(?:husband|wife|spouse|partner'?s|boyfriend|girlfriend|fianc[ée]e?|father|mother|dad|mom|parents?|son|daughter|brother|sister|sibling|uncle|aunt|cousin|grandfather|grandmother|children|kids?|childhood|grew up|born (?:in|on|to)|raised (?:in|by)|when (?:she|he|they) (?:was|were) (?:\d+|[a-z]+) years)\b/i;
const LEAD_IN = /^["“'(]?(?:(?:Before|Prior to|After|Previously|Earlier|Formerly|In \d{4}|Today|Now)\b[^,]{0,70},\s*)?/;

const THIS_YEAR = new Date().getUTCFullYear();
const year = (y) => { const n = Number(y); return Number.isInteger(n) && n >= 1950 && n <= THIS_YEAR + 1 ? n : null; };
/**
 * The years printed right after a name in a sentence: "Stripe (2015–2017)", "Stripe, 2015 - present",
 * "Stripe from 2015 to 2017". Only a span beside the name counts; a year elsewhere in the sentence is another fact.
 * @returns {{ from: number|null, to: number|null, current: boolean }|null}
 */
export function spanAfter(sentence, name) {
  const s = String(sentence || '');
  const i = s.toLowerCase().indexOf(String(name || '').toLowerCase());
  if (!name || i < 0) return null;
  const after = s.slice(i + String(name).length, i + String(name).length + 40);
  const m = after.match(/^\s*(?:[(,]\s*|\s+from\s+)(\d{4})\s*(?:[-–—]|to|until)\s*(\d{4}|present|now|today|current)\s*\)?/i);
  if (!m) return null;
  const from = year(m[1]);
  const open = /^(?:present|now|today|current)$/i.test(m[2]);
  const to = open ? null : year(m[2]);
  if (!from || (!open && (!to || to < from))) return null;
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
const NOT_PERSON = new Set(`inc corp corporation llc ltd co company companies school schools university universities college institute academy capital partners ventures venture labs lab group bank banking fund funds foundation technologies technology tech systems holdings consulting business street code who under forbes fortune inc. google microsoft amazon meta apple facebook netflix oracle salesforce stripe ibm intel nvidia tesla uber airbnb mckinsey bain deloitte accenture goldman sachs morgan stanley jpmorgan chase credit suisse new san los las santa saint st north south east west united states state york francisco angeles city valley silicon bay area america american americas europe european asia africa india china london paris berlin boston texas california washington center centre health media network networks software studio studios global international research association society council board committee club program programme office department ministry government agency hospital medical sciences science engineering management law review times journal news post magazine week day summit conference award awards prize list series january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday previously before after prior earlier today now in at the she he they her his their a an and of for chief officer executive vice president director senior junior head manager product engineer partner founder co-founder cofounder ceo cto coo cfo cpo cro vp svp evp general managing principal associate analyst fellow member chair chairman chairwoman professor dr mr mrs ms phd mba bs ba ms ma jd md business administration computer finance economics arts`.split(/\s+/));
// someone else brought into the sentence: hired, recruited, a co-founder or colleague of theirs
export const HANDOFF = /(?<!\b(?:was|were|been|be|being|is|are|got|get|gets)\s+)\b(?:hired|hires|hiring|recruit(?:ed|s|ing)?|appoint(?:ed|s|ing)|brought (?:on|in)|poach(?:ed|es|ing)?|introduc(?:ed|es|ing)|married|mentor(?:ed|s|ing))\b/i;
export const RELATION = /(?:['’]s?|\b(?:her|his|their|our|its))\s+(?:[\p{L}-]+\s+){0,2}(?:co-?\s?founders?|cofounders?|colleagues?|partners?|husband|wife|spouse|boss|manager|mentors?|mentees?|teammates?|friends?|peers?|predecessor|successor|employees?|hires?|students?|advisors?|deputy|assistant|report)\b/iu;
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

/**
 * Is the person the one this sentence is about? It must open on them (after an optional "Before founding
 * Acme," lead-in): their full name, "She/He/They", or, where allowed, their first name not followed by
 * someone else's surname. "Acme, founded by Jane Roe and Bob Smith, a former engineer at Google" and
 * "Previously, Bob Smith was at Google" are about somebody else.
 */
export function opensOnSubject(subject, sentence, { firstName = false } = {}) {
  const s = String(sentence || '').replace(LEAD_IN, '');
  const head = s.slice(0, 80);
  if (/^(?:She|He|They)\b/i.test(s)) return true;
  const full = String(subject.name || '').trim();
  const first = full.split(/\s+/)[0] || '';
  const firstWords = head.split(/\s+/).slice(0, full.split(/\s+/).length + 1).join(' ');
  if (subject.hasName(firstWords)) return true;
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
    if (!(named || follows) || !BIO_WORD.test(s) || s.length > 400 || KIN.test(s)) continue;
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
  [/\bCEO\b|chief executive officer/i, 'CEO'], [/\bCTO\b|chief technology officer/i, 'CTO'], [/\bCOO\b|chief operating officer/i, 'COO'],
  [/\bCFO\b|chief financial officer/i, 'CFO'], [/\bCPO\b|chief product officer/i, 'CPO'], [/\bCRO\b|chief revenue officer/i, 'CRO'],
  [/executive chairman/i, 'Executive Chairman'], [/chair(?:man|woman|person)?\b/i, 'Chair'], [/president/i, 'President'],
  [/managing partner/i, 'Managing Partner'], [/managing director/i, 'Managing Director'], [/general partner/i, 'General Partner'],
];
function titlesIn(span) {
  const found = [];
  let rest = span;
  for (const [re, label] of TITLE_FORMS) {
    if (re.test(rest)) { found.push(label); rest = rest.replace(new RegExp(re.source, 'gi'), ' '); }
  }
  return found;
}

/**
 * Build the profile from records.
 * @param {object} subject from identity.createSubject / restoreSubject
 * @param {Array<object>} findings  records with { id, match, title, quote, url, source, category, data }
 * @param {Array<object>} [threads] trusted threads ({ kind, value, platform, why })
 * @returns {{ headline: string|null, company: string|null, education: Array, earlier: Array, about: Array, links: Array }}
 */
export function buildProfile(subject, findings, threads = []) {
  const company = tidy(subject.company || '');
  const coRe = company ? new RegExp(`(?<![\\p{L}\\p{N}])${esc(company)}(?![\\p{L}\\p{N}])`, 'iu') : null;
  const tied = (findings || []).filter((f) => f.match === 'confirmed' || f.match === 'likely');
  const nameTokens = new Set(String(subject.name || '').toLowerCase().split(/\s+/));

  const titleVotes = new Map(); // label -> Set(ids)
  const schools = new Map(); // key -> { school, ids:Set }
  const orgs = new Map(); // key -> { org, role, ids:Set }
  const about = [];
  const places = new Map(); // key -> { text, ids:Set }
  const withSpan = (entry, span) => {
    if (span && entry.from == null) { entry.from = span.from; entry.to = span.to; entry.current = span.current; }
  };
  const addSchool = (school, id, span = null) => {
    const name = tidy(school.replace(/^The /, ''));
    const key = name.toLowerCase();
    if (!schools.has(key)) schools.set(key, { school: name, ids: new Set() });
    schools.get(key).ids.add(id);
    withSpan(schools.get(key), span);
  };
  const addOrg = (raw, role, id, span = null) => {
    const org = trimOrg(raw);
    const key = org.toLowerCase();
    if (org.length < 2 || org.length > 60 || NOT_ORG.has(key) || key.split(/\s+/).every((w) => nameTokens.has(w))) return;
    if (coRe && coRe.test(org)) return;
    SCHOOL.lastIndex = 0;
    if (SCHOOL.test(org)) { SCHOOL.lastIndex = 0; return; }
    if (!orgs.has(key)) orgs.set(key, { org, role: null, ids: new Set() });
    const entry = orgs.get(key);
    entry.ids.add(id);
    if (role && !entry.role) entry.role = tidy(role);
    withSpan(entry, span);
  };
  const addPlace = (raw, id) => {
    const text = placeOnly(raw);
    if (!text) return;
    const key = text.toLowerCase();
    if (!places.has(key)) places.set(key, { text, ids: new Set() });
    places.get(key).ids.add(id);
  };

  for (const f of tied) {
    const fromBioPage = f.data?.kind === 'bio';
    // a record the page reader made: its title is ours, the sentences are the page's
    const whole = fromBioPage ? String(f.quote || '') : `${f.title || ''}. ${f.quote || ''}`;
    // A search snippet of a profile page: "Experience: Merge · Education: Columbia University · Location: ..."
    // These labels are the profile's own fields, so they are the person's when the page title names them.
    if (subject.hasName(f.title || '')) {
      const labelled = whole.match(/\bEducation:\s*([^·|.]{3,80})/);
      if (labelled) addSchool(labelled[1].replace(/\s*\(?\d{4}.*$/, ''), f.id, spanAfter(labelled[1], labelled[1].replace(/\s*\(?\d{4}.*$/, '').trim()));
      const exp = whole.match(/\bExperience:\s*(.{2,240}?)(?=\s*(?:[·|]\s*)?(?:Education|Location|Connections|Followers|\d+\s*(?:connections|followers))\b|\s*[|\n]|\.\s|$)/i);
      if (exp) {
        for (const part of exp[1].split(/\s+[·•]\s+|;\s*|,\s+(?=[A-Z])/)) {
          const name = tidy(part.replace(/\s*[(,]?\s*\d{4}.*$/, ''));
          if (/^[A-Z0-9]/.test(name) && name.split(/\s+/).length <= 6) addOrg(name, null, f.id, spanAfter(part, name));
        }
      }
      const loc = whole.match(/\bLocation:\s*([^·|\n]{2,60}?)(?=\s*(?:[·|]|\.(?:\s|$)|\d+\s*(?:connections|followers)|$))/i);
      if (loc) addPlace(loc[1], f.id);
    }

    let carry = 0;
    for (const s of sentencesOf(whole)) {
      const who = `(?:${esc(String(subject.name).trim())}${fromBioPage && String(subject.name).trim().split(/\s+/)[0].length >= 4 ? `|${esc(String(subject.name).trim().split(/\s+/)[0])}` : ''})`;
      const doing = new RegExp(`(?<![\\p{L}\\p{N}])${who}(?:\\s+and\\s+[A-Z][\\p{L}'’-]+(?:\\s+[A-Z][\\p{L}'’-]+)?)?\\s+(?:both\\s+|also\\s+|then\\s+|later\\s+)?(?:graduated|studied|attended|earned|received|majored|worked|joined|served|spent|interned|started (?:her|his|their) career|began (?:her|his|their) career)\\b`, 'u').test(s);
      const named = subject.hasName(s);
      const follows = !named && carry > 0 && CONTINUES.test(s);
      // on a page the reader kept, the person is also called by their first name
      const firstNamed = !named && fromBioPage && opensOnSubject(subject, s, { firstName: true });
      // once someone else is brought in ("She hired Bob Smith."), the next "He/She" may be them: no carry past it
      carry = (named || firstNamed || follows) && bringsInSomeoneElse(subject, s) ? 0 : named || firstNamed ? 2 : follows ? carry - 1 : 0;
      if ((!named && !follows && !firstNamed && !doing) || KIN.test(s)) continue;
      // Schools and employers are read only from a sentence that opens on the person: in "Acme, founded by
      // Jane Roe and Bob Smith, a former engineer at Google" the employer is Bob Smith's.
      // ... or one where they are the one doing it, wherever it stands: "The journey began after Shensi and
      // Gil graduated from Columbia" (their name, an optional "and <someone>", then the verb).
      const theirs = doing || opensOnSubject(subject, s, { firstName: fromBioPage });

      if (coRe) {
        const a = s.match(new RegExp(`(${TITLES})\\s*(?:of|at|,|@)\\s+(?:the\\s+)?${esc(company)}(?![\\p{L}\\p{N}])`, 'iu'));
        const b = s.match(new RegExp(`(?<![\\p{L}\\p{N}])${esc(company)}(?:'s)?,?\\s+(${TITLES})(?![\\p{L}])`, 'iu'));
        for (const m of [a, b]) {
          if (!m) continue;
          // "former CEO of Merge" is not their role now
          if (/\b(?:former|ex-?|then-?)\s*$/i.test(s.slice(0, m.index))) continue;
          for (const label of titlesIn(m[1])) {
            if (!titleVotes.has(label)) titleVotes.set(label, new Set());
            titleVotes.get(label).add(f.id);
          }
        }
      }
      if (theirs && EDU_WORD.test(s)) {
        SCHOOL.lastIndex = 0;
        for (const m of s.matchAll(SCHOOL)) addSchool(m[0], f.id, spanAfter(s, m[0]));
      }
      for (const re of theirs ? PRIOR : []) {
        re.lastIndex = 0;
        for (const m of s.matchAll(re)) {
          const list = String(m.groups.orgs || '').split(/,\s+and\s+|\s+and\s+(?=[A-Z])|,\s+/);
          const role = m.groups.role && !/\b(?:who|which|that|is|was|the)\b/i.test(m.groups.role) ? m.groups.role : null;
          for (const org of list) addOrg(org, list.length === 1 ? role : null, f.id, spanAfter(s, trimOrg(org)));
        }
      }
      if (theirs) {
        const based = s.match(/\b(?:is|are|was|now|currently)?\s*based (?:in|out of)\s+([A-Z][\p{L}.'’-]+(?:(?:,\s*|\s+)[A-Z][\p{L}.'’-]+){0,3})/u);
        if (based) addPlace(based[1], f.id);
      }
      if (named && BIO_WORD.test(s) && s.length >= 60 && s.length <= 300 && /[.!?]["”']?$/.test(s) && !/\s[—–|]\s/.test(s) && about.length < 40) about.push({ text: s, id: f.id, bio: fromBioPage, hasCo: Boolean(coRe && coRe.test(s)) });
    }
  }

  // The role most records give; a title one record alone gives is kept only when nothing else is known.
  const ranked = [...titleVotes.entries()].sort((a, b) => b[1].size - a[1].size);
  const top = ranked[0]?.[1].size || 0;
  const kept = ranked.filter(([, ids]) => ids.size >= Math.max(1, Math.ceil(top / 3))).map(([label]) => label);
  const order = TITLE_FORMS.map(([, label]) => label);
  // "Co-Founder" already says founder
  if (kept.includes('Co-Founder') && kept.includes('Founder')) kept.splice(kept.indexOf('Founder'), 1);
  kept.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const headline = kept.length ? `${kept.slice(0, 3).join(kept.length === 2 ? ' and ' : ', ')}${company ? `, ${company}` : ''}` : null;
  const headlineIds = [...new Set(kept.flatMap((label) => [...titleVotes.get(label)]))].slice(0, 4);

  // A few sentences of background: from pages about them first, the ones naming the company first, no near-duplicates.
  const picked = [];
  const words = (t) => new Set(t.toLowerCase().match(/[a-z0-9]{4,}/g) || []);
  for (const a of about.sort((x, y) => Number(y.bio) - Number(x.bio) || Number(y.hasCo) - Number(x.hasCo) || y.text.length - x.text.length)) {
    const w = words(a.text);
    const dup = picked.some((p) => { const pw = words(p.text); const shared = [...w].filter((x) => pw.has(x)).length; return shared / Math.max(1, Math.min(w.size, pw.size)) > 0.6; });
    if (!dup) picked.push(a);
    if (picked.length >= 5) break;
  }

  const links = [];
  const seenLink = new Set();
  for (const t of threads || []) {
    if (t.kind !== 'url' || t.trusted === false) continue;
    const p = profileFromUrl(t.value);
    const platform = t.platform || p?.platform || null;
    if (!platform || seenLink.has(platform)) continue;
    seenLink.add(platform);
    links.push({ platform, url: t.value });
  }

  const list = (map, field) => [...map.values()].sort((a, b) => b.ids.size - a.ids.size).slice(0, 10).map((e) => ({ ...e, ids: [...e.ids].slice(0, 4), [field]: e[field] }));
  const place = [...places.values()].sort((a, b) => b.ids.size - a.ids.size)[0] || null;
  return {
    headline, headlineIds,
    titles: kept.slice(0, 3),
    basedIn: place ? { text: place.text, ids: [...place.ids].slice(0, 4) } : null,
    company: company || null,
    education: list(schools, 'school'),
    earlier: list(orgs, 'org'),
    about: picked.map(({ text, id }) => ({ text, id })),
    links,
  };
}
