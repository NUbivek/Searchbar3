/**
 * Reading a record for new threads to pull: earlier companies and schools
 * (with the same extractor the quick brief uses), associates named beside
 * the person, relatives the source places in a public role, and the
 * handles and profile pages a record points to.
 *
 * Relatives are the sensitive part. A relative becomes a thread only when
 * the same sentence gives them a public business, political or
 * philanthropic role ("her father, the chairman of ...", "son of the
 * billionaire ..."). A relative mentioned only as family is ignored, and so
 * is anything about children (guardrails.js). The point is related-party
 * and conflict-of-interest diligence, not a family tree.
 */
import { extractFounderEvidence } from '../founderCheck';
import { makeThread } from './finding';
import { mentionsMinor, isSensitive, isBlockedUrl } from './guardrails';

const NAME = "[A-ZÀ-Þ][a-zA-ZÀ-ÿ'’-]+(?:\\s+(?:[A-Z]\\.|de|van|von|bin|al|del|la|le|[A-ZÀ-Þ][a-zA-ZÀ-ÿ'’-]+)){1,3}";
// The same, also accepting a one-letter surname after a capitalised given
// name ("Cédric O"). Used only where a role word sits right beside the name
// (co-founder, adviser, minister), never on its own.
const NAME_ROLE = `[A-ZÀ-Þ][a-zA-ZÀ-ÿ'’-]+(?:(?:\\s+(?:[A-Z]\\.|de|van|von|bin|al|del|la|le|[A-ZÀ-Þ][a-zA-ZÀ-ÿ'’-]+)){1,3}|\\s+[A-ZÀ-Þ](?![\\wÀ-ÿ'’.-]))`;
const RELATION_WORDS ='father|mother|brother|sister|husband|wife|spouse|partner|uncle|aunt|cousin|grandfather|grandmother|stepfather|stepmother|step-father|step-mother|father-in-law|mother-in-law|brother-in-law|sister-in-law|son-in-law|daughter-in-law|fianc[ée]e?';
const DESCENT_WORDS = 'son|daughter|nephew|niece|grandson|granddaughter|stepson|stepdaughter|scion|heir|heiress';

// A public role: what makes a relative relevant to an investment decision.
// Ordinary jobs and verbs ("a software developer", "a history professor",
// "runs a small bakery", "director of photography") are not public roles:
// those words count only in the qualified forms of QUALIFIED_ROLE, which is
// case-sensitive so that what follows must be a proper name.
const PUBLIC_ROLE = /\b(CEO|CFO|COO|CTO|chief executive|chief \w+ officer|chair(?:man|woman|person)?|president|founder|co-?founder|billionaire|millionaire|magnate|mogul|tycoon|financier|banker|investor|venture capitalist|hedge fund|private equity|fund manager|managing director|general partner|partner at|board member|trustee|philanthropist|industrialist|oligarch|senator|congress(?:man|woman)|representative|governor|mayor|minister|ambassador|diplomat|judge|admiral|politician|member of parliament|\bMP\b|lawmaker|commissioner|secretary of|prime minister|royal|sheikh|family (?:business|office|firm|fortune|company|foundation|trust)|conglomerate|dynasty|empire|seed(?:ed)? (?:investor|money|capital))\b/i;
const QUALIFIED_ROLE = /\b(?:[Rr]eal[ -]estate developer|[Pp]roperty developer|(?:[Mm]anaging |[Nn]on-executive )?[Dd]irector (?:of|at) [A-Z][\w&.-]*|(?:[Dd]irector|[Hh]ead) of [a-z][a-z -]{2,40} (?:at|for) [A-Z][\w&.-]*|(?:[Oo]wner|[Ff]ounder|[Hh]ead) of [A-Z][\w&.-]*|(?:runs|heads|controls|owns|founded) [A-Z][\w&.-]+(?: (?:Inc|LLC|Ltd|Group|Holdings|Capital|Partners|Corp)\.?)?|[Ee]xecutive (?:at|of) [A-Z][\w&.-]*)/;
/** The first public role named in `text` (a match array), or null. */
const matchRole = (text) => {
  const a = text.match(PUBLIC_ROLE);
  const b = text.match(QUALIFIED_ROLE);
  if (a && b) return a.index <= b.index ? a : b;
  return a || b;
};

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Abbreviations whose full stop does not end a sentence ("SEC v. Acme", "Acme Inc. said").
const ABBREVIATION = /\b(v|vs|Inc|Corp|Ltd|Co|Mr|Mrs|Ms|Dr|Jr|Sr|St|No|Prof|Gen|Sen|Rep|Gov)\.(?=\s)/g;
const sentencesOf = (text) => String(text || '').replace(/\s+/g, ' ').replace(ABBREVIATION, '$1\u0001')
  .split(/(?<=[.!?])\s+(?=[A-Z"“])/).map((s) => s.replace(/\u0001/g, '.').trim()).filter((s) => s.length > 12 && s.length < 600);

/**
 * The sentences that are about the subject: the ones that name them, and
 * the ones that follow and carry on with a pronoun ("She founded ...").
 */
function sentencesAbout(subject, text) {
  const out = [];
  let named = false;
  for (const sentence of sentencesOf(text)) {
    if (subject.hasName(sentence)) { named = true; out.push(sentence); } else if (named && /^(She|He|They|Her|His|Their)\b/.test(sentence)) out.push(sentence);
    else if (!/^(She|He|They|Her|His|Their)\b/.test(sentence)) named = false;
  }
  return out;
}
const cleanName = (raw) => String(raw || '').replace(/[’']s$/, '').replace(/[,.;:]+$/, '').trim();
const NOT_NAMES = /^(The|A|An|He|She|They|His|Her|Their|This|That|It|In|On|At|And|But|Mr|Mrs|Ms|Dr|Sir|Lady|Lord|New York|San Francisco|Los Angeles|United States|Silicon Valley|Wall Street|Y Combinator)\b/;

function plausiblePerson(name, subject) {
  const n = cleanName(name);
  const parts = n.split(/\s+/);
  if (parts.length < 2 || parts.length > 5 || n.length > 60) return null;
  if (NOT_NAMES.test(n) || subject.hasName(n)) return null;
  if (/\b(Inc|LLC|Ltd|Corp|Capital|Ventures|Partners|University|College|School|Bank|Group|Holdings|Foundation|Institute|Company|Fund|Labs?|Technologies)\b/.test(n)) return null;
  // "Paris-based AI", "French Tech", "US Senate": places, acronyms and adjectives, not people
  if (parts.some((p) => /-based$/i.test(p) || /^[A-Z]{3,4}$/.test(p) || ACRONYMS_2.has(p))) return null;
  if (NATIONALITY.test(parts[0])) return null;
  return n;
}
// Two-letter capitals that are words, not initials ("AJ Smith" stays a person).
const ACRONYMS_2 = new Set(['AI', 'US', 'UK', 'EU', 'UN', 'VC', 'IT', 'PR', 'HR', 'TV', 'ML', 'AR', 'VR', 'IP', 'BI']);
const NATIONALITY = /^(?:American|British|English|French|German|Italian|Spanish|Portuguese|Dutch|Belgian|Swiss|Austrian|Swedish|Norwegian|Danish|Finnish|Irish|Scottish|Welsh|Polish|Russian|Ukrainian|Greek|Turkish|Israeli|Arab|Saudi|Emirati|Qatari|Iranian|Indian|Pakistani|Chinese|Japanese|Korean|Taiwanese|Vietnamese|Thai|Indonesian|Singaporean|Malaysian|Filipino|Australian|Canadian|Mexican|Brazilian|Argentine|Argentinian|Chilean|Colombian|Peruvian|African|Nigerian|Kenyan|Egyptian|South|North|East|West|European|Asian|Parisian|Californian|Texan|Federal|National|State|Global|International)$/;

/**
 * The public role a sentence gives to `name`: a role word right after the
 * name ("John Roe, chairman of ...") or just before it ("billionaire John
 * Roe"). A role that belongs to the subject ("Acme founder Jane Doe's
 * brother John Roe") does not count, so the words before the name are only
 * read from where the subject's own name ends.
 */
function roleNear(subject, sentence, name) {
  const at = sentence.indexOf(name);
  if (at < 0) return null;
  const after = matchRole(sentence.slice(at + name.length, at + name.length + 90));
  if (after) return after;
  let before = sentence.slice(Math.max(0, at - 48), at);
  for (const variant of subject.variants || [subject.name]) {
    const cut = before.toLowerCase().lastIndexOf(String(variant).toLowerCase());
    if (cut >= 0) before = before.slice(cut + String(variant).length);
  }
  return matchRole(before);
}

/**
 * Relatives named with a public role in the same sentence.
 * @returns {Array<{ name: string, relation: string, role: string, sentence: string }>}
 */
export function relativesFromText(subject, text) {
  const out = [];
  const seen = new Set();
  const add = (rawName, relation, sentence) => {
    const name = plausiblePerson(rawName, subject);
    if (!name || seen.has(name.toLowerCase())) return;
    if (mentionsMinor(sentence) || isSensitive(sentence)) return;
    const role = roleNear(subject, sentence, cleanName(rawName));
    if (!role) return; // family only: not our business
    seen.add(name.toLowerCase());
    out.push({ name, relation: relation.toLowerCase().replace(/^step-/, 'step'), role: role[0], sentence });
  };
  for (const sentence of sentencesAbout(subject, text)) {
    // "her father, John Roe, chairman of ..." / "his brother John Roe"
    for (const m of sentence.matchAll(new RegExp(`\\b(?:[Hh]is|[Hh]er|[Tt]heir|whose)\\s+(?:late\\s+|older\\s+|younger\\s+|elder\\s+|twin\\s+|former\\s+|then-)?(${RELATION_WORDS})\\s*,?\\s+(${NAME})`, 'g'))) add(m[2], m[1], sentence);
    // "John Roe, her father and chairman of ..."
    for (const m of sentence.matchAll(new RegExp(`(${NAME}),\\s+(?:his|her|their)\\s+(${RELATION_WORDS})\\b`, 'g'))) add(m[1], m[2], sentence);
    // "the son of billionaire John Roe" / "daughter of John Roe, founder of ..."
    for (const m of sentence.matchAll(new RegExp(`\\b(${DESCENT_WORDS})\\s+of\\s+(?:the\\s+)?(?:late\\s+)?(?:[a-z-]+\\s+){0,4}?(${NAME})`, 'g'))) {
      const relation = { son: 'parent', daughter: 'parent', stepson: 'stepparent', stepdaughter: 'stepparent', nephew: 'uncle or aunt', niece: 'uncle or aunt', grandson: 'grandparent', granddaughter: 'grandparent', scion: 'family', heir: 'family', heiress: 'family' }[m[1].toLowerCase()];
      add(m[2], relation, sentence);
    }
    // "married to John Roe, a partner at ..."
    for (const m of sentence.matchAll(new RegExp(`\\bmarried\\s+(?:to\\s+)?(${NAME})`, 'g'))) add(m[1], 'spouse', sentence);
  }
  return out;
}

/**
 * Does `text` itself state that `name` is a relative, in a sentence that
 * also gives a public role? Used to check a relative proposed by something
 * other than the patterns above (a model's reading of the record) against
 * the same rule. Returns { relation, role, sentence } or null.
 */
export function publicRelativeIn(subject, text, name) {
  const person = plausiblePerson(name, subject);
  if (!person) return null;
  const nameRe = new RegExp(`(?<![A-Za-z])${escapeRe(person)}(?![A-Za-z])`);
  const kin = new RegExp(`\\b(${RELATION_WORDS}|${DESCENT_WORDS}|married|parents?|sibling|relative|family)\\b`, 'i');
  for (const sentence of sentencesOf(text)) {
    if (!nameRe.test(sentence)) continue;
    const relation = sentence.match(kin);
    const role = roleNear(subject, sentence, person);
    if (!relation || !role) continue;
    if (mentionsMinor(sentence) || isSensitive(sentence)) continue;
    return { name: person, relation: relation[1].toLowerCase(), role: role[0], sentence };
  }
  return null;
}

/** A name that reads like a person's (two to five capitalised words, not an organisation, not the subject). */
export const plausiblePersonName = (name, subject) => plausiblePerson(name, subject);

/** People named beside the subject as co-founders, partners or co-defendants. */
export function associatesFromText(subject, text) {
  const out = new Map();
  const add = (rawName, why) => {
    const name = plausiblePerson(rawName, subject);
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), { name, why });
  };
  // Is the subject the one a successor took over from? Their name or a
  // pronoun must come earlier in the same sentence.
  const subjectBefore = (sentence, at) => {
    const before = sentence.slice(Math.max(0, at - 90), at);
    return subject.hasName(before) || /\b(?:he|she|they|him|her|them)\b/i.test(before);
  };
  for (const sentence of sentencesAbout(subject, text)) {
    // The filler ("co-founder and chief scientist Tim Lee") never crosses
    // of / the / at: "co-founder and CEO of Acme Jane Roe" names no one else.
    for (const m of sentence.matchAll(new RegExp(`\\bco-?founders?\\s+(?:and\\s+(?:(?!(?:of|the|at)\\b)[A-Za-z]+\\s+){1,4}?)?(${NAME_ROLE})(?:\\s+and\\s+(${NAME_ROLE}))?`, 'g'))) {
      // "PayPal co-founders Elon Musk and Peter Thiel": co-founders of another company, not of the person's
      const lead = sentence.slice(Math.max(0, m.index - 40), m.index).match(/([A-Z][\w&.'-]+(?:\s+[A-Z][\w&.'-]+)?)\s*$/);
      const ofAnother = lead && !subject.hasName(lead[1]) && ![...subject.anchors.companies.values()].some((a) => a.test(lead[1]));
      if (ofAnother) continue;
      add(m[1], 'named as a co-founder');
      if (m[2]) add(m[2], 'named as a co-founder');
    }
    for (const m of sentence.matchAll(new RegExp(`(${NAME})\\s+and\\s+(${NAME})\\s*,?\\s+(?:the\\s+)?(?:co-?founders|founders|who\\s+(?:co-?)?founded)`, 'g'))) { add(m[1], 'named as a co-founder'); add(m[2], 'named as a co-founder'); }
    // "founders Jane Roe and Bob Smith turned ...", "co-founders Bob Smith and Jane Roe": one of the two is the subject
    for (const m of sentence.matchAll(new RegExp(`\\b(?:[Cc]o-?)?[Ff]ounders\\s+(${NAME})\\s+and\\s+(${NAME})`, 'g'))) {
      if (!subject.hasName(m[1]) && !subject.hasName(m[2])) continue;
      add(m[1], 'named as a co-founder');
      add(m[2], 'named as a co-founder');
    }
    // "Jane Roe and Bob Smith co-founded Acme", "Jane Roe and Bob Smith, started Acme in 2020": one of the two
    // is the subject (plausiblePerson drops them), and a company name or "the company" must follow
    for (const m of sentence.matchAll(new RegExp(`(${NAME})\\s+and\\s+(${NAME})\\s*,?\\s+(?:co-?founded|founded|started|launched)\\s+(?=[A-Z]|the\\s+company\\b|a\\s+company\\b)`, 'g'))) {
      if (!subject.hasName(m[1]) && !subject.hasName(m[2])) continue;
      add(m[1], 'founded a company together');
      add(m[2], 'founded a company together');
    }
    for (const m of sentence.matchAll(new RegExp(`\\b(?:co-?founded|founded|started|launched)\\s+[^.]{0,60}?\\s+(?:with|alongside|together with)\\s+(?:(?:former|fellow|then|ex)[ -])?(?:(?:[a-z-]+\\s+){0,2}?(?:minister|secretary|advis[eo]r|colleague|classmate|researcher|engineer|scientist)\\s+)?(${NAME_ROLE})(?:\\s+and\\s+(${NAME_ROLE}))?`, 'g'))) { add(m[1], 'founded a company together'); if (m[2]) add(m[2], 'founded a company together'); }
    // "adviser Jane Doe" / "former minister Cédric O, an adviser to ..."
    for (const m of sentence.matchAll(new RegExp(`\\b(?:advis[eo]rs?|minister)\\s*,?\\s+(${NAME_ROLE})`, 'g'))) add(m[1], 'named as an adviser or official beside the person');
    // Successors: "turned over the CEO role to John Roe", "was succeeded as CEO by John Roe",
    // "John Roe succeeded him", "was replaced by John Roe as chairman"
    for (const m of sentence.matchAll(new RegExp(`\\bturned\\s+over\\s+(?:the\\s+|his\\s+|her\\s+|their\\s+)?(?:CEO|chief executive(?: officer)?|chair(?:man|woman|person)?|president|top)\\s+(?:role|job|post|position|reins|title|seat)\\s+to\\s+(${NAME})`, 'g'))) if (subjectBefore(sentence, m.index)) add(m[1], 'succeeded the person in a role');
    for (const m of sentence.matchAll(new RegExp(`\\bsucceeded\\s+(?:as\\s+(?:[A-Za-z-]+\\s+){1,3}?)?by\\s+(${NAME})`, 'g'))) if (subjectBefore(sentence, m.index)) add(m[1], 'succeeded the person in a role');
    for (const m of sentence.matchAll(new RegExp(`\\breplaced\\s+by\\s+(${NAME})\\s+as\\b`, 'g'))) if (subjectBefore(sentence, m.index)) add(m[1], 'succeeded the person in a role');
    for (const m of sentence.matchAll(new RegExp(`(${NAME})\\s+succeeded\\s+(?:him|her|them)\\b`, 'g'))) add(m[1], 'succeeded the person in a role');
    for (const m of sentence.matchAll(new RegExp(`\\b(?:co-?defendants?|co-?conspirators?|business partners?|longtime partner|former partner)\\s*,?\\s+(${NAME})`, 'g'))) add(m[1], 'named as a co-defendant or business partner');
    for (const m of sentence.matchAll(new RegExp(`\\b(?:v\\.|vs\\.?|versus)\\s+(?:[A-Z][A-Za-z.&' -]{0,40}?,\\s+)?(${NAME})\\s+and\\s+(${NAME})`, 'g'))) { add(m[1], 'co-party in a case'); add(m[2], 'co-party in a case'); }
    if (readsFrench(sentence)) frenchAssociates(subject, sentence, add);
  }
  return [...out.values()];
}

// French function words that are not also English words or name particles.
const FRENCH_WORDS = /(?<![\wÀ-ÿ])(?:avec|les|des|du|une|est|dans|pour|qui|ses|aux|sont|été|ont|elle|il|chez|ancien(?:ne)?|société|fondé(?:e|s|es)?|aussi|depuis)(?![\wÀ-ÿ])/gi;
/** Is this sentence written in French? French letters, or two French function words. */
const readsFrench = (sentence) => /[çèêëàâùûîïôœ]/i.test(sentence) || new Set((sentence.match(FRENCH_WORDS) || []).map((w) => w.toLowerCase())).size >= 2;
const ROLE_FR = "actionnaire|conseill(?:er|ère)(?:\\s+en\\s+[a-zé]+(?:\\s+[a-zé]+){0,2})?|administrat(?:eur|rice)|membre du conseil d['’]administration|investisseur|co-?fondat(?:eur|rice)";
const ROLE_FR_LABEL = (role) => /actionnaire|investisseur/i.test(role) ? 'named as a shareholder or investor beside the person'
  : /fondat/i.test(role) ? 'named as a co-founder'
  : /administrat|conseil d/i.test(role) ? 'named as a board member beside the person'
  : 'named as an adviser or official beside the person';

/**
 * The French forms of the co-founder, "founded with" and "<Name>, adviser"
 * patterns, for a sentence about the subject written in French. A role tied
 * to a company ("actionnaire de Beta") counts only when that company is one
 * of the subject's: a shareholder of someone else's firm is not an associate.
 */
function frenchAssociates(subject, sentence, add) {
  const ofSubjectsCompany = (rest) => {
    const m = String(rest).match(/^\s*(?:de\s+la\s+|de\s+l['’]|de\s+|d['’]|du\s+|chez\s+)([A-ZÀ-Þ][\wÀ-ÿ&'’.-]*(?:\s+[A-ZÀ-Þ0-9][\wÀ-ÿ&'’.-]*){0,3})/);
    if (!m) return true; // no company named: the role is read beside the person, as in English
    return [...subject.anchors.companies.values()].some((a) => a.test(m[1]));
  };
  // "ses cofondateurs Guillaume Lample et Timothée Lacroix"
  for (const m of sentence.matchAll(new RegExp(`\\bco-?fondat(?:eur|rice)s?\\s+(${NAME_ROLE})(?:\\s+et\\s+(${NAME_ROLE}))?`, 'g'))) {
    add(m[1], 'named as a co-founder');
    if (m[2]) add(m[2], 'named as a co-founder');
  }
  // "a cofondé Acme en 2023 avec Guillaume Lample et Timothée Lacroix"
  for (const m of sentence.matchAll(new RegExp(`\\b(?:co-?fond[ée]|fond[ée]|cr[ée]{2}|lanc[ée])e?s?\\s+[^.]{0,60}?\\s+(?:avec|aux\\s+côtés\\s+de|en\\s+compagnie\\s+de)\\s+(?:l['’]ancien(?:ne)?\\s+(?:[a-zé'’-]+\\s+){0,3}?)?(${NAME_ROLE})(?:\\s+et\\s+(${NAME_ROLE}))?`, 'g'))) {
    add(m[1], 'founded a company together');
    if (m[2]) add(m[2], 'founded a company together');
  }
  // "Cédric O, l'ancien secrétaire d'État, actionnaire et conseiller de Acme"
  for (const m of sentence.matchAll(new RegExp(`(${NAME_ROLE})\\s*,\\s+(?:l['’]|le\\s+|la\\s+|un\\s+|une\\s+)?(?:ancien(?:ne)?\\s+[^,]{0,40},?\\s+)?(?:(?:et|devenu|devenue)\\s+)?(${ROLE_FR})\\b`, 'g'))) {
    const rest = sentence.slice(m.index + m[0].length).replace(new RegExp(`^(?:\\s+et\\s+(?:${ROLE_FR}))*`), '');
    if (ofSubjectsCompany(rest)) add(m[1], ROLE_FR_LABEL(m[2]));
  }
  // "le conseiller Cédric O" / "l'ancien ministre Cédric O"
  for (const m of sentence.matchAll(new RegExp(`\\b(?:conseill(?:er|ère)|ministre|actionnaire)s?\\s*,?\\s+(${NAME_ROLE})`, 'g'))) add(m[1], 'named as an adviser or official beside the person');
}

// A company name: capitalised words ("St. George Security and Alarm") or a
// camel-case word that starts lower case ("dHybrid", "eBay").
const CO_TOKEN = "(?:[A-ZÀ-Þ0-9][\\wÀ-ÿ&'’.-]*|[a-z][A-Z][\\w-]+)";
const CO_NAME = `${CO_TOKEN}(?:\\s+(?:(?:and|of|&|for|de)\\s+)?${CO_TOKEN}){0,5}`;
const CAMEL = "[a-z][A-Z][\\w-]+";

/**
 * Companies a sentence about the subject names in forms the quick brief's
 * extractor misses: "a company called dHybrid", "founded eBay".
 * @returns {Array<{ name: string, why: string }>}
 */
export function companiesFromText(subject, text) {
  const out = new Map();
  const add = (raw, why) => {
    let name = String(raw || '').replace(/[,.;:]+$/, '').trim();
    // "a company called Acme and John Roe joined": the part after "and" is a person, not the name
    const and = name.match(/^(.+?)\s+and\s+(.+)$/);
    if (and && plausiblePerson(and[2], subject)) name = and[1];
    if (name.length < 2 || subject.hasName(name) || /^(?:The|A|An|In|On|At)$/.test(name)) return;
    if (!out.has(name.toLowerCase())) out.set(name.toLowerCase(), { name, why });
  };
  // A capitalised name read after "founded" or beside "a startup," may be the
  // company the person is known for, a publisher or a date: only a name that
  // is none of those is an earlier venture.
  const given = [...subject.anchors.companies.values()].filter((a) => a.origin === 'given');
  const addVenture = (raw, why) => {
    const name = String(raw || '').replace(/[,.;:]+$/, '').trim();
    if (!/^(?:[A-ZÀ-Þ0-9]|[a-z][A-Z])/.test(name) || PUBLISHERS.test(name) || NOT_VENTURES.test(name)) return;
    if (given.some((a) => a.test(name))) return;
    add(name, why);
  };
  for (const sentence of sentencesAbout(subject, text)) {
    for (const m of sentence.matchAll(new RegExp(`\\b(?:company|companies|business|businesses|firm|startups?|start-ups?|venture)\\s+(?:called|named)\\s+(${CO_NAME})`, 'g'))) add(m[1], 'company named with the person');
    for (const m of sentence.matchAll(new RegExp(`\\b(?:co-?founded|founded|started|launched|created)\\s+(${CAMEL})`, 'g'))) add(m[1], 'company the person started');
    for (const m of sentence.matchAll(new RegExp(`\\b(?:co-?founded|founded)\\s+(${CO_NAME})`, 'g'))) addVenture(m[1], 'company the person started');
    for (const m of sentence.matchAll(new RegExp(`\\ban?\\s+(?:online\\s+)?(?:marketplace|company|startup|start-up),\\s+(${CO_NAME})`, 'g'))) addVenture(m[1], 'company named with the person');
  }
  return [...out.values()];
}
const PUBLISHERS = /^(?:The\s+)?(?:Wall Street Journal|WSJ|Business Insider|Insider|Bloomberg|Reuters|Forbes|Fortune|TechCrunch|CNBC|CNN|BBC|New York Times|NYT|Washington Post|Financial Times|FT|Verge|Wired|Axios|Associated Press|AP|Information|Guardian|Economist|Atlantic|Le Monde|Les Echos|Le Figaro|Handelsblatt|El País)\b/;
const NOT_VENTURES = /^(?:The|A|An|In|On|At|By|His|Her|Their|It|That|This|January|February|March|April|May|June|July|August|September|October|November|December|\d)\b/;

const PROFILE_HOSTS = [
  [/^(?:[a-z]{2,3}\.)?linkedin\.com$/, /^\/(?:in|pub)\/([^/?#]+)/, 'linkedin'],
  [/^github\.com$/, /^\/([A-Za-z0-9-]{2,39})\/?$/, 'github'],
  [/^(?:twitter|x)\.com$/, /^\/([A-Za-z0-9_]{2,15})\/?$/, 'x'],
  [/^(?:www\.)?crunchbase\.com$/, /^\/person\/([^/?#]+)/, 'crunchbase'],
  [/^(?:angel\.co|wellfound\.com)$/, /^\/(?:u|p)\/([^/?#]+)/, 'wellfound'],
  [/^about\.me$/, /^\/([^/?#]+)/, 'about.me'],
  [/^medium\.com$/, /^\/@([^/?#]+)/, 'medium'],
  [/^([a-z0-9-]+)\.substack\.com$/, null, 'substack'],
];
const NOT_HANDLES = new Set(['home', 'search', 'explore', 'login', 'signup', 'about', 'pricing', 'features', 'orgs', 'topics', 'i', 'intent', 'share', 'hashtag', 'company', 'jobs', 'pulse', 'feed']);

/**
 * A profile page and handle from a URL, when it is one.
 * @returns {{ platform: string, handle: string, url: string } | null}
 */
export function profileFromUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  for (const [hostRe, pathRe, platform] of PROFILE_HOSTS) {
    const hm = host.match(hostRe);
    if (!hm) continue;
    const handle = pathRe ? (u.pathname.match(pathRe) || [])[1] : hm[1];
    if (!handle || NOT_HANDLES.has(handle.toLowerCase())) return null;
    return { platform, handle: decodeURIComponent(handle), url: `https://${host}${pathRe ? u.pathname.replace(/\/$/, '') : ''}` };
  }
  return null;
}

/**
 * Does this handle plausibly belong to the subject? It must contain one of
 * their full name slugs (firstlast, flast, lastfirst ...); a bare first name
 * or surname ("jack", "collison") is shared by too many people to fit.
 */
export function handleFitsSubject(subject, handle) {
  const h = String(handle || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!h) return false;
  return subject.slugs.some((slug) => {
    const s = slug.replace(/[^a-z0-9]/g, '');
    return s.length > 0 && h.includes(s);
  });
}

/**
 * Every thread a web-style result (title, snippet, url) offers.
 * `trusted` says whether the result itself is tied to the subject; only
 * then are its threads followed.
 * @param {object} subject
 * @param {{ title?: string, snippet?: string, url?: string, date?: string }} result
 * @param {{ trusted: boolean }} options
 */
export function threadsFromResult(subject, result, { trusted }) {
  const threads = [];
  const title = String(result?.title || '');
  // The snippet and any quote the record carries: a confirmed press record's
  // title alone rarely names the earlier ventures its body covers.
  const quote = String(result?.quote || '');
  const body = String(result?.snippet || result?.content || '');
  const snippet = quote && !body.includes(quote) ? `${body}${body ? ' ' : ''}${quote}` : body;
  const text = `${title}. ${snippet}`;
  // Companies and schools: the quick brief's extractor, run on this one result.
  const evidence = extractFounderEvidence({ name: subject.hasName, company: subject.company, results: [{ title, snippet, url: result?.url || 'https://example.invalid/', source: 'web' }], keepAllSources: true });
  for (const c of evidence.pastCompanies) {
    threads.push(makeThread('company', c.company, c.role ? `${c.role}${c.status === 'past' ? ' (past)' : ''}` : c.status === 'past' ? 'earlier company' : 'named with the person', { trusted }));
  }
  const seenCompany = new Set(evidence.pastCompanies.map((c) => String(c.company).toLowerCase()));
  for (const c of companiesFromText(subject, text)) {
    if (seenCompany.has(c.name.toLowerCase())) continue;
    seenCompany.add(c.name.toLowerCase());
    threads.push(makeThread('company', c.name, c.why, { trusted }));
  }
  for (const e of evidence.education) threads.push(makeThread('school', e.school, 'named as their school', { trusted }));
  for (const a of associatesFromText(subject, text)) threads.push(makeThread('associate', a.name, a.why, { trusted }));
  for (const r of relativesFromText(subject, text)) threads.push(makeThread('relative', r.name, `${r.relation}; ${r.role}`, { trusted, relation: r.relation, role: r.role }));
  const profile = profileFromUrl(result?.url);
  // A profile is only as trusted as the result it came from: a title that
  // merely repeats the name ("John Smith (johnsmith) · GitHub") may be a namesake.
  if (profile && handleFitsSubject(subject, profile.handle)) {
    threads.push(makeThread('url', profile.url, `${profile.platform} profile`, { trusted, platform: profile.platform }));
    if (profile.platform === 'github' || profile.platform === 'x') threads.push(makeThread('handle', profile.handle, `${profile.platform} handle`, { trusted, platform: profile.platform }));
  }
  return threads.filter(Boolean);
}

/** A word-boundary test for an arbitrary phrase (used by connectors to check a page names something). */
export const mentions = (text, phrase) => new RegExp(`(?<![A-Za-z0-9])${escapeRe(phrase)}(?![A-Za-z0-9])`, 'i').test(String(text || ''));

/* ------------------------------------------------------------------ structured data on a page */

const decodeEntities = (s) => String(s || '')
  .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/gi, "'")
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ' '; } })
  .replace(/&#x([0-9a-f]+);/gi, (m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ' '; } })
  .replace(/&amp;/gi, '&');
const plain = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const asList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const typesOf = (node) => asList(node?.['@type']).map((t) => String(t).replace(/^.*[/#]/, '').toLowerCase());
/** The name of a schema.org value: a string, or an object with a name. */
const nameOf = (v) => {
  if (typeof v === 'string') return plain(v).slice(0, 120);
  if (v && typeof v === 'object' && typeof v.name === 'string') return plain(v.name).slice(0, 120);
  return '';
};
const MAX_LD_BLOCKS = 20;
const MAX_LD_CHARS = 200000;
const MAX_NODES = 400;

/** Every object in a JSON-LD document (graphs, nested values, lists), up to a limit. */
function ldNodes(doc) {
  const out = [];
  const stack = [doc];
  while (stack.length && out.length < MAX_NODES) {
    const v = stack.pop();
    if (Array.isArray(v)) { for (const x of v) stack.push(x); continue; }
    if (!v || typeof v !== 'object') continue;
    out.push(v);
    for (const [k, x] of Object.entries(v)) if (k !== '@context' && x && typeof x === 'object') stack.push(x);
  }
  return out;
}

/** Only fields that say where someone worked and studied and where their profiles are: never contact, birth or family fields. */
function personOf(node) {
  const name = nameOf(node);
  if (!name) return null;
  const titles = asList(node.jobTitle).map(nameOf).filter(Boolean).slice(0, 4);
  const employers = asList(node.worksFor).map(nameOf).filter(Boolean).slice(0, 6);
  const schools = asList(node.alumniOf).map(nameOf).filter(Boolean).slice(0, 6);
  const links = asList(node.sameAs).map((u) => String(typeof u === 'string' ? u : u?.url || '').trim()).filter((u) => /^https?:\/\/[^\s]+$/i.test(u)).slice(0, 10);
  return { name, titles, employers, schools, links };
}

/**
 * What a page states about people in machine-readable form, besides its visible text:
 *   persons        JSON-LD Person nodes (also the main entity of a ProfilePage): name, job titles,
 *                  employers (worksFor), schools (alumniOf) and profile links (sameAs)
 *   organizations  JSON-LD Organization nodes with their founders' names
 *   descriptions   the page's own summary lines (meta description, OpenGraph description)
 *   definitions    term and value pairs of definition lists ("Education: Columbia University")
 * Contact details, birth dates, addresses and family fields are never read.
 */
export function structuredData(html) {
  const src = String(html || '');
  const persons = [];
  const organizations = [];
  let blocks = 0;
  for (const m of src.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    if ((blocks += 1) > MAX_LD_BLOCKS) break;
    const body = m[1].trim();
    if (!body || body.length > MAX_LD_CHARS) continue;
    let doc;
    try { doc = JSON.parse(body.replace(/^<!\[CDATA\[|\]\]>$/g, '')); } catch { continue; }
    for (const node of ldNodes(doc)) {
      const types = typesOf(node);
      if (types.includes('person')) {
        const p = personOf(node);
        if (p && !persons.some((x) => x.name === p.name && x.titles.join() === p.titles.join() && x.employers.join() === p.employers.join())) persons.push(p);
      } else if (types.some((t) => /organization|corporation|company/.test(t))) {
        const name = nameOf(node);
        const founders = asList(node.founder).concat(asList(node.founders)).map(nameOf).filter(Boolean).slice(0, 8);
        if (name && founders.length) organizations.push({ name, founders });
      }
    }
  }
  const descriptions = [];
  for (const m of src.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (tag.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i) || [])[1]?.toLowerCase();
    if (key !== 'description' && key !== 'og:description') continue;
    const content = plain((tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i) || [])[1]);
    if (content.length >= 20 && !descriptions.includes(content)) descriptions.push(content.slice(0, 600));
  }
  const definitions = [];
  // bounded: a page with a thousand unclosed <dl> or <dt> tags must not cost a second pass each
  scan: for (const dl of src.slice(0, 600000).matchAll(/<dl\b[^>]*>([\s\S]{0,20000}?)<\/dl>/gi)) {
    for (const pair of dl[1].matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*((?:<dd\b[^>]*>[\s\S]*?<\/dd>\s*)+)/gi)) {
      const term = plain(pair[1]).replace(/:$/, '');
      const value = [...pair[2].matchAll(/<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)].map((d) => plain(d[1])).filter(Boolean).join('; ');
      if (term && value && term.length <= 40 && value.length <= 300) definitions.push({ term, value });
      if (definitions.length >= 40) break scan;
    }
  }
  return { persons, organizations, descriptions, definitions };
}

/** Terms of a definition list that describe a career or an education. */
const BIO_TERMS = /^(?:education|alma mater|school|university|degrees?|studied|previously|prior experience|past (?:roles?|experience|companies)|previous (?:roles?|companies|experience)|experience|background|career|work history|employers?|company|current (?:role|company)|role|title|position|founded|co-?founded)$/i;

/**
 * Facts about the subject a page states in structured form. Only a Person whose own name is the subject's
 * counts; an organisation counts when the subject is one of its listed founders (the other founders are
 * co-founders). Returns null when the page states nothing about them.
 *   line        one sentence quoting the stated values, opening on the person's name (what the profile reads)
 *   employers, schools, titles, links, cofounders, companiesFounded
 */
export function personFacts(subject, data, { definitionsAreTheirs = false } = {}) {
  const mine = (data?.persons || []).filter((p) => subject.hasName(p.name) && plausibleFullName(p.name));
  const founded = (data?.organizations || []).filter((o) => o.founders.some((f) => subject.hasName(f)));
  const defs = definitionsAreTheirs ? (data?.definitions || []).filter((d) => BIO_TERMS.test(d.term)).slice(0, 8) : [];
  if (!mine.length && !founded.length && !defs.length) return null;
  const uniq = (list) => [...new Map(list.filter(Boolean).map((x) => [x.toLowerCase(), x])).values()];
  const titles = uniq(mine.flatMap((p) => p.titles)).slice(0, 4);
  const employers = uniq(mine.flatMap((p) => p.employers)).slice(0, 6);
  const schools = uniq(mine.flatMap((p) => p.schools)).slice(0, 6);
  const links = uniq(mine.flatMap((p) => p.links)).slice(0, 10);
  const companiesFounded = uniq(founded.map((o) => o.name)).slice(0, 4);
  const cofounders = uniq(founded.flatMap((o) => o.founders.filter((f) => !subject.hasName(f)))).filter((n) => plausiblePerson(n, subject)).slice(0, 6);
  const parts = [];
  if (titles.length) parts.push(`job title: ${titles.join('; ')}`);
  if (employers.length) parts.push(`works for: ${employers.join('; ')}`);
  if (schools.length) parts.push(`alumni of: ${schools.join('; ')}`);
  for (const o of founded) parts.push(`listed as a founder of ${o.name}${o.founders.length > 1 ? ` with ${o.founders.filter((f) => !subject.hasName(f)).join(', ')}` : ''}`);
  for (const d of defs) parts.push(`${d.term.toLowerCase()}: ${d.value}`);
  if (!parts.length) return null;
  const name = mine[0]?.name || subject.name;
  return { name, line: `${name} — ${parts.join('; ')}.`, titles, employers, schools, links, cofounders, companiesFounded, definitions: defs };
}
/** Two or more words: a lone first name in a Person node is not enough to say who it is. */
const plausibleFullName = (n) => String(n || '').trim().split(/\s+/).length >= 2;

/**
 * The threads the structured facts give. `trusted` comes from the record (is the page tied to the person),
 * and profile links are followed only when the Person node itself carries the subject's name.
 */
export function threadsFromFacts(subject, facts, { trusted }) {
  if (!facts) return [];
  const out = [];
  for (const org of facts.employers) {
    if (subject.hasName(org)) continue;
    // "Founder, Merge" names the role at this employer; with one employer, the job title is the role there
    const role = facts.titles.find((t) => mentions(t, org)) || (facts.employers.length === 1 && facts.titles.length === 1 ? facts.titles[0] : '');
    out.push(makeThread('company', org, role ? `${role} (listed in the page data of their profile)` : 'employer listed in the page data of their profile', { trusted }));
  }
  for (const org of facts.companiesFounded) out.push(makeThread('company', org, 'founder (listed in the page data of the company)', { trusted }));
  for (const school of facts.schools) out.push(makeThread('school', school, 'school listed in the page data of their profile', { trusted }));
  for (const name of facts.cofounders) out.push(makeThread('associate', name, 'named as a co-founder', { trusted }));
  for (const link of facts.links) {
    if (isBlockedUrl(link)) continue;
    const profile = profileFromUrl(link);
    if (profile) {
      out.push(makeThread('url', profile.url, `${profile.platform} profile (linked from a page about them)`, { trusted, platform: profile.platform }));
      if ((profile.platform === 'github' || profile.platform === 'x') && handleFitsSubject(subject, profile.handle)) out.push(makeThread('handle', profile.handle, `${profile.platform} handle`, { trusted, platform: profile.platform }));
    } else {
      out.push(makeThread('url', link.replace(/[?#].*$/, '').replace(/\/$/, ''), 'linked from a page about them', { trusted }));
    }
  }
  return out.filter(Boolean);
}
