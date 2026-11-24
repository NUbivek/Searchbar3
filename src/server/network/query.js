/**
 * "Ask your network": a deterministic matching engine over the user's own
 * imported contacts.
 *
 *   parseQuestion("Who do I know at Stripe?")
 *     -> { companies: ['Stripe'], roles: [], keywords: [], locations: [], tags: [],
 *          industries: [], connected: null, intent: 'who-at', lens: null }
 *
 * It speaks the page's own vocabulary, read from the user's file: role
 * questions count the map's families ("Which investors do I know?" lists
 * exactly the investors chip's people), and it knows the file's companies
 * (however long their names), tags ("prospects in New York", "everyone tagged
 * committed"), the map's industry labels ("founders in Big Tech"), the file's
 * cities, its people's names, and when people were connected ("this year",
 * "in 2024", "in the last 12 months", "recently"). Every shortcut's label
 * typed back as a question lists exactly that shortcut's people.
 *
 * "not at Google", "except investors", "outside New York" leave those people
 * out. Words it could not use are named back ("Not used: …"), never dropped
 * silently.
 *
 *   scoreContacts(contacts, filters) -> ranked matches, each with reasons, and
 *                                      `keys`: every match's contact key, uncapped
 *   introPaths(contacts, 'Stripe')    -> direct contacts + contacts at Stripe's investors
 *
 * Optionally an LLM turns an unusual question into the same filter shape. It
 * is asked only when the rules read nothing at all from a question the user
 * typed, and it only ever receives that question's text: never contact data,
 * never a word taken from the file. Contacts are never sent to any external
 * service.
 */
import { chatComplete } from '../llm/providers';
import { buildCompanyProfile } from '../companyProfile';
import { normalizeCompanyKey, companyMatch, dedupeKey, isPlaceholderCompany } from '../../utils/network/parseContacts';

import { classifyContact, lensFromQuestion, LENS_KEYS, LENS_PATTERNS, FAMILIES, familyByKey } from '../../utils/network/roles';
import { KEYWORD_GROUPS } from '../../utils/network/sectors';
import * as grouping from '../../utils/network/grouping';
import { seniority } from '../../utils/network/atlas';

const { industryOf, isSector, tagsOf, cityOf, companyKeyFor } = grouping;

export { KEYWORD_GROUPS };

export const INTENTS = ['who-at', 'role', 'intro-path', 'general', 'lens'];
const MAX_RESULTS = 100;

// ------------------------------------------------------------ vocab

/**
 * Role groups: `ask` recognises the role in a question. Whom a group counts
 * comes from the map's own classifier, so a typed question and a role chip
 * always agree ("Which investors do I know?" lists exactly the investors
 * chip's people):
 *   family  the classifier's family key (roles.js FAMILIES)
 *   title   with a family, a narrower title test inside it ("nurses" are the
 *           clinicians whose title says nurse)
 *   role    the classifier's role key ("allocators" are its 'lp' role)
 *   senior  the map's "senior leaders" (seniority 0)
 * Groups with none of these (CEOs, VPs, directors) are plain title tests.
 * `shown` is how the answer names the group back to the user. `match` stays
 * the title vocabulary other code ranks titles with (founder/networkLink.js).
 * Order matters: a narrower group is tested, and cut out of the question,
 * before a wider one ("head of product" before "heads of").
 */
export const ROLE_GROUPS = [
  { label: 'software engineers', shown: 'Software engineers', family: 'engineers', title: /\b(software|engineer(?:ing)?|developer|swe|sde|programmer|devops|sre|full[- ]?stack|front[- ]?end|back[- ]?end|architect)\b/i, bonus: /\b(software|swe|sde|developer|programmer)\b/i, ask: /\b(software\s+engineer(?:s|ing)?|swes?|sdes?|software\s+developers?|programmers?|coders?)\b/i, match: /\b(software|engineer(?:ing)?|developer|swe|sde|programmer|devops|sre|full[- ]?stack|front[- ]?end|back[- ]?end|architect)\b/i },
  { label: 'engineers', shown: 'Engineers', family: 'engineers', ask: /\b(engineers?|engineering|developers?|devs)\b/i, match: /\b(engineer(?:ing)?|developer|swe|sde|programmer|devops|sre|architect)\b/i },
  { label: 'product managers', shown: 'Product managers', family: 'product', title: /\b(product\s+(?:manager|lead|owner|management|director)|head of product|vp,? product|cpo|pm)\b/i, ask: /\b(product\s+(?:managers?|leads?|owners?|people|folks)|pms|heads?\s+of\s+product)\b/i, match: /\b(product\s+(?:manager|lead|owner|management|director)|head of product|vp,? product|cpo|pm)\b/i },
  { label: 'designers', shown: 'Designers', family: 'product', title: /\b(design\w*|ux|ui)\b/i, ask: /\b(designers?|ux|ui\/ux)\b/i, match: /\b(design(?:er)?|ux|ui)\b/i },
  // Data engineers and ML engineers build: they are engineers, asked as such.
  { label: 'data scientists', shown: 'Data scientists and analysts', family: 'data', ask: /\b(data\s+(?:scientists?|science|people|folks|analysts?)|analysts?|analytics\s+people)\b/i, match: /\b(data|machine learning|ml|analyst|analytics|scientist)\b/i },
  { label: 'founders', shown: 'Founders', family: 'founders', ask: /\b(co-?founders?|founders?|entrepreneurs?)\b/i, match: /\b(co-?founder|founder|founding)\b/i },
  { label: 'ceos', shown: 'CEOs', ask: /\b(ceos?|chief executives?)\b/i, match: /\b(ceo|chief executive)\b/i },
  { label: 'ctos', shown: 'CTOs', ask: /\b(ctos?|chief technology officers?)\b/i, match: /\b(cto|chief technology)\b/i },
  { label: 'cfos', shown: 'CFOs', ask: /\b(cfos?|chief financial officers?|finance leaders?)\b/i, match: /\b(cfo|chief financial|vp,? finance|head of finance)\b/i },
  // The map's "senior leaders" chip, counted the same way.
  { label: 'senior leaders', shown: 'Senior leaders', senior: true, ask: /\b(senior\s+(?:leaders?|leadership|people|folks|staff|execs?|executives|contacts|ones)|seniors|c-?suite)\b/i, match: /\b(founder|co-?founder|ceo|chief|president|owner|chair|managing (?:director|partner)|general partner|partner|principal)\b/i },
  { label: 'managing directors', shown: 'Managing directors', ask: /\bmanaging\s+directors?\b/i, match: /\bmanaging director\b/i },
  { label: 'vps', shown: 'VPs', ask: /\b(vps?|vice\s+presidents?|svps?|evps?)\b/i, match: /\b(vp|vice president|svp|evp)\b/i },
  { label: 'directors', shown: 'Directors', ask: /\bdirectors?\b/i, match: /\bdirector\b/i },
  { label: 'heads of', shown: 'Heads of teams', ask: /\bheads?\s+of\b/i, match: /\bhead of\b/i },
  { label: 'executives', shown: 'Executives', ask: /\b(executives?|execs?|leadership|leaders)\b/i, match: /\b(ceo|cto|cfo|coo|cmo|cpo|chief|president|vp|vice president|svp|evp|head of|director|managing director|general manager|gm)\b/i },
  { label: 'investors', shown: 'Investors', family: 'investors', ask: /\b(investors?|vcs?|venture\s+capitalists?|angels?|angel\s+investors?|fund\s+managers?)\b/i, match: /\b(investor|investing|investments?|venture|vc|general partner|managing partner|principal|angel|fund)\b/i },
  // The classifier's allocators (pension, endowment, family-office staff).
  { label: 'allocators', shown: 'LPs and allocators', role: 'lp', ask: /\b(lps?|limited\s+partners?|allocators?|endowments?(?:\s+staff)?|pension\s+(?:funds?|plans?)|pensions?|family\s+offices?|sovereign\s+wealth(?:\s+funds?)?|funds?\s+of\s+funds)\b/i, match: /\b(limited partner|allocator|family office|endowment|pension)\b/i },
  { label: 'recruiters', shown: 'Recruiters', family: 'people', ask: /\b(recruiters?|recruiting|talent\s+(?:partners?|acquisition|people)|hiring\s+managers?|hr\s+people)\b/i, match: /\b(recruit\w*|talent|sourcer|people ops|human resources|hr)\b/i },
  { label: 'marketing', shown: 'Marketing', family: 'sales', title: /\b(marketing|marketer|growth|brand|cmo|communications|content|demand gen\w*|pr)\b/i, ask: /\b(marketing|marketers?|growth\s+(?:people|leads?|marketers?)|brand\s+people)\b/i, match: /\b(marketing|marketer|growth|brand|cmo|communications|content)\b/i },
  { label: 'sales', shown: 'Sales', family: 'sales', title: /\b(sales|account executive|account manag\w*|business development|bd|bdr|sdr|partnerships?|revenue|cro|customer success|go-to-market|gtm)\b/i, ask: /\b(sales(?:people|\s+people)?|account\s+executives?|business\s+development|bizdev|bd\s+people)\b/i, match: /\b(sales|account executive|account manager|business development|bdr|sdr|partnerships|revenue)\b/i },
  { label: 'lawyers', shown: 'Lawyers', family: 'lawyers', ask: /\b(lawyers?|attorneys?|counsel|legal\s+(?:people|folks|team))\b/i, match: /\b(lawyer|attorney|counsel|legal|solicitor|barrister)\b/i },
  { label: 'consultants', shown: 'Consultants and advisors', family: 'consultants', ask: /\b(consultants?|consulting|advisors?|advisers?)\b/i, match: /\b(consultant|consulting|advisor|adviser)\b/i },
  { label: 'researchers', shown: 'Researchers and academics', family: 'academics', ask: /\b(researchers?|scientists?|professors?|phds?|academics?)\b/i, match: /\b(research\w*|scientist|professor|ph\.?d|postdoc|lecturer)\b/i },
  // Clinicians are one family; nurses, surgeons and doctors are the
  // clinicians whose title says so.
  { label: 'nurses', shown: 'Nurses', family: 'clinicians', title: /\b(nurse|nursing|rn|np|crna|lpn)\b/i, ask: /\b(nurses?|nursing\s+staff)\b/i, match: /\b(nurse|nursing)\b/i },
  { label: 'surgeons', shown: 'Surgeons', family: 'clinicians', title: /\b(surgeon|surgery|surgical)\b/i, ask: /\bsurgeons?\b/i, match: /\bsurgeon\b/i },
  { label: 'doctors', shown: 'Doctors', family: 'clinicians', title: /\b(md|m\.d|doctor|dr|physician|surgeon|\w+ologist|psychiatrist|p(?:a)?ediatrician|internist|hospitalist|resident|attending|gp|general practitioner|chief medical officer|medical director|anesthes\w+|obstetrician)\b/i, ask: /\b(doctors?|physicians?|mds)\b/i, match: /\b(md|doctor|physician|surgeon)\b/i },
  { label: 'clinicians', shown: 'Clinicians', family: 'clinicians', ask: /\b(clinicians?|medics?|clinical\s+staff|health\s?care\s+(?:workers?|providers?|professionals?))\b/i, match: /\b(md|doctor|physician|surgeon|clinician|nurse)\b/i },
  { label: 'bankers', shown: 'Bankers', family: 'bankers', ask: /\b(bankers?|investment\s+banking|m&a\s+(?:people|folks|advisors?))\b/i, match: /\b(banker|investment bank\w*|m&a|capital markets)\b/i },
  { label: 'accountants', shown: 'Finance and accounting people', family: 'finance', ask: /\b(accountants?|accounting\s+people|finance\s+(?:people|folks|team))\b/i, match: /\b(accountant|accounting|cpa|controller|finance)\b/i },
  { label: 'operations people', shown: 'Operations people', family: 'operations', ask: /\b(?:operations|ops)\s+(?:people|folks|team|leads?|managers?)\b/i, match: /\b(operations|ops)\b/i },
  { label: 'students', shown: 'Students', family: 'students', ask: /\b(students?|interns?|new\s+grads?)\b/i, match: /\b(student|intern|trainee)\b/i },
  { label: 'journalists', shown: 'Journalists', family: 'press', ask: /\b(journalists?|reporters?|editors?)\b/i, match: /\b(journalist|reporter|editor|correspondent)\b/i },
  { label: 'public sector people', shown: 'Public sector people', family: 'public', ask: /\b(government\s+(?:people|folks|officials?)|civil\s+servants?|policy\s+(?:people|folks|experts?))\b/i, match: /\b(policy|government|public sector)\b/i },
  { label: 'accelerator people', shown: 'Accelerator and community leads', family: 'accelerators', ask: /\b(accelerator\s+(?:people|folks|staff|leads?)|community\s+leads?)\b/i, match: /\b(accelerator|incubator|community)\b/i },
];
// Words that make a group narrower than "executives": with one of these,
// "executives" is not also required.
const NARROW_EXECUTIVES = new Set(['ceos', 'ctos', 'cfos', 'senior leaders', 'managing directors', 'vps', 'directors', 'heads of']);

/**
 * Every family's own words ("Which sales and marketing people do I know?",
 * "a founder or CEO", "Founders & CEOs"), read before the groups above so a
 * chip's label typed back as a question counts exactly the chip's people.
 * Single-word labels ("investors", "engineers") are left to the groups,
 * where a narrower phrase ("software engineers") can win first; the few
 * single words no group knows are read after the groups.
 */
const phraseRe = (label) => new RegExp(`\\b${label.toLowerCase().split(/\s+/)
  .map((w) => (w === 'and' || w === '&' ? '(?:and|&)' : w === 'or' ? '(?:or|and|&)' : w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  .join('\\s+')}(?![a-z0-9])`, 'i');
const familyWords = (f) => [f.many, f.one, f.title, f.tag].filter((l) => typeof l === 'string' && l.trim());
const FAMILY_PHRASES = FAMILIES
  .flatMap((f) => familyWords(f).filter((l) => /\s/.test(l.trim())).map((l) => ({ label: f.many, family: f.key, ask: phraseRe(l) })))
  // Longest first: "data scientist or analyst" before shorter phrases.
  .sort((a, b) => b.ask.source.length - a.ask.source.length);
// Single words that name a family and that no group above reads.
const FAMILY_WORDS = [
  { word: /\boperations\b/i, family: 'operations' },
  { word: /\baccelerators?\b/i, family: 'accelerators' },
  { word: /\bdata\b/i, family: 'data' },
].filter((w) => familyByKey(w.family)).map((w) => ({ ...w, label: familyByKey(w.family).many }));
const FAMILY_BY_LABEL = new Map(FAMILIES.flatMap((f) => familyWords(f).map((l) => [l.toLowerCase(), f])));
// The words a family is counted by in the read-out ("investor", "investors"):
// a tag of the file that is one of these is the family, not the tag. A
// shorter row label ("Partner") stays the file's tag.
const FAMILY_COUNTED = new Set(FAMILIES.flatMap((f) => [f.many, f.one].map((l) => String(l).toLowerCase())));

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NUMBER_WORDS = { few: 3, couple: 2, several: 3, one: 1, a: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, eighteen: 18, 'twenty-four': 24 };

const LOCATION_ALIASES = {
  sf: ['san francisco', 'sf', 'bay area'],
  'san francisco': ['san francisco', 'sf', 'bay area'],
  'bay area': ['san francisco', 'bay area', 'palo alto', 'oakland', 'san jose', 'mountain view', 'menlo park', 'berkeley'],
  nyc: ['new york', 'nyc', 'brooklyn', 'manhattan'],
  'new york': ['new york', 'nyc', 'brooklyn', 'manhattan'],
  la: ['los angeles', 'la'],
  'los angeles': ['los angeles', 'la'],
  uk: ['united kingdom', 'uk', 'london', 'england'],
  'united kingdom': ['united kingdom', 'uk', 'london', 'england'],
  'great britain': ['united kingdom', 'uk', 'london', 'england'],
  us: ['united states', 'usa', 'us'],
  usa: ['united states', 'usa', 'us'],
  'united states': ['united states', 'usa', 'us'],
};

const STOPWORDS = new Set((
  'a an the of for about on in at to and or with from by is are was were be been what who whom which how when where why ' +
  'do does did i me my mine we our us you your know knows knew find show list give get tell any anyone anybody someone somebody ' +
  'people person persons folks contacts contact connections connection network friends friend everyone all some might could should would can ' +
  'work works working worked employed there that this these those have has had them they their please help me intro introduction introductions ' +
  'warm path paths reach into via through connect job jobs opportunities opportunity role roles industry sector space field ' +
  'currently now based located near around who\'s whos connected added tagged'
).split(/\s+/));
// Grammar only: a tag from the file is read even when it is a word like
// "warm" or "contact", but never when it is one of these.
const GRAMMAR = new Set((
  'a an the of for about on in at to and or with from by is are was were be been what who whom which how when where why ' +
  'do does did i me my mine we our us you your it its this that these those there their them they have has had can could should would might will all any some'
).split(/\s+/));
// Words that carry no filter of their own: never reported as "not used".
const FILLER = new Set((
  'met meet meeting added joined linked link ones everybody here also just really more most many much other others else only both ' +
  'either each does done am it its as if so than then too very will shall may who\'re whore im i\'m ive i\'ve id i\'d is it\'s ' +
  'tag tags label labels labelled labeled marked list lists named called name names hi hello hey thanks thank me myself ' +
  'everyone anyone someone somebody nobody none no yes ok okay right currently today ask asking ' +
  'company companies firm firms startup startups business businesses organisation organisations organization organizations org orgs'
).split(/\s+/));
// With a lens ("who can help me raise a fund"), the words around it are the lens.
const LENS_FILLER = new Set('raise raising raised fund funds fundraise fundraising money capital deal deals flow dealflow startups startup companies company back backing invest investing intros'.split(' '));
// Placeholders ("Self-employed") never name a company.
const LEGAL_WORDS = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'plc', 'gmbh', 'ag', 'sa', 'lp', 'llp', 'pbc']);

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (term) => new RegExp(`(^|[^a-z0-9])${escapeRe(String(term).toLowerCase())}($|[^a-z0-9])`, 'i');
const cleanList = (list, max = 10) => {
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= max) break;
  }
  return out;
};

/** "prospects" -> "prospect", "companies" -> "company"; other words unchanged. */
function singular(word) {
  const w = String(word || '');
  if (/ies$/.test(w) && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(?:ss|us|is)$/.test(w)) return w;
  if (/(?:ches|shes|xes|sses)$/.test(w)) return w.slice(0, -2);
  return w.replace(/s$/, '');
}

/** A word as a whole word, singular or plural ("cardiologists" finds "Cardiologist"). */
function pluralRe(word) {
  const one = singular(String(word).toLowerCase());
  const forms = /y$/.test(one) && one.length > 2 ? `(?:${escapeRe(one)}|${escapeRe(one.slice(0, -1))}ies)` : `${escapeRe(one)}(?:s|es)?`;
  return new RegExp(`(^|[^a-z0-9])${forms}($|[^a-z0-9])`, 'i');
}

// ------------------------------------------------------------ words and spans

// Words as the company keys spell them: lower case, accents off, "&" as
// "and", apostrophes dropped ("McDonald's" -> "mcdonalds").
const TOKEN_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|&/gu;
function foldWord(w) {
  if (w === '&') return 'and';
  return String(w).normalize('NFKD').replace(/(\p{Script=Latin})\p{M}+/gu, '$1').normalize('NFC')
    .toLocaleLowerCase('en').replace(/['’`]/g, '');
}
/** The text's words with where each sits: [{ t, alt, start, end, raw }]. `alt` drops a possessive "'s". */
function tokensOf(text) {
  const out = [];
  for (const m of String(text || '').matchAll(TOKEN_RE)) {
    const raw = m[0];
    out.push({ t: foldWord(raw), alt: /['’]s$/i.test(raw) ? foldWord(raw.slice(0, -2)) : null, start: m.index, end: m.index + raw.length, raw });
  }
  return out;
}
const foldPhrase = (s) => tokensOf(s).map((x) => x.t).join(' ');

/** Remove [start, end) spans from a string, each replaced by a space. */
function cutSpans(text, spans) {
  let out = text;
  for (const s of [...spans].sort((a, b) => b.start - a.start)) out = `${out.slice(0, s.start)} ${out.slice(s.end)}`;
  return out.replace(/\s+/g, ' ');
}

// ------------------------------------------------------------ the file's words

const vocabCache = new WeakMap();

/**
 * The words of one file the rules can recognise: its tags, the map's
 * industry labels that someone in the file falls under, its companies (every
 * spelling, read as the company the map groups them under), its cities, its
 * people's names, and the words of its titles and companies. Read from the
 * contacts on the server; nothing is sent anywhere.
 */
export function vocabularyOf(contacts) {
  const list = Array.isArray(contacts) ? contacts : [];
  const hit = vocabCache.get(list);
  if (hit) return hit;
  const tags = new Set();
  const industries = new Set();
  const spellings = new Map(); // company key -> Map(spelling -> count)
  const cities = new Map(); // folded city -> Map(spelling -> count)
  const names = new Map(); // folded full name -> spelling
  const nameWords = new Set();
  const words = new Set();
  const addWords = (text) => { for (const tok of tokensOf(text)) if (tok.t.length >= 2) { words.add(tok.t); words.add(singular(tok.t)); } };
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    for (const t of tagsOf(c)) { tags.add(t); addWords(t); }
    const ind = industryOf(c);
    if (isSector(ind)) industries.add(ind);
    const { key, label } = companyOfContact(c);
    if (key) {
      let m = spellings.get(key);
      if (!m) { m = new Map(); spellings.set(key, m); }
      m.set(label, (m.get(label) || 0) + 1);
      addWords(label);
    }
    const city = cityOf(c);
    if (city) {
      const k = foldPhrase(city);
      let m = cities.get(k);
      if (!m) { m = new Map(); cities.set(k, m); }
      m.set(city, (m.get(city) || 0) + 1);
    }
    const name = String(c.name || '').trim();
    const nameKey = foldPhrase(name);
    if (nameKey.includes(' ')) names.set(nameKey, name);
    for (const w of nameKey.split(' ')) if (w.length >= 3) nameWords.add(w);
    addWords(c.position);
  }
  const commonest = (m) => { let best = ''; let n = 0; for (const [s, k] of m) if (k > n || (k === n && s < best)) { best = s; n = k; } return best; };
  // Each company's spellings as word lists, indexed by their first word.
  const companyLabel = new Map();
  const byFirst = new Map();
  for (const [key, m] of spellings) {
    companyLabel.set(key, commonest(m));
    const forms = new Set([key]);
    for (const s of m.keys()) { forms.add(normalizeCompanyKey(s)); forms.add(foldPhrase(s)); }
    for (const form of forms) {
      const toks = form.split(' ').filter(Boolean);
      if (!toks.length) continue;
      let arr = byFirst.get(toks[0]);
      if (!arr) { arr = []; byFirst.set(toks[0], arr); }
      arr.push({ toks, key });
    }
  }
  const out = {
    tags: [...tags],
    industries: [...industries],
    companies: { byFirst, label: companyLabel },
    cities: new Map([...cities].map(([k, m]) => [k, commonest(m)])),
    names,
    nameWords,
    words,
  };
  vocabCache.set(list, out);
  return out;
}

/**
 * The company a contact is counted under, as the map counts it: the
 * employer's key, or for a file without employers the work email's domain
 * ("stripe.com"). { key: '', label: '' } when there is none.
 */
function companyOfContact(c) {
  const key = companyKeyFor(c);
  if (key) return { key, label: String(c.company || '').trim() };
  const fromEmail = typeof grouping.companyFromEmail === 'function' ? grouping.companyFromEmail(c) : '';
  if (fromEmail) return { key: normalizeCompanyKey(fromEmail), label: fromEmail };
  return { key: '', label: '' };
}

/** The key a company named in a question is compared under (the map's own key when it can be read). */
const targetKeyOf = (name) => companyKeyFor({ company: name }) || normalizeCompanyKey(name);

// ------------------------------------------------------------ parsing

/** Trim a captured company phrase: drop trailing clauses, dates and filler. */
function cleanEntity(raw) {
  let s = String(raw || '').replace(/[?!;:]+.*$/, '').replace(/\.\s.*$/, '').replace(/\.$/, '').trim();
  s = s.split(/\s+(?:in\s+my|in\s+the|from\s+my|who|that|which|whose|where|and\s+who|based|located|near|as|for|right\s+now|currently|in|with|recent(?:ly)?|lately|last|past|this|since|before|after|connected|added|met|between|during|(?:19|20)\d{2})\b/i)[0];
  s = s.replace(/^(?:the|a|an)\s+/i, '').replace(/[,'"“”]+$/g, '').replace(/^["“']+/, '').trim();
  s = s.replace(/'s$/i, '').trim();
  const words = s.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 6) return '';
  if (words.every((w) => STOPWORDS.has(w.toLowerCase()))) return '';
  if (/^(my|our|your)\b/i.test(s)) return '';
  return s.slice(0, 80);
}

const LEGAL_SUFFIX = /^(?:inc|incorporated|llc|ltd|limited|corp|corporation|co|plc|gmbh|ag|sa|lp|llp|pbc)\.?$/i;

/**
 * A captured phrase may name several companies: "Stripe or Brex", "Google,
 * Meta and Apple", "Stripe/Adyen". Split on those separators (a legal suffix
 * after a comma, as in "Stripe, Inc.", stays with its company) and clean each.
 */
function cleanEntities(raw) {
  const parts = String(raw || '').split(/\s*(?:,|\/|\bor\b|\band\b)\s*/i);
  const merged = [];
  for (const part of parts) {
    if (merged.length && LEGAL_SUFFIX.test(part.trim().replace(/[?!;:,\s]+$/, ''))) merged[merged.length - 1] += `, ${part.trim()}`;
    else merged.push(part);
  }
  const out = [];
  for (const part of merged) {
    const entity = cleanEntity(part);
    if (entity && !out.some((e) => e.toLowerCase() === entity.toLowerCase())) out.push(entity);
    if (out.length >= 5) break;
  }
  return out;
}

const INTRO_PATTERNS = [
  /\b(?:warm\s+)?intro(?:duction)?s?(?:\s+paths?)?\s+(?:to|into|with|at|for)\s+(.+)$/i,
  /\bwho\s+(?:can|could|might)\s+(?:introduce|intro|connect|refer)\s+me\s+(?:to|with|into)\s+(.+)$/i,
  /\b(?:get|be)\s+(?:introduced|intro'?d|referred)\s+(?:to|into|at)\s+(.+)$/i,
  /\b(?:paths?|routes?)\s+(?:in)?to\s+(.+)$/i,
];

const COMPANY_PATTERNS = [
  /\b(?:works?|working|worked|employed|employees?|staff)\s+(?:at|for|with)\s+(.+)$/i,
  /\b(?:know|knows|people|anyone|anybody|someone|contacts?|connections?|folks|friends|engineers?|developers?|founders?|managers?|designers?|investors?|recruiters?|executives?|leaders?|team|sales|marketers?|employees?)\s+(?:at|@)\s+(.+)$/i,
  /\b(?:at|@)\s+(.+)$/i,
];

const isGenericWord = (entity) => entity.split(' ').length === 1
  && [...KEYWORD_GROUPS, ...ROLE_GROUPS].some((g) => g.ask.test(entity));

// Words before a company that say "this is a company": "at Stripe", "CEO of
// Marlowe Department Stores", "diligence on Stripe", "people from Stripe".
const COMPANY_PREPS = new Set(['at', 'from', 'to', 'of', 'on', 'for', 'with', 'in', 'into', 'inside', 'about']);
const PLACE_PREPS = new Set(['in', 'near', 'around', 'outside']);
const DATE_WORDS = new Set(['recent', 'recently', 'lately', 'last', 'past', 'this', 'year', 'years', 'month', 'months', 'week', 'weeks', 'day', 'days', 'since', 'before', 'after', 'today', 'quarter', 'export', ...MONTHS]);

/** True when a one-word name is also an ordinary word of the question vocabulary. */
function genericWord(w, vocab) {
  if (w.length <= 2 || STOPWORDS.has(w) || FILLER.has(w) || GRAMMAR.has(w) || DATE_WORDS.has(w) || LENS_FILLER.has(w)) return true;
  if (NUMBER_WORDS[w] || /^\d+$/.test(w)) return true;
  if (ROLE_GROUPS.some((g) => g.ask.test(w)) || KEYWORD_GROUPS.some((g) => g.ask.test(w))) return true;
  if (FAMILY_BY_LABEL.has(w) || FAMILY_BY_LABEL.has(singular(w))) return true;
  if ((vocab?.tags || []).some((t) => t === w || t === singular(w))) return true;
  if ((vocab?.industries || []).some((t) => t.toLowerCase() === w)) return true;
  if (vocab?.cities?.has(w)) return true;
  return false;
}

/**
 * The file's companies named in a question, wherever they are and however
 * long ("Who do I know at Ontario Teachers Pension Plan Board of Trustees
 * Canada?", "Partners In Health", "CEO of Marlowe Department Stores",
 * "people from Stripe and Google", "Marlowe Department Stores" alone).
 * Returns [{ key, label, start, end, prep }] in question order; start/end
 * cover the company (and the word before it, when that word made it one).
 */
function fileCompanies(q, toks, vocab) {
  const companies = vocab?.companies;
  if (!companies?.byFirst?.size || !toks.length) return [];
  const found = [];
  for (let i = 0; i < toks.length; i += 1) {
    for (const first of [toks[i].t, toks[i].alt]) {
      if (!first) continue;
      for (const form of companies.byFirst.get(first) || []) {
        const n = form.toks.length;
        if (i + n > toks.length) continue;
        let ok = true;
        for (let k = 0; k < n && ok; k += 1) {
          const tk = toks[i + k];
          ok = tk.t === form.toks[k] || (k === n - 1 && tk.alt === form.toks[k]) || (k === 0 && tk.alt === form.toks[k]);
        }
        if (ok) found.push({ i, j: i + n - 1, key: form.key, n });
      }
    }
  }
  if (!found.length) return [];
  // Longest first, no overlaps.
  found.sort((a, b) => b.n - a.n || a.i - b.i);
  const taken = [];
  for (const f of found) if (!taken.some((t) => f.i <= t.j && t.i <= f.j)) taken.push(f);
  taken.sort((a, b) => a.i - b.i);

  const meaningful = (from, to) => {
    for (let k = from; k <= to; k += 1) if (!STOPWORDS.has(toks[k].t) && !FILLER.has(toks[k].t)) return true;
    return false;
  };
  const out = [];
  let lastEnd = -1;
  for (const f of taken) {
    const words = toks.slice(f.i, f.j + 1).map((x) => x.t);
    const one = words.length === 1;
    const generic = one && genericWord(words[0], vocab);
    const prevTok = f.i > 0 ? toks[f.i - 1] : null;
    const at = f.i > 0 && q[toks[f.i].start - 1] === '@';
    const prep = at ? '@' : prevTok && COMPANY_PREPS.has(prevTok.t) ? prevTok.t : '';
    const isCity = vocab?.cities?.has(words.join(' '));
    // "in Austin" is the place when the file has that city; "at Austin Capital" is the company.
    if (isCity && (!prep || PLACE_PREPS.has(prep))) continue;
    const listed = lastEnd >= 0 && f.i - lastEnd <= 2 && toks.slice(lastEnd + 1, f.i).every((x) => x.t === 'and' || x.t === 'or')
      && (f.i - lastEnd === 1 ? /[,/]/.test(q.slice(toks[lastEnd].end, toks[f.i].start)) : true);
    const bare = !meaningful(0, f.i - 1) && !meaningful(f.j + 1, toks.length - 1);
    const capital = /^\p{Lu}/u.test(toks[f.i].raw);
    let accept;
    if (generic) accept = prep === 'at' || prep === '@' || (bare && words[0].length > 2 && !STOPWORDS.has(words[0]));
    else accept = !!prep || listed || bare || (capital && (!one || words[0].length >= 4));
    if (!accept) continue;
    // Include a legal suffix written after the name ("Stripe, Inc.").
    let j = f.j;
    while (j + 1 < toks.length && LEGAL_WORDS.has(toks[j + 1].t)) j += 1;
    const start = at ? toks[f.i].start - 1 : prep ? prevTok.start : toks[f.i].start;
    // Words after the name that still give the same company ("JPMorgan
    // Chase" is "jpmorgan"; "Goldman Sachs Group") belong to it, so they are
    // not read again as keywords.
    for (let k = j + 1; k < Math.min(toks.length, j + 4); k += 1) {
      if (normalizeCompanyKey(q.slice(toks[f.i].start, toks[k].end)) === f.key) j = k;
    }
    let end = toks[j].end;
    if (q[end] === '.' && j > f.j) end += 1;
    out.push({ key: f.key, label: companies.label.get(f.key) || toks.slice(f.i, f.j + 1).map((x) => x.raw).join(' '), start, end, prep, nameStart: toks[f.i].start });
    lastEnd = j;
  }
  return out;
}

/** Full names of people in the file named in the text ("Oakley Merriweather"). */
function fileNames(text, vocab) {
  if (!vocab?.names?.size) return [];
  const toks = tokensOf(text);
  const out = [];
  for (let i = 0; i < toks.length; i += 1) {
    for (let n = 4; n >= 2; n -= 1) {
      if (i + n > toks.length) continue;
      const key = toks.slice(i, i + n).map((x) => x.t).join(' ');
      const name = vocab.names.get(key);
      if (name) { out.push({ name, start: toks[i].start, end: toks[i + n - 1].end }); i += n - 1; break; }
    }
  }
  return out;
}

/** A city of the file said on its own ("Toronto", "new york"): its file spelling, or ''. */
function fileCity(text, vocab) {
  if (!vocab?.cities?.size) return '';
  const toks = tokensOf(text).filter((x) => !STOPWORDS.has(x.t) && !FILLER.has(x.t));
  const key = toks.map((x) => x.t).join(' ');
  return vocab.cities.get(key) || '';
}

const NEGATION = /\b(?:but\s+not|and\s+not|not|except(?:\s+for)?|excluding|exclude|without|outside(?:\s+of)?|other\s+than|apart\s+from|aside\s+from|besides|minus)\b/i;

/**
 * Rule-based question -> filters.
 * `knownLocations` (the distinct location strings of the user's contacts)
 * lets a lower-case place after "in"/"near" ("who works in paris") be
 * accepted only when some contact is actually there; without it any such
 * word that is not a role, industry or company counts as a place. `vocab`
 * (vocabularyOf) holds the file's own words.
 *
 * Besides the fields above, filters may carry: exclude { companies, roles,
 * tags, locations, industries } ("not at Google"), tagMode 'any' (tags joined
 * by "or"; otherwise every tag is required), names (people of the file named
 * outright), relationship 'firm' | 'direct', and notUsed (words the rules
 * could not use, to be named back to the user).
 */
export function parseQuestionRules(question, { knownLocations, vocab, today, negated = false } = {}) {
  // A shortcut's label typed back starts with its count ("22 at Stripe"): the count is not a filter.
  let q = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!negated) q = q.replace(/^\d[\d,]*\s+(?=[A-Za-z“"'‘])/, (m) => (/^(?:19|20)\d{2}\s$/.test(m) ? m : ''));
  const filters = { companies: [], roles: [], keywords: [], locations: [], tags: [], industries: [], connected: null, intent: 'general', lens: null };
  if (!q) return filters;
  const notUsed = [];

  // The file's companies first: a company's name may hold words that would
  // otherwise read as a role, a place or "not" ("Doctors Without Borders").
  const toks = tokensOf(q);
  let mentions = fileCompanies(q, toks, vocab);

  // "not at Google", "except investors", "outside New York": the clause after
  // the word is read on its own and its people are left out.
  if (!negated) {
    const re = new RegExp(NEGATION.source, 'gi');
    let nm;
    while ((nm = re.exec(q))) {
      const at = nm.index;
      if (mentions.some((m) => at >= m.nameStart && at < m.end)) continue;
      const after = q.slice(at + nm[0].length);
      const stop = after.search(/\s(?:who|that|which|but)\b|[?.!;]/i);
      let clause = (stop >= 0 ? after.slice(0, stop) : after).trim();
      if (!clause) break;
      if (/^outside/i.test(nm[0]) && !/^(?:in|at|near)\b/i.test(clause)) clause = `in ${clause}`;
      const sub = parseQuestionRules(clause, { knownLocations, vocab, today, negated: true });
      const exclude = {
        companies: sub.companies, roles: sub.roles, tags: sub.tags, locations: sub.locations, industries: sub.industries,
      };
      const any = Object.values(exclude).some((v) => v.length);
      if (any) filters.exclude = exclude;
      if (sub.notUsed?.length) notUsed.push(...sub.notUsed);
      if (!any && !sub.notUsed?.length) notUsed.push(`${nm[0]} ${clause}`.trim());
      const end = at + nm[0].length + (stop >= 0 ? stop : after.length);
      q = `${q.slice(0, at)} ${q.slice(end)}`.replace(/\s+/g, ' ').trim();
      break;
    }
    if (filters.exclude || notUsed.length) mentions = fileCompanies(q, tokensOf(q), vocab);
  }

  let rest = q;
  // A recognised phrase is cut out of `rest` so it is not read twice ("Big
  // Tech" is not also a place, "software engineers" not also "engineers").
  const cut = (re) => { rest = rest.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), ' ').replace(/\s+/g, ' '); };
  // "Who can help me raise / source deals / diligence X": a lens over the
  // network, optionally narrowed by company, industry or place.
  // A company's own name ("Granite Family Office") never sets the lens.
  filters.lens = lensFromQuestion(mentions.length ? cutSpans(q, mentions) : q);

  // Intro paths: to a company of the file, else to the phrase after "to".
  for (const re of INTRO_PATTERNS) {
    const m = q.match(re);
    if (!m) continue;
    const from = q.length - m[1].length;
    const known = mentions.find((x) => x.nameStart >= from);
    const company = known ? known.label : cleanEntity(m[1]);
    if (company) {
      filters.companies.push(company);
      filters.intent = 'intro-path';
      rest = known ? cutSpans(q, mentions) : rest.replace(m[0], ' ');
      // The asking words are not filters ("who can introduce me to …").
      if (known) rest = rest.replace(/\b(?:warm\s+)?intro(?:duction|duce|duced)?s?(?:\s+paths?)?\b|\b(?:introduce|intro|connect|refer)\s+me\b|\b(?:introduced|intro'?d|referred)\b|\b(?:paths?|routes?)\b/gi, ' ');
      break;
    }
  }
  if (filters.intent !== 'intro-path') {
    if (mentions.length) {
      for (const m of mentions) filters.companies.push(m.label);
      rest = cutSpans(q, mentions);
    } else {
      for (const re of COMPANY_PATTERNS) {
        const m = rest.match(re);
        const companies = m ? cleanEntities(m[1]).filter((c) => !isGenericWord(c)) : [];
        if (companies.length) {
          filters.companies.push(...companies);
          rest = rest.replace(new RegExp(`\\b(?:at|@|for|with)\\s+${escapeRe(companies[0])}`, 'i'), ' ');
          for (const c of companies.slice(1)) rest = rest.replace(new RegExp(`(^|\\s)${escapeRe(c)}(?=\\s|$|[?!.,;:])`, 'i'), '$1');
          break;
        }
      }
    }
  }

  // People of the file named outright ("who knows Oakley Merriweather").
  const named = fileNames(rest, vocab);
  if (named.length) {
    filters.names = named.map((x) => x.name);
    rest = cutSpans(rest, named);
  }

  // Tags named outright: "everyone tagged committed", "with the tag warm",
  // "tagged “met 2026”". Then the file's tags said plainly ("prospects in New
  // York", "my champions"), unless the word is a kind of person the map counts.
  const knownTags = (vocab?.tags || []).map((t) => String(t).toLowerCase()).filter(Boolean);
  const tagSnapshot = rest;
  const explicitTag = /\b(?:tagged(?:\s+as)?|with\s+(?:the\s+)?tags?|labell?ed(?:\s+as)?|marked\s+as)\s+(?:["“'‘]([^"”'’]+)["”'’]|([^"”'’?!,.;]+?)(?=$|[?!,.;]|\s+(?:in|at|from|who|whom|that|and|or|near|based|located|i|we)\b))/i;
  for (let i = 0; i < 3; i += 1) {
    const m = rest.match(explicitTag);
    if (!m) break;
    const said = (m[1] || m[2] || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const tag = knownTags.find((t) => t === said) || knownTags.find((t) => t === singular(said)) || said;
    if (tag && !filters.tags.includes(tag)) filters.tags.push(tag);
    rest = rest.replace(m[0], ' ');
  }

  // Family labels as the chips say them ("sales and marketing people").
  for (const p of FAMILY_PHRASES) {
    if (!p.ask.test(rest)) continue;
    if (!filters.roles.includes(p.label)) filters.roles.push(p.label);
    cut(p.ask);
  }

  for (const tag of [...knownTags].sort((a, b) => b.length - a.length)) {
    if (tag.length < 3 || /^\d+$/.test(tag) || GRAMMAR.has(tag)) continue;
    if (ROLE_GROUPS.some((g) => g.ask.test(tag)) || FAMILY_COUNTED.has(tag)) continue;
    const re = tagRe(tag);
    if (!re.test(rest)) continue;
    if (!filters.tags.includes(tag)) filters.tags.push(tag);
    cut(re);
  }
  // Two tags joined by "or" are either; otherwise both ("churned customers").
  // They are named back in the order they were asked.
  if (filters.tags.length > 1) {
    const where = new Map(filters.tags.map((t) => { const m = tagSnapshot.match(tagRe(t)); return [t, m ? m.index : Infinity]; }));
    filters.tags.sort((a, b) => where.get(a) - where.get(b));
    const at = [...where.values()].filter((i) => i !== Infinity).sort((a, b) => a - b);
    for (let i = 1; i < at.length; i += 1) {
      if (/\bor\b|\beither\b|\//i.test(tagSnapshot.slice(at[i - 1], at[i]))) { filters.tagMode = 'any'; break; }
    }
  }

  // Roles: a specific group wins over its generic parent ("software engineers" vs "engineers").
  for (const g of ROLE_GROUPS) {
    if (!g.ask.test(rest)) continue;
    if (g.label === 'executives' && filters.roles.some((r) => NARROW_EXECUTIVES.has(r))) continue;
    if (!filters.roles.includes(g.label)) filters.roles.push(g.label);
    cut(g.ask);
  }
  for (const w of FAMILY_WORDS) {
    // Only on their own: "data engineers" are engineers.
    if (filters.roles.length || !w.word.test(rest)) continue;
    if (!filters.roles.includes(w.label)) filters.roles.push(w.label);
    cut(w.word);
  }
  // "LPs" names the allocators; it is not also the wider fundraising lens.
  if (filters.roles.includes('allocators') && filters.lens === 'raise') filters.lens = null;

  // Contacts reached through a colleague, or the user's own.
  if (/\bthrough\s+(?:a\s+)?colleagues?\b|\bfirm[- ]wide\b|\bvia\s+colleagues?\b/i.test(rest)) {
    filters.relationship = 'firm';
    cut(/\bthrough\s+(?:a\s+)?colleagues?\b|\bfirm[- ]wide\b|\bvia\s+colleagues?\b/i);
  } else if (/\b(?:my\s+own|direct)\s+(?:contacts?|connections?)\b|^\s*direct\s*[?.!]?\s*$/i.test(rest)) {
    filters.relationship = 'direct';
    cut(/\b(?:my\s+own|direct)\s+(?:contacts?|connections?)\b|^\s*direct\b/i);
  }

  // When they connected: "this year", "in 2024", "in the last 12 months", "recently".
  const when = parseConnected(rest, today);
  if (when) {
    filters.connected = when.connected;
    for (const re of when.cuts) cut(re);
  }

  // The map's own industry labels, as far as this file has them ("Big Tech",
  // "Healthcare"): the same people the industry chip lights.
  for (const label of [...(vocab?.industries || [])].sort((a, b) => b.length - a.length)) {
    const re = industryRe(label);
    if (!re.test(rest)) continue;
    if (!filters.industries.includes(label)) filters.industries.push(label);
    cut(re);
  }

  for (const g of KEYWORD_GROUPS) {
    if (!g.ask.test(rest)) continue;
    // "ai" inside "data scientists" style role phrases is already covered by the role
    if (g.label === 'venture capital' && filters.roles.includes('investors')) { cut(g.ask); continue; }
    filters.keywords.push(g.label);
    cut(g.ask);
  }

  // Places: "in/based in/near <Capitalised Place>", "in the UK", several
  // joined by "and"/"or" ("in New York and Boston"), or a known short form.
  const known = knownLocations ? [...knownLocations].map((l) => String(l || '').toLowerCase()).filter(Boolean) : null;
  const shownCity = (place) => vocab?.cities?.get(foldPhrase(place)) || place;
  const isPlaceWord = (place) => KEYWORD_GROUPS.some((g) => g.ask.test(place)) || ROLE_GROUPS.some((g) => g.ask.test(place));
  const addPlace = (place) => {
    const shown = shownCity(place);
    if (!filters.locations.some((l) => l.toLowerCase() === shown.toLowerCase())) filters.locations.push(shown);
  };
  rest = rest.replace(/\b(based\s+in|located\s+in|living\s+in|in|near|around)\s+the\s+(?=[A-Z]|uk\b|us\b|usa\b|bay\s+area\b)/g, '$1 ');
  const PLACE = "[A-Z][A-Za-z.'-]*(?:\\s+[A-Z][A-Za-z.'-]*){0,3}";
  const locRe = new RegExp(`\\b(?:based\\s+in|located\\s+in|living\\s+in|in|near|around)\\s+(${PLACE}(?:,\\s*[A-Z][A-Za-z.'-]*)?)((?:\\s*(?:,\\s*)?(?:,|\\band\\b|\\bor\\b|&|\\/)\\s*(?:the\\s+)?${PLACE})*)`, 'g');
  const placeSpans = [];
  let lm;
  while ((lm = locRe.exec(rest))) {
    const places = [];
    let first = lm[1].trim();
    // "New York, Boston": two of the file's cities, not a city and its state.
    const comma = first.split(/,\s*/);
    if (comma.length === 2 && vocab?.cities?.has(foldPhrase(comma[0])) && vocab.cities.has(foldPhrase(comma[1]))) places.push(...comma);
    else places.push(first);
    for (const more of (lm[2] || '').split(/\s*(?:,|\band\b|\bor\b|&|\/)\s*/)) if (more.trim()) places.push(more.trim().replace(/^the\s+/i, ''));
    let used = false;
    for (const place of places) {
      if (isPlaceWord(place)) continue;
      if (filters.companies.some((c) => c.toLowerCase() === place.toLowerCase())) continue;
      // A word of the file's titles that is nowhere in its places is not a place ("in Product").
      const fold = foldPhrase(place);
      const inPlaces = vocab?.cities?.has(fold) || LOCATION_ALIASES[fold] || (known ? known.some((l) => wordRe(fold).test(l)) : true);
      if (!inPlaces && vocab?.words?.has(fold)) continue;
      addPlace(place);
      used = true;
    }
    if (used) placeSpans.push({ start: lm.index, end: lm.index + lm[0].length });
  }
  if (placeSpans.length) rest = cutSpans(rest, placeSpans);
  const shortRe = /\b(?:in|based in|near|around)\s+(sf|nyc|la|bay area|new york|san francisco|los angeles|london|uk|usa|us)\b/i;
  const shortLoc = rest.match(shortRe);
  if (shortLoc) {
    const short = shortLoc[1].toLowerCase();
    addPlace({ sf: 'SF', nyc: 'NYC', la: 'LA', uk: 'UK', us: 'US', usa: 'USA' }[short] || vocab?.cities?.get(short) || short.replace(/\b[a-z]/g, (ch) => ch.toUpperCase()));
    cut(shortRe);
  }
  // Lower-case places ("who works in paris", "in the uk"): the words after
  // in/near up to the next filler word, when they are not a role, an
  // industry or a company, and some contact is there.
  if (!filters.locations.length) {
    const lowRe = /\b(?:based\s+in|located\s+in|living\s+in|in|near|around)\s+((?:the\s+)?[a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})/g;
    let lowM;
    while ((lowM = lowRe.exec(rest))) {
      const words = [];
      for (const w of lowM[1].replace(/^the\s+/, '').split(/\s+/)) {
        if (STOPWORDS.has(w.replace(/[.'-]+$/, '')) || /^(?:my|our|your)$/.test(w)) break;
        words.push(w);
      }
      const place = words.join(' ').replace(/[.,]+$/, '');
      if (!place) continue;
      if (isPlaceWord(place)) continue;
      if (filters.companies.some((c) => c.toLowerCase() === place)) continue;
      const aliases = LOCATION_ALIASES[place] || [place];
      if (known && !known.some((l) => aliases.some((a) => wordRe(a).test(l)))) continue;
      addPlace(vocab?.cities?.get(place) || (LOCATION_ALIASES[place] ? place : place.replace(/\b[a-z]/g, (ch) => ch.toUpperCase())));
      rest = rest.replace(lowM[0], ' ');
      break;
    }
  }

  if (filters.intent !== 'intro-path') {
    if (filters.companies.length) filters.intent = 'who-at';
    else if (filters.roles.length) filters.intent = 'role';
    else if (filters.lens) filters.intent = 'lens';
  }
  if (filters.lens && filters.roles.includes('investors') && filters.lens === 'raise') filters.roles = filters.roles.filter((r) => r !== 'investors');

  // What is left. The lens's own words go first.
  if (filters.lens) for (const p of LENS_PATTERNS) cut(p.re);
  const leftover = tokensOf(rest)
    .filter((x) => !STOPWORDS.has(x.t) && !FILLER.has(x.t) && !(filters.lens && LENS_FILLER.has(x.t)) && x.t.length >= 2)
    .map((x) => x.raw);
  const recognised = filters.companies.length || filters.roles.length || filters.keywords.length || filters.locations.length
    || filters.tags.length || filters.industries.length || filters.connected || filters.lens || filters.names?.length
    || filters.relationship || filters.exclude;

  if (!recognised && leftover.length) {
    // Nothing recognised: a city of the file said alone ("Toronto"), people's
    // first or last names ("find Parker"), else the words as keywords.
    const city = fileCity(rest, vocab);
    if (city) filters.locations.push(city);
    else if (vocab?.nameWords && leftover.length <= 2 && leftover.every((w) => /^\p{Lu}/u.test(w) && vocab.nameWords.has(foldWord(w)))) {
      filters.names = [leftover.join(' ')];
    } else {
      const words = leftover.map((w) => w.toLowerCase().replace(/^[.\-]+|[.\-]+$/g, '')).filter((w) => w.length >= 2);
      filters.keywords = cleanList(words, 6);
    }
  } else if (leftover.length) {
    // Something was read: words the file has narrow the answer; any other
    // word is named back, never dropped silently.
    for (const w of leftover) {
      const f = foldWord(w);
      if (vocab?.words && (vocab.words.has(f) || vocab.words.has(singular(f))) && !/^\d+$/.test(f)) filters.keywords.push(f);
      else notUsed.push(w);
    }
  }
  // With a lens, generic words ("fund", "deals", "company") are not keywords.
  if (filters.lens && !filters.companies.length && !filters.roles.length && !filters.locations.length
    && !filters.tags.length && !filters.industries.length && !filters.connected && !filters.keywords.some((k) => KEYWORD_GROUPS.some((g) => g.label === k))) {
    filters.keywords = [];
  }
  filters.companies = cleanList(filters.companies, 5);
  filters.roles = cleanList(filters.roles);
  filters.keywords = cleanList(filters.keywords);
  filters.locations = cleanList(filters.locations, 5);
  filters.tags = cleanList(filters.tags, 5);
  filters.industries = cleanList(filters.industries, 5);
  if (notUsed.length) filters.notUsed = cleanList(notUsed, 8);
  return filters;
}

/** A tag as a whole phrase, singular or plural ("decision maker(s)", "follow up"). */
function tagRe(tag) {
  const words = tag.split(/\s+/).map((w) => escapeRe(w));
  const last = words.pop();
  const lastForms = /y$/.test(last) ? `(?:${last}|${last.slice(0, -1)}ies)` : `${last}(?:s|es)?`;
  return new RegExp(`(^|[^a-z0-9])${[...words, lastForms].join('[\\s-]+')}(?=$|[^a-z0-9])`, 'i');
}

/** An industry label as the map shows it; "&" may be typed as "and". */
function industryRe(label) {
  const body = label.toLowerCase().split(/\s+/)
    .map((w) => (w === '&' ? '(?:&|and)' : escapeRe(w)))
    .join('\\s+');
  return new RegExp(`(^|[^a-z0-9])${body}(?=$|[^a-z0-9])`, 'i');
}

/** 'YYYY-MM-DD' (or a Date) to a UTC day number; null when unreadable. */
const DAY_MS = 86400000;
function dayOf(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : Math.floor(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / DAY_MS);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS) : null;
}
const dayFromParts = (y, m, d) => Math.floor(Date.UTC(y, m, d) / DAY_MS);
const isoOf = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const monthName = (day) => {
  const d = new Date(day * DAY_MS);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/**
 * Dates in a question about when people were connected. Returns { connected,
 * cuts } or null. `connected` is plain data: { kind: 'range', from, to,
 * label } for calendar periods (worked out against `today`), or { kind:
 * 'last', months | days, label } for a window that ends at the file's newest
 * date when that is earlier than today, as the "connected in the last 12
 * months" chip does.
 */
function parseConnected(text, today) {
  const t = String(text || '');
  const now = dayOf(today || new Date());
  const year = new Date(now * DAY_MS).getUTCFullYear();
  const yearOk = (y) => y >= 1950 && y <= year + 1;
  const num = (s) => (/^\d+$/.test(s) ? Number(s) : NUMBER_WORDS[String(s).toLowerCase()] || null);
  const YEAR = '((?:19|20)\\d{2})';
  const range = (from, to, label, re) => ({ connected: { kind: 'range', from, to, label }, cuts: [re] });
  const rolling = (count, unitWord, label, re) => {
    const unit = unitWord.toLowerCase().replace(/s$/, '');
    const months = unit === 'year' ? count * 12 : unit === 'month' ? count : null;
    const days = unit === 'day' ? count : unit === 'week' ? count * 7 : null;
    return { connected: { kind: 'last', ...(months ? { months } : { days }), label }, cuts: [re] };
  };
  let m;
  // The old-export recent chip's own words: "in the 12 months before this export".
  const exportRe = /\b(?:(?:in|over|during|within)\s+)?(?:the\s+)?(?:(\d{1,3}|[a-z-]+)\s+)?(days?|weeks?|months?|years?)\s+before\s+(?:this|the|my)\s+(?:export|file|download)\b/i;
  if ((m = t.match(exportRe))) {
    const count = m[1] ? num(m[1]) : 1;
    if (count) return rolling(count, m[2], `in the ${count === 1 ? '' : `${count} `}${m[2].toLowerCase()} before this export`.replace('the  ', 'the '), exportRe);
  }
  // "last year" alone is the calendar year; "the last year" and "past year" are the last twelve months.
  const lastYearRe = /(?<!\bthe\s)\blast\s+year\b/i;
  if (lastYearRe.test(t)) return range(`${year - 1}-01-01`, `${year - 1}-12-31`, `in ${year - 1}`, lastYearRe);
  // "in the last 12 months", "over the past year", "last 6 months", "past 90 days", "last month", "last week"
  const lastRe = /\b(?:(?:in|over|during|within)\s+)?(?:the\s+)?(?:last|past)\s+(?:(\d{1,3}|[a-z-]+)\s+)?(days?|weeks?|months?|years?)\b/i;
  if ((m = t.match(lastRe))) {
    const count = m[1] ? num(m[1]) : 1;
    if (count) {
      const unit = m[2].toLowerCase().replace(/s$/, '');
      return rolling(count, unit, `in the last ${count === 1 ? '' : `${count} `}${unit}${count === 1 ? '' : 's'}`.replace('last  ', 'last '), lastRe);
    }
  }
  const recentRe = /\b(?:recent(?:ly)?|lately|new(?:est)?\s+connections?)\b/i;
  if (recentRe.test(t)) return { connected: { kind: 'last', months: 12, label: 'recently' }, cuts: [recentRe] };
  const thisYearRe = /\b(?:this|the\s+current)\s+year\b/i;
  if (thisYearRe.test(t)) return range(`${year}-01-01`, `${year}-12-31`, `in ${year}`, thisYearRe);
  const thisMonthRe = /\bthis\s+month\b/i;
  if (thisMonthRe.test(t)) {
    const d = new Date(now * DAY_MS);
    return range(isoOf(dayFromParts(year, d.getUTCMonth(), 1)), isoOf(dayFromParts(year, d.getUTCMonth() + 1, 0)), 'this month', thisMonthRe);
  }
  // "in Q1 2025", "the second quarter of 2024"
  const quarterRe = new RegExp(`\\b(?:(?:in|during)\\s+)?(?:the\\s+)?(?:q([1-4])|(first|second|third|fourth|1st|2nd|3rd|4th)\\s+quarter(?:\\s+of)?)\\s*,?\\s*${YEAR}\\b`, 'i');
  if ((m = t.match(quarterRe)) && yearOk(Number(m[3]))) {
    const qn = m[1] ? Number(m[1]) : { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4 }[m[2].toLowerCase()];
    const y = Number(m[3]);
    return range(isoOf(dayFromParts(y, (qn - 1) * 3, 1)), isoOf(dayFromParts(y, qn * 3, 0)), `in Q${qn} ${y}`, quarterRe);
  }
  // "between 2020 and 2022", "from 2020 to 2022", "2020-2022"
  const betweenRe = new RegExp(`\\b(?:between\\s+${YEAR}\\s+(?:and|&)\\s+${YEAR}|from\\s+${YEAR}\\s+(?:to|until|till|through|thru)\\s+${YEAR}|${YEAR}\\s*[-–]\\s*${YEAR})\\b`, 'i');
  if ((m = t.match(betweenRe))) {
    const ys = m.slice(1).filter(Boolean).map(Number);
    const [a, b] = ys[0] <= ys[1] ? ys : [ys[1], ys[0]];
    if (yearOk(a) && yearOk(b)) return range(`${a}-01-01`, `${b}-12-31`, `between ${a} and ${b}`, betweenRe);
  }
  // "in March 2025"
  const monthRe = /\b(?:in|during)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+((?:19|20)\d{2})\b/i;
  if ((m = t.match(monthRe)) && yearOk(Number(m[2]))) {
    const mi = MONTHS.indexOf(m[1].toLowerCase().slice(0, 3));
    const y = Number(m[2]);
    return range(isoOf(dayFromParts(y, mi, 1)), isoOf(dayFromParts(y, mi + 1, 0)), `in ${monthName(dayFromParts(y, mi, 1))}`, monthRe);
  }
  // "since 2023", "after 2022", "before 2020", "from 2023 on"
  const sinceRe = new RegExp(`\\b(?:(since|after|before|prior\\s+to)\\s+${YEAR}|from\\s+${YEAR}\\s+(?:on(?:wards?)?|forward))\\b`, 'i');
  if ((m = t.match(sinceRe)) && yearOk(Number(m[2] || m[3]))) {
    const y = Number(m[2] || m[3]);
    const word = (m[1] || 'since').toLowerCase();
    if (word === 'before' || word.startsWith('prior')) return range(null, `${y - 1}-12-31`, `before ${y}`, sinceRe);
    const from = word === 'after' ? `${y + 1}-01-01` : `${y}-01-01`;
    return range(from, null, word === 'after' ? `after ${y}` : `since ${y}`, sinceRe);
  }
  // "in 2024", "during 2024", "connected 2024", "people from 2024", "my 2024 connections", "2024"
  const yearRe = new RegExp(`\\b(?:(?:in|during|connected|added|met|from)\\s+)?${YEAR}\\b`, 'i');
  if ((m = t.match(yearRe)) && yearOk(Number(m[1]))) {
    const y = Number(m[1]);
    return range(`${y}-01-01`, `${y}-12-31`, `in ${y}`, yearRe);
  }
  return null;
}

/**
 * The window a `connected` filter covers, as day numbers { from, to } (either
 * may be null), with a note when the window was moved back to the file's
 * newest date. `newest` is the newest connected-on day in the contacts.
 */
function connectedWindow(connected, { today, newest }) {
  if (!connected || typeof connected !== 'object') return null;
  if (connected.kind === 'range') {
    return { from: dayOf(connected.from), to: dayOf(connected.to), note: '' };
  }
  const now = dayOf(today || new Date());
  // Like the recent chip: an old export still shows its own last months.
  const end = newest !== null && newest < now ? newest : now;
  const d = new Date(end * DAY_MS);
  let start;
  if (connected.months) start = dayFromParts(d.getUTCFullYear(), d.getUTCMonth() - Number(connected.months), d.getUTCDate());
  else start = end - Number(connected.days || 0);
  const moved = end !== now && now - end > 60;
  return {
    // The chip counts after the start day, up to and including the end day.
    from: start + 1,
    to: end,
    note: moved ? `Your file's newest connection is from ${monthName(end)}, so this counts back from then.` : '',
  };
}

/**
 * Validate an LLM (or client) filter object into the canonical shape, or
 * null. With `vocab`, tags are kept only when the file has them (any other
 * tag word becomes a keyword), and a date range is kept when it reads.
 */
export function validateFilters(obj, { vocab } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const f = {
    companies: cleanList(obj.companies, 5),
    roles: cleanList(obj.roles),
    keywords: cleanList(obj.keywords),
    locations: cleanList(obj.locations, 5),
    tags: [],
    industries: [],
    connected: null,
    intent: INTENTS.includes(obj.intent) ? obj.intent : null,
    lens: LENS_KEYS.includes(obj.lens) ? obj.lens : null,
  };
  const fileTags = new Set((vocab?.tags || []).map((t) => String(t).toLowerCase()));
  for (const t of cleanList(obj.tags, 5).map((x) => x.toLowerCase())) {
    const tag = fileTags.has(t) ? t : fileTags.has(singular(t)) ? singular(t) : '';
    if (tag) f.tags.push(tag);
    else if (!f.keywords.includes(t)) f.keywords.push(t);
  }
  const iso = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && dayOf(v) !== null ? v : null);
  if (obj.connected && typeof obj.connected === 'object') {
    const from = iso(obj.connected.from);
    const to = iso(obj.connected.to);
    if (from || to) f.connected = { kind: 'range', from, to, label: from && to ? `between ${from} and ${to}` : from ? `since ${from}` : `before ${to}` };
  }
  if (!f.intent) {
    if (f.companies.length) f.intent = 'who-at';
    else if (f.roles.length) f.intent = 'role';
    else if (f.lens) f.intent = 'lens';
    else f.intent = 'general';
  }
  if (f.intent === 'intro-path' && !f.companies.length) f.intent = 'general';
  if (!f.companies.length && !f.roles.length && !f.keywords.length && !f.locations.length && !f.lens && !f.tags.length && !f.connected) return null;
  return f;
}

function extractJson(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

const LLM_SYSTEM = `You turn a question about someone's professional network into search filters.
Return ONLY a JSON object: {"companies": [], "roles": [], "keywords": [], "locations": [], "tags": [], "connected": null, "intent": "who-at" | "role" | "intro-path" | "general" | "lens", "lens": null | "raise" | "source" | "diligence"}.
lens: "raise" when the asker wants money or LP/investor introductions, "source" when they want deal flow or founders to meet, "diligence" when they want people who can vet, reference or evaluate a company, founder or market; otherwise null.
companies: organisation names mentioned. roles: job roles (e.g. "software engineers", "investors", "founders").
keywords: industries or topics (e.g. "fintech", "ai"). locations: places. tags: labels or stages the asker uses for their own contacts (e.g. "warm", "follow-up").
connected: when they met, as {"from": "YYYY-MM-DD" or null, "to": "YYYY-MM-DD" or null}, or null. intent: "intro-path" when asking for an introduction or path to a company,
"who-at" when asking who works at a company, "role" when asking for a kind of person, otherwise "general". Use [] when absent. No commentary.`;

/** Ask the configured LLM for filters. Sends only the question text. */
export async function parseQuestionWithLlm(question, { complete = chatComplete, vocab } = {}) {
  try {
    const result = await complete([
      { role: 'system', content: LLM_SYSTEM },
      { role: 'user', content: String(question).slice(0, 500) },
    ], { maxTokens: 300, temperature: 0, timeoutMs: 12000 });
    if (!result?.text) return null;
    return validateFilters(extractJson(result.text), { vocab });
  } catch {
    return null;
  }
}

/**
 * Whether the rules read anything at all from the question: any filter, a
 * lens, a person, an exclusion, or a keyword that some title, company or tag
 * in the file holds. Only then is a model never needed.
 */
function rulesRead(f, vocab) {
  if (f.companies.length || f.roles.length || f.locations.length || f.tags.length || f.industries.length || f.connected || f.lens) return true;
  if (f.names?.length || f.relationship || f.exclude) return true;
  if (f.keywords.some((k) => KEYWORD_GROUPS.some((g) => g.label === k))) return true;
  if (vocab?.words && f.keywords.some((k) => vocab.words.has(k) || vocab.words.has(singular(k)))) return true;
  return false;
}

/**
 * Question -> { filters, parsedBy }. Rules first; the LLM (when configured
 * and allowed) is only consulted when the rules read nothing at all.
 */
export async function parseQuestion(question, { useLlm = true, complete, knownLocations, vocab, today } = {}) {
  const rules = parseQuestionRules(question, { knownLocations, vocab, today });
  if (rulesRead(rules, vocab) || !useLlm || String(question || '').trim().split(/\s+/).length < 2) {
    return { filters: rules, parsedBy: 'rules' };
  }
  const llm = await parseQuestionWithLlm(question, { ...(complete ? { complete } : {}), vocab });
  if (llm) return { filters: llm, parsedBy: 'llm' };
  return { filters: rules, parsedBy: 'rules' };
}

// ------------------------------------------------------------ scoring

/** Company relation including a looser "same first word" rule for search. */
export function companyRelation(contactKey, targetKey) {
  const strict = companyMatch(contactKey, targetKey);
  if (strict) return strict;
  if (!contactKey || !targetKey) return null;
  const a = contactKey.split(' ');
  const b = targetKey.split(' ');
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length === 1 && short[0].length >= 3 && long[0] === short[0]) return 'related';
  return null;
}

/**
 * How a role label is counted: a group's own label, a family's label ("sales
 * and marketing people", "investor", "Founders & CEOs"), or a group whose
 * words it contains (a model may say "VCs"). Null when nothing fits.
 */
const roleGroupFor = (label) => {
  const l = String(label).toLowerCase().trim();
  const own = ROLE_GROUPS.find((g) => g.label === l);
  if (own) return own;
  const fam = FAMILY_BY_LABEL.get(l);
  if (fam) return { label: fam.many, family: fam.key };
  const phrase = FAMILY_PHRASES.find((p) => p.ask.test(l));
  if (phrase) return { label: phrase.label, family: phrase.family };
  return ROLE_GROUPS.find((g) => g.ask.test(l)) || null;
};

/** Does the contact belong to a role group? Families and roles come from the map's classifier. */
function roleHit(group, contact, position) {
  if (group.senior) return seniority(contact) === 0;
  if (group.role) return classifyContact(contact).role === group.role;
  if (group.family) {
    if (classifyContact(contact).family !== group.family) return false;
    return group.title ? group.title.test(position) : true;
  }
  return group.match.test(position);
}

/** Why the contact counts under a role group, in plain words. */
function roleReason(group, contact, position) {
  if ((group.family && !group.title) || group.role) {
    const kind = classifyContact(contact);
    const fam = familyByKey(kind.family);
    const why = kind.reason.startsWith('Company:') ? `from their employer, ${String(contact.company || '').slice(0, 60)}`
      : position ? `title "${position.slice(0, 80)}"` : 'from their employer';
    const what = group.role ? kind.label : fam ? fam.one.charAt(0).toUpperCase() + fam.one.slice(1) : group.label;
    return `${what} (${why})`;
  }
  if (group.senior) return `Senior leader: "${position.slice(0, 80)}"`;
  return position ? `Title "${position.slice(0, 80)}" matches ${String(group.shown || group.label).toLowerCase()}` : `Company "${contact.company}" matches ${group.label}`;
}
const keywordGroupFor = (label) => {
  const l = String(label).toLowerCase();
  return KEYWORD_GROUPS.find((g) => g.label === l) || KEYWORD_GROUPS.find((g) => g.ask.test(l)) || null;
};

const publicContact = (c) => ({
  key: typeof c.key === 'string' && c.key ? c.key : dedupeKey(c),
  name: c.name,
  company: c.company || '',
  position: c.position || '',
  location: c.location || '',
  profileUrl: c.profileUrl || '',
  connectedOn: c.connectedOn || null,
  source: c.source,
  ...(c.relationship === 'firm' ? { relationship: 'firm', via: c.via || '' } : {}),
});

/** A company relation that means the contact actually works there. */
export const STRICT_COMPANY = new Set(['exact', 'contains', 'within']);

/**
 * Score every contact against the filters. All given categories must match
 * (company AND role AND location); keywords match if any one does; tags all
 * match unless `tagMode` is 'any'. Several companies are OR-ed: the best
 * relation wins and is reported as `companyMatch` ('exact' | 'contains' |
 * 'within' | 'related' | 'title'). A company of the file matches exactly the
 * people the map counts under it; other spellings that only look alike are
 * 'related'. `exclude` leaves people out.
 * Returns { results: [{ contact, score, reasons, companyMatch }] (at most
 * `limit`), total, strictTotal (matches whose companyMatch is
 * exact/contains/within), keys (every match's contact key, in rank order),
 * notes, ranked (every match) }.
 */
export function scoreContacts(contacts, filters, { limit = MAX_RESULTS, today } = {}) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const f = {
    companies: arr(filters?.companies), roles: arr(filters?.roles),
    keywords: arr(filters?.keywords), locations: arr(filters?.locations),
    tags: arr(filters?.tags).map((t) => String(t).toLowerCase().trim()).filter(Boolean),
    industries: arr(filters?.industries).map((t) => String(t).trim()).filter(Boolean),
    names: arr(filters?.names).map((n) => foldPhrase(n)).filter(Boolean),
  };
  const ex = filters?.exclude && typeof filters.exclude === 'object' ? filters.exclude : {};
  const list = Array.isArray(contacts) ? contacts : [];
  const keyCache = new Map();
  const contactCompanyKey = (c) => {
    let k = keyCache.get(c);
    if (k === undefined) { k = companyOfContact(c).key; keyCache.set(c, k); }
    return k;
  };
  let fileKeys = null;
  const inFile = (key) => {
    if (!fileKeys) fileKeys = new Set(list.map(contactCompanyKey).filter(Boolean));
    return fileKeys.has(key);
  };
  const targetsOf = (names) => names.map((name) => {
    const key = targetKeyOf(name);
    return { name, key, re: wordRe(name), file: key ? inFile(key) : false };
  }).filter((t) => t.key);
  const targets = targetsOf(f.companies);
  const rolesOf = (labels) => labels.map((label) => roleGroupFor(label) || { label, match: wordRe(String(label).replace(/s$/i, '')) });
  const roles = rolesOf(f.roles);
  const keywords = f.keywords.map((label) => {
    const g = keywordGroupFor(label);
    return g ? { label: g.label, res: g.terms.map((t) => ({ term: t, re: wordRe(t) })) } : { label, res: [{ term: label, re: pluralRe(label) }] };
  });
  // A place that is one of the contacts' own cities matches by city, as the
  // place chip counts ("New York" is not also "New York Mills"); any other
  // place (a country, a region) matches the location text.
  let cities = null;
  const placesOf = (names) => names.map((place) => {
    if (!cities) cities = new Set(list.map((c) => cityOf(c).toLowerCase()).filter(Boolean));
    const city = cityOf({ location: place }).toLowerCase();
    if (city && cities.has(city)) return { place, city };
    const aliases = LOCATION_ALIASES[String(place).toLowerCase()] || [place];
    return { place, res: aliases.map((a) => wordRe(a)) };
  });
  const locations = placesOf(f.locations);
  // Industry labels compare without case, as typed or as the map shows them.
  const industries = f.industries.map((label) => label.toLowerCase());
  let newest = null;
  if (filters?.connected) for (const c of list) { const d = dayOf(c.connectedOn); if (d !== null && (newest === null || d > newest)) newest = d; }
  const when = connectedWindow(filters?.connected, { today, newest });
  const relationship = filters?.relationship === 'firm' || filters?.relationship === 'direct' ? filters.relationship : null;
  const tagAny = filters?.tagMode === 'any';

  const exclude = {
    targets: targetsOf(arr(ex.companies)),
    roles: rolesOf(arr(ex.roles)),
    tags: arr(ex.tags).map((t) => String(t).toLowerCase().trim()).filter(Boolean),
    locations: placesOf(arr(ex.locations)),
    industries: arr(ex.industries).map((t) => String(t).toLowerCase().trim()).filter(Boolean),
  };
  const excluding = exclude.targets.length || exclude.roles.length || exclude.tags.length || exclude.locations.length || exclude.industries.length;

  const lens = LENS_KEYS.includes(filters?.lens) ? filters.lens : null;
  const notes = [];
  if ((locations.length || exclude.locations.length) && !list.some((c) => c.location)) {
    notes.push('None of your contacts have a location (LinkedIn\'s Connections export does not include one), so location filters cannot match.');
  }
  if (f.tags.length && !list.some((c) => tagsOf(c).length)) {
    notes.push('None of your contacts have tags in this file, so tag filters cannot match.');
  } else if (f.tags.length) {
    const missing = f.tags.filter((t) => !list.some((c) => tagsOf(c).includes(t)));
    if (missing.length) notes.push(`Nobody in your network is tagged ${missing.map((t) => `“${t}”`).join(' or ')}.`);
  }
  if (when && newest === null) {
    notes.push('None of your contacts have a connection date in this file (LinkedIn exports do; most CRM files do not), so date filters cannot match.');
  } else if (when?.note) notes.push(when.note);
  const positive = targets.length || roles.length || keywords.length || locations.length || lens || f.tags.length || industries.length || when || f.names.length || relationship;
  if (!positive && !excluding) {
    return { results: [], total: 0, strictTotal: 0, keys: [], ranked: [], notes: ['Ask about a company, a role, an industry or a place, e.g. "Who do I know at Stripe?"'] };
  }

  /** The best company relation of a contact to some targets, or null. */
  const companyHit = (c, list2, position) => {
    const companyKey = contactCompanyKey(c);
    let best = null;
    for (const t of list2) {
      const rel = companyRelation(companyKey, t.key);
      if (t.file) {
        // A company of the file: exactly the people the map counts there.
        if (companyKey && companyKey === t.key) { best = { pts: 100, rel: 'exact', reason: `Works at ${c.company || t.name}` }; break; }
        if (rel && (!best || best.pts < 60)) best = { pts: 60, rel: 'related', reason: `Company "${c.company}" looks related to ${t.name}` };
      } else {
        if (rel === 'exact') { best = { pts: 100, rel, reason: `Works at ${c.company}` }; break; }
        if ((rel === 'contains' || rel === 'within') && (!best || best.pts < 80)) best = { pts: 80, rel, reason: `Works at ${c.company} (matches ${t.name})` };
        else if (rel === 'related' && (!best || best.pts < 60)) best = { pts: 60, rel, reason: `Company "${c.company}" looks related to ${t.name}` };
      }
      if (!rel && position && t.re.test(position) && (!best || best.pts < 35)) best = { pts: 35, rel: 'title', reason: `Title mentions ${t.name}: "${position.slice(0, 80)}"` };
    }
    return best;
  };
  const placeHit = (c, places) => {
    const loc = String(c.location || '');
    return loc ? places.find((l) => (l.city ? cityOf(c).toLowerCase() === l.city : l.res.some((re) => re.test(loc)))) : null;
  };
  const excluded = (c, position) => {
    if (exclude.targets.length) { const hit = companyHit(c, exclude.targets, ''); if (hit && STRICT_COMPANY.has(hit.rel)) return true; }
    if (exclude.roles.length && exclude.roles.some((r) => roleHit(r, c, position))) return true;
    if (exclude.tags.length && exclude.tags.some((t) => tagsOf(c).includes(t))) return true;
    if (exclude.locations.length && placeHit(c, exclude.locations)) return true;
    if (exclude.industries.length && exclude.industries.includes(industryOf(c).toLowerCase())) return true;
    return false;
  };

  const scored = [];
  for (const c of list) {
    const reasons = [];
    let score = 0;
    const position = String(c.position || '');
    const tagText = (c.tags || []).join(' ');
    if (excluding && excluded(c, position)) continue;

    let companyMatch = null;
    let kind = null;
    if (relationship) {
      if ((c.relationship === 'firm') !== (relationship === 'firm')) continue;
      score += 10;
      reasons.push(relationship === 'firm' ? `Through ${c.via || 'a colleague'}` : 'Your own contact');
    }
    if (f.names.length) {
      const own = ` ${foldPhrase(c.name)} `;
      const hit = f.names.find((n) => n.split(' ').every((w) => own.includes(` ${w} `)));
      if (!hit) continue;
      score += 100;
      reasons.push(`Named ${c.name}`);
    }
    if (lens) {
      kind = classifyContact(c);
      if (!kind.lenses.includes(lens)) continue;
      // LPs first when raising, founders first when sourcing, then the rest.
      const lead = lens === 'raise' ? ['lp', 'investor', 'banker'] : lens === 'source' ? ['founder', 'investor', 'accelerator', 'executive'] : ['founder', 'executive', 'operator', 'academic', 'consultant'];
      const rank = lead.indexOf(kind.role);
      score += 30 + (rank >= 0 ? (lead.length - rank) * 4 : 0);
      reasons.push(kind.label);
    }
    if (targets.length) {
      const best = companyHit(c, targets, position);
      if (!best) continue;
      score += best.pts;
      companyMatch = best.rel;
      reasons.push(best.reason);
    }

    if (roles.length) {
      const hits = roles.filter((r) => roleHit(r, c, position));
      if (!hits.length) continue;
      for (const r of hits) {
        score += 40 + (r.bonus && r.bonus.test(position) ? 10 : 0);
        reasons.push(roleReason(r, c, position));
      }
    }

    if (f.tags.length) {
      const own = tagsOf(c);
      const hits = f.tags.filter((t) => own.includes(t));
      if (!hits.length || (!tagAny && hits.length < f.tags.length)) continue;
      score += 25;
      const shown = (c.tags || []).filter((raw) => hits.includes(String(raw).trim().toLowerCase().replace(/\s+/g, ' ')));
      reasons.push(`Tagged ${(shown.length ? shown : hits).map((t) => `“${String(t).trim()}”`).join(', ')}`);
    }

    if (industries.length) {
      const ind = industryOf(c);
      if (!industries.includes(ind.toLowerCase())) continue;
      score += 15;
      reasons.push(`In ${ind}`);
    }

    if (when) {
      const d = dayOf(c.connectedOn);
      if (d === null || (when.from !== null && d < when.from) || (when.to !== null && d > when.to)) continue;
      score += 10;
      reasons.push(`Connected ${monthName(d)}`);
    }

    if (keywords.length) {
      const text = `${position} ${c.company || ''} ${tagText}`;
      const hits = [];
      for (const k of keywords) {
        const term = k.res.find((x) => x.re.test(text));
        if (term) hits.push({ label: k.label, term: term.term });
      }
      if (!hits.length) continue;
      for (const h of hits.slice(0, 3)) {
        score += 15;
        reasons.push(h.label === h.term ? `Mentions ${h.label}` : `Mentions ${h.label} ("${h.term}")`);
      }
    }

    if (locations.length) {
      if (!placeHit(c, locations)) continue;
      score += 20;
      reasons.push(`Located in ${c.location}`);
    }

    scored.push({ contact: publicContact(c), score, reasons, ...(companyMatch ? { companyMatch } : {}), ...(kind ? { role: kind.role, roleLabel: kind.label } : {}) });
  }

  scored.sort((a, b) => b.score - a.score
    || String(b.contact.connectedOn || '').localeCompare(String(a.contact.connectedOn || ''))
    || String(a.contact.name || '').localeCompare(String(b.contact.name || '')));
  const strictTotal = targets.length ? scored.filter((r) => STRICT_COMPANY.has(r.companyMatch)).length : scored.length;
  return { results: scored.slice(0, limit), total: scored.length, strictTotal, keys: scored.map((r) => r.contact.key), notes, ranked: scored };
}

/**
 * Split company results into people who work there (exact / contains /
 * within) and "possibly related" ones (similar company name, or the company
 * only mentioned in their title). Both lists keep their ranking; with the
 * full ranking (`ranked`, from scoreContacts) the split is made over every
 * match and each side carries its uncapped `keys`.
 */
export function splitByCompanyMatch({ results, total, strictTotal, ranked }, { limit = MAX_RESULTS } = {}) {
  const all = Array.isArray(ranked) ? ranked : results;
  const strict = all.filter((r) => STRICT_COMPANY.has(r.companyMatch));
  const related = all.filter((r) => !STRICT_COMPANY.has(r.companyMatch));
  return {
    results: strict.slice(0, limit),
    total: Array.isArray(ranked) ? strict.length : strictTotal,
    keys: strict.map((r) => r.contact.key),
    possiblyRelated: {
      results: related.slice(0, limit),
      total: Array.isArray(ranked) ? related.length : Math.max(0, total - strictTotal),
      keys: related.map((r) => r.contact.key),
    },
  };
}

// ------------------------------------------------------------ intro paths

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Investors named in a company profile (investors + round leads), deduped. */
export function investorsFromProfile(profile) {
  const out = [];
  const add = (name, evidence) => {
    const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const key = normalizeCompanyKey(clean);
    if (!key || out.some((i) => i.key === key)) return;
    out.push({ name: clean, key, evidence });
  };
  for (const inv of profile?.investors || []) add(inv?.name, inv?.evidence || 'investor');
  for (const round of profile?.fundingRounds || []) {
    for (const lead of round?.leadInvestors || []) add(lead, `led ${round.round || 'a round'}`);
  }
  return out.slice(0, 40);
}

/**
 * Who could introduce the user to `target`?
 *  direct:        contacts whose company is the target (at most 100; `directTotal` and `keys` count them all)
 *  possiblyRelated: similar company names or the target only mentioned in a title
 *  viaInvestors:  contacts at the company's investors (from public sources), grouped by investor
 *  viaPastEmployees: [] (the exports carry no employment history)
 */
export async function introPaths(contacts, target, { profileLoader = buildCompanyProfile, timeoutMs = 25000 } = {}) {
  const company = String(target || '').trim().slice(0, 120);
  const split = splitByCompanyMatch(scoreContacts(contacts, { companies: [company] }));
  const direct = split.results;
  const possiblyRelated = split.possiblyRelated.results;
  const notes = [];
  let investors = [];
  let profileStatus = 'ok';
  try {
    const profile = await withTimeout(Promise.resolve(profileLoader(company)), timeoutMs);
    investors = investorsFromProfile(profile);
    if (!investors.length) notes.push(`No investors for ${company} were found in public sources, so investor paths could not be checked.`);
  } catch (error) {
    profileStatus = 'unavailable';
    notes.push(`Could not load ${company}'s investors right now (${error.message}); showing direct contacts only.`);
  }

  const list = Array.isArray(contacts) ? contacts : [];
  // The map's own company key: a placeholder employer ("Self-employed") is
  // no company, so it never matches an investor's name (data-2).
  const keyed = list.map((c) => ({ c, key: companyKeyFor(c) })).filter((x) => x.key);
  const viaInvestors = [];
  for (const inv of investors) {
    const people = [];
    for (const { c, key } of keyed) {
      const rel = companyRelation(key, inv.key);
      if (!rel) continue;
      people.push({
        contact: publicContact(c),
        score: rel === 'exact' ? 100 : rel === 'related' ? 60 : 80,
        reasons: [`Works at ${c.company}, an investor in ${company} (${inv.evidence})`],
      });
    }
    if (people.length) {
      people.sort((a, b) => b.score - a.score || a.contact.name.localeCompare(b.contact.name));
      // The rows stay capped; `keys` holds everyone there, so the page lights
      // and counts all `total` of them, not only the 50 listed.
      viaInvestors.push({ investor: inv.name, evidence: inv.evidence, contacts: people.slice(0, 50), total: people.length, keys: people.map((p) => p.contact.key) });
    }
  }
  viaInvestors.sort((a, b) => b.total - a.total);
  notes.push('Past employees cannot be identified: the imported data has no employment history.');
  return {
    target: company,
    direct,
    directTotal: split.total,
    keys: split.keys,
    possiblyRelated,
    viaInvestors,
    investorsChecked: investors.map((i) => i.name),
    viaPastEmployees: [],
    profileStatus,
    notes,
  };
}

/** Distinct location strings of the contacts (for lower-case place detection). */
export function knownLocationsOf(contacts) {
  const out = new Set();
  for (const c of Array.isArray(contacts) ? contacts : []) if (c?.location) out.add(String(c.location));
  return out;
}

/** How a role label is named back: the user's kind of person, in the page's words ("CEOs", "Clinicians"). */
function roleShown(label) {
  const l = String(label).toLowerCase().trim();
  const own = ROLE_GROUPS.find((g) => g.label === l);
  if (own) return own.shown || own.label;
  const fam = FAMILY_BY_LABEL.get(l);
  if (fam) return fam.title || fam.many.charAt(0).toUpperCase() + fam.many.slice(1);
  const g = roleGroupFor(l);
  if (g?.shown) return g.shown;
  return String(label).charAt(0).toUpperCase() + String(label).slice(1);
}

/**
 * What the rules read from a question, as short plain phrases the page can
 * show under the answer ("At Stripe", "Investors", "Tagged “prospect”",
 * "In Healthcare", "In New York", "Connected in 2024", "Not at Google").
 */
export function understoodOf(filters) {
  const out = [];
  if (!filters) return out;
  const quote = (tags, joiner) => tags.map((t) => `“${t}”`).join(joiner);
  for (const n of filters.names || []) out.push(`Named ${n}`);
  for (const c of filters.companies || []) out.push(`At ${c}`);
  for (const r of filters.roles || []) out.push(roleShown(r));
  const tags = filters.tags || [];
  if (tags.length === 1) out.push(`Tagged ${quote(tags)}`);
  else if (tags.length > 1) out.push(`Tagged ${quote(tags, filters.tagMode === 'any' ? ' or ' : ' and ')}`);
  for (const i of filters.industries || []) out.push(`In ${i}`);
  for (const l of filters.locations || []) out.push(`In ${l}`);
  if (filters.connected?.label) out.push(`Connected ${filters.connected.label}`);
  if (filters.relationship === 'firm') out.push('Through colleagues');
  if (filters.relationship === 'direct') out.push('Your own contacts');
  for (const k of filters.keywords || []) out.push(`Mentions ${k}`);
  const ex = filters.exclude || {};
  for (const c of ex.companies || []) out.push(`Not at ${c}`);
  for (const r of ex.roles || []) out.push(`Not ${roleShown(r).toLowerCase()}`);
  for (const t of ex.tags || []) out.push(`Not tagged “${t}”`);
  for (const i of ex.industries || []) out.push(`Not in ${i}`);
  for (const l of ex.locations || []) out.push(`Not in ${l}`);
  return out;
}

// The page never names the lenses (spec section 1): a note says whom it looked for.
const LENS_PEOPLE = {
  raise: 'an investor, an allocator or a banker',
  source: 'a founder, an investor or someone who sees new companies early',
  diligence: 'an expert, an operator or an advisor',
};

/**
 * Full pipeline used by the API route. `target` is a company given as data
 * (the page's "Intro paths" button): it is never parsed and never reaches a
 * model. `fromPage` marks a question the page built itself (an example): the
 * model is never used for it. Every answer carries `keys`, the contact key
 * of every match in rank order, uncapped; `results` stay capped.
 */
export async function answerQuestion(contacts, { question, target, useLlm = true, fromPage = false, profileLoader, complete, today } = {}) {
  const list = Array.isArray(contacts) ? contacts : [];
  const vocab = vocabularyOf(list);
  const parsed = target
    ? { filters: { companies: [String(target).trim().slice(0, 120)], roles: [], keywords: [], locations: [], tags: [], industries: [], connected: null, intent: 'intro-path', lens: null }, parsedBy: 'target' }
    : await parseQuestion(question, { useLlm: useLlm && !fromPage, complete, knownLocations: knownLocationsOf(list), vocab, today });
  const { filters } = parsed;
  // "Self-employed", "Stealth", "N/A" name no company (data-2): nobody is
  // counted under one on the map, so a question never lists people for it
  // and never looks one up in public sources.
  const placeholders = (filters.companies || []).filter((name) => isPlaceholderCompany(name));
  if (placeholders.length) filters.companies = filters.companies.filter((name) => !placeholders.includes(name));
  const placeholderNote = placeholders.length
    ? [`${placeholders.map((w) => `“${w}”`).join(', ')} ${placeholders.length === 1 ? 'is' : 'are'} not a company (people write it when they work for themselves or do not say where), so nobody is listed for it.`]
    : [];
  if (placeholders.length && filters.intent === 'intro-path' && !filters.companies.length) filters.intent = 'general';
  const response = {
    question: String(question || (target ? `Intro paths to ${target}` : '')).slice(0, 500),
    filters,
    understood: understoodOf(filters),
    parsedBy: parsed.parsedBy,
    intent: filters.intent,
    contactCount: list.length,
  };
  const notUsed = [...placeholderNote, ...(filters.notUsed?.length ? [`Not used: ${filters.notUsed.map((w) => `“${w}”`).join(', ')}.`] : [])];
  if (placeholders.length && !filters.companies.length && !filters.roles.length && !filters.keywords.length && !filters.locations.length
    && !filters.tags?.length && !filters.industries?.length && !filters.connected && !filters.names?.length) {
    return { ...response, results: [], total: 0, keys: [], notes: notUsed };
  }
  if (filters.intent === 'intro-path' && filters.companies[0]) {
    const intro = await introPaths(list, filters.companies[0], profileLoader ? { profileLoader } : undefined);
    return { ...response, results: intro.direct, total: intro.directTotal, keys: intro.keys, intro, notes: [...notUsed, ...intro.notes] };
  }
  const scored = scoreContacts(list, filters, { today });
  const notes = [...notUsed, ...(scored.notes || [])];
  if (filters.lens && scored.total === 0) {
    notes.push(`Nobody in your network looks like ${LENS_PEOPLE[filters.lens]}${filters.keywords.length || filters.companies.length || filters.locations.length || filters.tags?.length || filters.industries?.length || filters.connected ? ' with those filters' : ''}. Roles come from titles and company names in your import.`);
  }
  // "Who can vet this" with nothing else would list most of the file: ask for a company or a field instead.
  const alone = !filters.companies.length && !filters.roles.length && !filters.keywords.length && !filters.locations.length
    && !filters.tags?.length && !filters.industries?.length && !filters.connected && !filters.names?.length && !filters.exclude;
  if (filters.lens === 'diligence' && alone && list.length >= 10 && scored.total > list.length * 0.6) {
    return {
      ...response, results: [], total: 0, keys: [],
      notes: [...notes, 'That would list most of your network. Name a company or a field to narrow it, e.g. “experts in fintech” or “who knows about Stripe”.'],
    };
  }
  if (filters.companies.some((name) => normalizeCompanyKey(name))) {
    // "Who do I know at X": people at X first; similar names and title
    // mentions are listed separately so they are not mistaken for employees.
    const split = splitByCompanyMatch(scored);
    return { ...response, ...split, notes };
  }
  return { ...response, results: scored.results, total: scored.total, keys: scored.keys, notes };
}
