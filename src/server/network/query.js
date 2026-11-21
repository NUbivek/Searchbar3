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
 * exactly the investors chip's people), and it knows the file's tags
 * ("prospects in New York", "everyone tagged committed"), the map's industry
 * labels ("founders in Big Tech"), the file's cities, and when people were
 * connected ("this year", "in 2024", "in the last 12 months", "recently").
 *
 *   scoreContacts(contacts, filters) -> ranked matches, each with reasons
 *   introPaths(contacts, 'Stripe')    -> direct contacts + contacts at Stripe's investors
 *
 * Optionally an LLM turns an unusual question into the same filter shape. It
 * only ever receives the question text, never contact data. Contacts are
 * never sent to any external service.
 */
import { chatComplete } from '../llm/providers';
import { buildCompanyProfile } from '../companyProfile';
import { normalizeCompanyKey, companyMatch, dedupeKey } from '../../utils/network/parseContacts';

import { classifyContact, lensFromQuestion, LENS_KEYS, FAMILIES, familyByKey } from '../../utils/network/roles';
import { KEYWORD_GROUPS } from '../../utils/network/sectors';
import { industryOf, isSector, tagsOf, cityOf } from '../../utils/network/grouping';
import { seniority } from '../../utils/network/atlas';

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
 *   title   with a family, a narrower title test inside it ("designers" are
 *           the product family's people whose title says design)
 *   senior  the map's "senior leaders" (seniority 0)
 * Groups with neither (CEOs, CTOs, CFOs, executives) are plain title tests.
 * `match` stays the title vocabulary other code ranks titles with
 * (founder/networkLink.js).
 */
export const ROLE_GROUPS = [
  { label: 'software engineers', family: 'engineers', title: /\b(software|engineer(?:ing)?|developer|swe|sde|programmer|devops|sre|full[- ]?stack|front[- ]?end|back[- ]?end|architect)\b/i, bonus: /\b(software|swe|sde|developer|programmer)\b/i, ask: /\b(software\s+engineer(?:s|ing)?|swes?|sdes?|software\s+developers?|programmers?|coders?)\b/i, match: /\b(software|engineer(?:ing)?|developer|swe|sde|programmer|devops|sre|full[- ]?stack|front[- ]?end|back[- ]?end|architect)\b/i },
  { label: 'engineers', family: 'engineers', ask: /\b(engineers?|engineering|developers?|devs)\b/i, match: /\b(engineer(?:ing)?|developer|swe|sde|programmer|devops|sre|architect)\b/i },
  { label: 'product managers', family: 'product', title: /\b(product\s+(?:manager|lead|owner|management|director)|head of product|vp,? product|cpo|pm)\b/i, ask: /\b(product\s+(?:managers?|leads?|owners?|people|folks)|pms)\b/i, match: /\b(product\s+(?:manager|lead|owner|management|director)|head of product|vp,? product|cpo|pm)\b/i },
  { label: 'designers', family: 'product', title: /\b(design\w*|ux|ui)\b/i, ask: /\b(designers?|ux|ui\/ux)\b/i, match: /\b(design(?:er)?|ux|ui)\b/i },
  // Data engineers and ML engineers build: they are engineers, asked as such.
  { label: 'data scientists', family: 'data', ask: /\b(data\s+(?:scientists?|science|people|folks|analysts?)|analysts?|analytics\s+people)\b/i, match: /\b(data|machine learning|ml|analyst|analytics|scientist)\b/i },
  { label: 'founders', family: 'founders', ask: /\b(co-?founders?|founders?|entrepreneurs?)\b/i, match: /\b(co-?founder|founder|founding)\b/i },
  { label: 'ceos', ask: /\b(ceos?|chief executives?)\b/i, match: /\b(ceo|chief executive)\b/i },
  { label: 'ctos', ask: /\b(ctos?|chief technology officers?)\b/i, match: /\b(cto|chief technology)\b/i },
  { label: 'cfos', ask: /\b(cfos?|chief financial officers?|finance leaders?)\b/i, match: /\b(cfo|chief financial|vp,? finance|head of finance)\b/i },
  // The map's "senior leaders" chip, counted the same way.
  { label: 'senior leaders', senior: true, ask: /\b(senior\s+leaders?|senior\s+leadership|c-?suite)\b/i, match: /\b(founder|co-?founder|ceo|chief|president|owner|chair|managing (?:director|partner)|general partner|partner|principal)\b/i },
  { label: 'executives', ask: /\b(executives?|execs?|leadership|leaders|vps?|directors?|heads? of)\b/i, match: /\b(ceo|cto|cfo|coo|cmo|cpo|chief|president|vp|vice president|svp|evp|head of|director|managing director|general manager|gm)\b/i },
  { label: 'investors', family: 'investors', ask: /\b(investors?|vcs?|venture\s+capitalists?|angels?|angel\s+investors?|fund\s+managers?)\b/i, match: /\b(investor|investing|investments?|venture|vc|general partner|managing partner|principal|angel|fund)\b/i },
  { label: 'recruiters', family: 'people', ask: /\b(recruiters?|recruiting|talent\s+(?:partners?|acquisition|people)|hiring\s+managers?|hr\s+people)\b/i, match: /\b(recruit\w*|talent|sourcer|people ops|human resources|hr)\b/i },
  { label: 'marketing', family: 'sales', title: /\b(marketing|marketer|growth|brand|cmo|communications|content|demand gen\w*|pr)\b/i, ask: /\b(marketing|marketers?|growth\s+(?:people|leads?|marketers?)|brand\s+people)\b/i, match: /\b(marketing|marketer|growth|brand|cmo|communications|content)\b/i },
  { label: 'sales', family: 'sales', title: /\b(sales|account executive|account manag\w*|business development|bd|bdr|sdr|partnerships?|revenue|cro|customer success|go-to-market|gtm)\b/i, ask: /\b(sales(?:people|\s+people)?|account\s+executives?|business\s+development|bizdev|bd\s+people)\b/i, match: /\b(sales|account executive|account manager|business development|bdr|sdr|partnerships|revenue)\b/i },
  { label: 'lawyers', family: 'lawyers', ask: /\b(lawyers?|attorneys?|counsel|legal\s+(?:people|folks|team))\b/i, match: /\b(lawyer|attorney|counsel|legal|solicitor|barrister)\b/i },
  { label: 'consultants', family: 'consultants', ask: /\b(consultants?|consulting|advisors?|advisers?)\b/i, match: /\b(consultant|consulting|advisor|adviser)\b/i },
  { label: 'researchers', family: 'academics', ask: /\b(researchers?|scientists?|professors?|phds?|academics?)\b/i, match: /\b(research\w*|scientist|professor|ph\.?d|postdoc|lecturer)\b/i },
  { label: 'doctors', family: 'clinicians', ask: /\b(doctors?|physicians?|clinicians?|surgeons?|nurses?|medics?)\b/i, match: /\b(md|doctor|physician|surgeon|clinician|nurse)\b/i },
  { label: 'bankers', family: 'bankers', ask: /\b(bankers?|investment\s+banking|m&a\s+(?:people|folks|advisors?))\b/i, match: /\b(banker|investment bank\w*|m&a|capital markets)\b/i },
  { label: 'accountants', family: 'finance', ask: /\b(accountants?|accounting\s+people|finance\s+(?:people|folks|team))\b/i, match: /\b(accountant|accounting|cpa|controller|finance)\b/i },
  { label: 'operations people', family: 'operations', ask: /\b(?:operations|ops)\s+(?:people|folks|team|leads?|managers?)\b/i, match: /\b(operations|ops)\b/i },
  { label: 'students', family: 'students', ask: /\b(students?|interns?|new\s+grads?)\b/i, match: /\b(student|intern|trainee)\b/i },
  { label: 'journalists', family: 'press', ask: /\b(journalists?|reporters?|editors?)\b/i, match: /\b(journalist|reporter|editor|correspondent)\b/i },
  { label: 'public sector people', family: 'public', ask: /\b(government\s+(?:people|folks|officials?)|civil\s+servants?|policy\s+(?:people|folks|experts?))\b/i, match: /\b(policy|government|public sector)\b/i },
  { label: 'accelerator people', family: 'accelerators', ask: /\b(accelerator\s+(?:people|folks|staff|leads?)|community\s+leads?)\b/i, match: /\b(accelerator|incubator|community)\b/i },
];

/**
 * Every family's own words ("Which sales and marketing people do I know?",
 * "a founder or CEO"), read before the groups above so a chip's label typed
 * back as a question counts exactly the chip's people. Single-word labels
 * ("investors", "engineers") are left to the groups, where a narrower phrase
 * ("software engineers") can win first.
 */
const phraseRe = (label) => new RegExp(`\\b${label.toLowerCase().split(/\s+/)
  .map((w) => (w === 'and' ? '(?:and|&)' : w === 'or' ? '(?:or|and|&)' : w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  .join('\\s+')}\\b`, 'i');
const FAMILY_PHRASES = FAMILIES
  .flatMap((f) => [f.many, f.one].filter((l) => /\s/.test(l)).map((l) => ({ label: f.many, family: f.key, ask: phraseRe(l) })))
  // Longest first: "data scientist or analyst" before shorter phrases.
  .sort((a, b) => b.ask.source.length - a.ask.source.length);
const FAMILY_BY_LABEL = new Map(FAMILIES.flatMap((f) => [[f.many.toLowerCase(), f], [f.one.toLowerCase(), f]]));

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NUMBER_WORDS = { few: 3, one: 1, a: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, eighteen: 18, 'twenty-four': 24 };

const LOCATION_ALIASES = {
  sf: ['san francisco', 'sf', 'bay area'],
  'san francisco': ['san francisco', 'sf', 'bay area'],
  'bay area': ['san francisco', 'bay area', 'palo alto', 'oakland', 'san jose', 'mountain view', 'menlo park', 'berkeley'],
  nyc: ['new york', 'nyc', 'brooklyn', 'manhattan'],
  'new york': ['new york', 'nyc', 'brooklyn', 'manhattan'],
  la: ['los angeles', 'la'],
  'los angeles': ['los angeles', 'la'],
  uk: ['united kingdom', 'uk', 'london', 'england'],
  us: ['united states', 'usa', 'us'],
  usa: ['united states', 'usa', 'us'],
};

const STOPWORDS = new Set((
  'a an the of for about on in at to and or with from by is are was were be been what who whom which how when where why ' +
  'do does did i me my mine we our us you your know knows knew find show list give get tell any anyone anybody someone somebody ' +
  'people person persons folks contacts contact connections connection network friends friend everyone all some might could should would can ' +
  'work works working worked employed there that this these those have has had them they their please help me intro introduction introductions ' +
  'warm path paths reach into via through connect job jobs opportunities opportunity role roles industry sector space field ' +
  'currently now based located near around who\'s whos connected added tagged'
).split(/\s+/));

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (term) => new RegExp(`(^|[^a-z0-9])${escapeRe(String(term).toLowerCase())}($|[^a-z0-9])`, 'i');
const cleanList = (list, max = 10) => {
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (s && !out.some((o) => o.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= max) break;
  }
  return out;
};

// ------------------------------------------------------------ parsing

/** Trim a captured company phrase: drop trailing clauses and filler. */
function cleanEntity(raw) {
  let s = String(raw || '').replace(/[?!;:]+.*$/, '').replace(/\.\s.*$/, '').replace(/\.$/, '').trim();
  s = s.split(/\s+(?:in\s+my|in\s+the|from\s+my|who|that|which|whose|where|and\s+who|based|located|near|as|for|right\s+now|currently|in|with)\b/i)[0];
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

/**
 * Rule-based question -> filters.
 * `knownLocations` (the distinct location strings of the user's contacts)
 * lets a lower-case place after "in"/"near" ("who works in paris") be
 * accepted only when some contact is actually there; without it any such
 * word that is not a role, industry or company counts as a place.
 */
export function parseQuestionRules(question, { knownLocations, vocab, today } = {}) {
  const q = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const filters = { companies: [], roles: [], keywords: [], locations: [], tags: [], industries: [], connected: null, intent: 'general', lens: null };
  if (!q) return filters;
  let rest = q;
  // A recognised phrase is cut out of `rest` so it is not read twice ("Big
  // Tech" is not also a place, "software engineers" not also "engineers").
  const cut = (re) => { rest = rest.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`), ' ').replace(/\s+/g, ' '); };
  // "Who can help me raise / source deals / diligence X": a lens over the
  // network, optionally narrowed by company, industry or place.
  filters.lens = lensFromQuestion(q);

  for (const re of INTRO_PATTERNS) {
    const m = q.match(re);
    const company = m && cleanEntity(m[1]);
    if (company) {
      filters.companies.push(company);
      filters.intent = 'intro-path';
      rest = rest.replace(m[0], ' ');
      break;
    }
  }
  if (filters.intent !== 'intro-path') {
    for (const re of COMPANY_PATTERNS) {
      const m = q.match(re);
      const companies = m ? cleanEntities(m[1]).filter((c) => !isGenericWord(c)) : [];
      if (companies.length) {
        filters.companies.push(...companies);
        rest = rest.replace(new RegExp(`\\b(?:at|@|for|with)\\s+${escapeRe(companies[0])}`, 'i'), ' ');
        for (const c of companies.slice(1)) rest = rest.replace(new RegExp(`(^|\\s)${escapeRe(c)}(?=\\s|$|[?!.,;:])`, 'i'), '$1');
        break;
      }
    }
  }

  // Tags named outright: "everyone tagged committed", "with the tag warm".
  const knownTags = (vocab?.tags || []).map((t) => String(t).toLowerCase()).filter(Boolean);
  const explicitTag = /\b(?:tagged(?:\s+as)?|with\s+(?:the\s+)?tags?|labell?ed(?:\s+as)?|marked\s+as)\s+["“'‘]?([^"”'’?!,.;]+?)["”'’]?(?=$|[?!,.;]|\s+(?:in|at|from|who|whom|that|and|or|near|based|located|i|we)\b)/i;
  for (let i = 0; i < 3; i += 1) {
    const m = rest.match(explicitTag);
    if (!m) break;
    const said = m[1].trim().toLowerCase();
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

  // Tags of this file said plainly ("prospects in New York", "my champions"),
  // unless the word is a kind of person the map already counts.
  for (const tag of [...knownTags].sort((a, b) => b.length - a.length)) {
    if (tag.length < 3 || /^\d+$/.test(tag) || STOPWORDS.has(tag)) continue;
    if (ROLE_GROUPS.some((g) => g.ask.test(tag)) || FAMILY_BY_LABEL.has(tag)) continue;
    const re = tagRe(tag);
    if (!re.test(rest)) continue;
    if (!filters.tags.includes(tag)) filters.tags.push(tag);
    cut(re);
  }

  // Roles: a specific group wins over its generic parent ("software engineers" vs "engineers").
  for (const g of ROLE_GROUPS) {
    if (!g.ask.test(rest)) continue;
    if (g.label === 'executives' && filters.roles.some((r) => ['ceos', 'ctos', 'cfos', 'senior leaders'].includes(r))) continue;
    if (!filters.roles.includes(g.label)) filters.roles.push(g.label);
    cut(g.ask);
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

  const lower = rest.toLowerCase();
  for (const g of KEYWORD_GROUPS) {
    if (g.ask.test(lower)) {
      // "ai" inside "data scientists" style role phrases is already covered by the role
      if (g.label === 'venture capital' && filters.roles.includes('investors')) continue;
      filters.keywords.push(g.label);
    }
  }

  // Locations: "in/based in/near <Capitalised Place>" or a known short form.
  const locRe = /\b(?:based\s+in|located\s+in|living\s+in|in|near|around)\s+([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,3}(?:,\s*[A-Z][A-Za-z.'-]*)?)/g;
  let lm;
  while ((lm = locRe.exec(rest))) {
    const place = lm[1].trim();
    const isKeyword = KEYWORD_GROUPS.some((g) => g.ask.test(place)) || ROLE_GROUPS.some((g) => g.ask.test(place));
    if (!isKeyword && !filters.companies.some((c) => c.toLowerCase() === place.toLowerCase())) filters.locations.push(place);
  }
  const shortLoc = lower.match(/\b(?:in|based in|near|around)\s+(sf|nyc|la|the bay area|bay area|new york|san francisco|los angeles|london|uk|usa|us)\b/);
  if (shortLoc) {
    const place = shortLoc[1].replace(/^the\s+/, '');
    if (!filters.locations.some((l) => l.toLowerCase() === place)) filters.locations.push(place);
  }
  // Lower-case places ("who works in paris"): the words after in/near up to
  // the next filler word, when they are not a role, an industry or a company.
  if (!filters.locations.length) {
    const lowRe = /\b(?:based\s+in|located\s+in|living\s+in|in|near|around)\s+((?:the\s+)?[a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,2})/g;
    let lowM;
    const known = knownLocations ? [...knownLocations].map((l) => String(l || '').toLowerCase()).filter(Boolean) : null;
    while ((lowM = lowRe.exec(rest))) {
      const words = [];
      for (const w of lowM[1].replace(/^the\s+/, '').split(/\s+/)) {
        if (STOPWORDS.has(w.replace(/[.'-]+$/, '')) || /^(?:my|our|your)$/.test(w)) break;
        words.push(w);
      }
      const place = words.join(' ').replace(/[.,]+$/, '');
      if (!place) continue;
      if (KEYWORD_GROUPS.some((g) => g.ask.test(place)) || ROLE_GROUPS.some((g) => g.ask.test(place))) continue;
      if (filters.companies.some((c) => c.toLowerCase() === place)) continue;
      if (known && !known.some((l) => wordRe(place).test(l))) continue;
      const shown = place.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
      if (!filters.locations.some((l) => l.toLowerCase() === place)) filters.locations.push(shown);
      break;
    }
  }

  if (filters.intent !== 'intro-path') {
    if (filters.companies.length) filters.intent = 'who-at';
    else if (filters.roles.length) filters.intent = 'role';
    else if (filters.lens) filters.intent = 'lens';
  }
  const fromFile = filters.tags.length || filters.industries.length || filters.connected;
  // With a lens, generic words ("fund", "deals", "company") are not keywords.
  if (filters.lens && !filters.companies.length && !filters.roles.length && !filters.keywords.length && !filters.locations.length && !fromFile) {
    return { ...filters, companies: [], roles: [], keywords: [], locations: [] };
  }
  if (filters.lens && filters.roles.includes('investors') && filters.lens === 'raise') filters.roles = filters.roles.filter((r) => r !== 'investors');

  // Nothing recognised: fall back to the meaningful words as keywords.
  if (!filters.companies.length && !filters.roles.length && !filters.keywords.length && !filters.locations.length && !fromFile) {
    const words = rest.toLowerCase().replace(/[^a-z0-9&+.\- ]+/g, ' ').split(/\s+/)
      .map((w) => w.replace(/^[.\-]+|[.\-]+$/g, ''))
      .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
    filters.keywords = cleanList(words, 6);
  }
  filters.companies = cleanList(filters.companies, 5);
  filters.roles = cleanList(filters.roles);
  filters.keywords = cleanList(filters.keywords);
  filters.locations = cleanList(filters.locations, 5);
  filters.tags = cleanList(filters.tags, 5);
  filters.industries = cleanList(filters.industries, 5);
  return filters;
}

/** "prospects" -> "prospect", "companies" -> "company"; other words unchanged. */
function singular(word) {
  const w = String(word || '');
  if (/ies$/.test(w) && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(?:ss|us|is)$/.test(w)) return w;
  if (/(?:ches|shes|xes|sses)$/.test(w)) return w.slice(0, -2);
  return w.replace(/s$/, '');
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
  const yearOk = (y) => y >= 1990 && y <= year + 1;
  const num = (s) => (/^\d+$/.test(s) ? Number(s) : NUMBER_WORDS[String(s).toLowerCase()] || null);
  let m;
  // "in the last 12 months", "over the past year", "last 6 months", "past 90 days"
  const lastRe = /\b(?:(?:in|over|during|within)\s+)?the\s+(?:last|past)\s+(?:(\d{1,3}|[a-z-]+)\s+)?(days?|weeks?|months?|years?)\b|\b(?:last|past)\s+(\d{1,3}|[a-z-]+)\s+(days?|weeks?|months?|years?)\b/i;
  if ((m = t.match(lastRe))) {
    const count = num(m[1] || m[3] || '1') || (m[1] || m[3] ? null : 1);
    const unit = (m[2] || m[4]).toLowerCase().replace(/s$/, '');
    if (count) {
      const months = unit === 'year' ? count * 12 : unit === 'month' ? count : null;
      const days = unit === 'day' ? count : unit === 'week' ? count * 7 : null;
      const label = `in the last ${count === 1 ? '' : `${count} `}${unit}${count === 1 ? '' : 's'}`.replace('last  ', 'last ');
      return { connected: { kind: 'last', ...(months ? { months } : { days }), label }, cuts: [lastRe] };
    }
  }
  const recentRe = /\b(?:recent(?:ly)?|lately|new(?:est)?\s+connections?)\b/i;
  if (recentRe.test(t)) return { connected: { kind: 'last', months: 12, label: 'recently' }, cuts: [recentRe] };
  const thisYearRe = /\b(?:this|the\s+current)\s+year\b/i;
  if (thisYearRe.test(t)) return { connected: { kind: 'range', from: `${year}-01-01`, to: `${year}-12-31`, label: `in ${year}` }, cuts: [thisYearRe] };
  const lastYearRe = /\blast\s+year\b/i;
  if (lastYearRe.test(t)) return { connected: { kind: 'range', from: `${year - 1}-01-01`, to: `${year - 1}-12-31`, label: `in ${year - 1}` }, cuts: [lastYearRe] };
  const thisMonthRe = /\bthis\s+month\b/i;
  if (thisMonthRe.test(t)) {
    const d = new Date(now * DAY_MS);
    return { connected: { kind: 'range', from: isoOf(dayFromParts(year, d.getUTCMonth(), 1)), to: isoOf(dayFromParts(year, d.getUTCMonth() + 1, 0)), label: 'this month' }, cuts: [thisMonthRe] };
  }
  // "in March 2025"
  const monthRe = /\b(?:in|during)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+((?:19|20)\d{2})\b/i;
  if ((m = t.match(monthRe)) && yearOk(Number(m[2]))) {
    const mi = MONTHS.indexOf(m[1].toLowerCase().slice(0, 3));
    const y = Number(m[2]);
    return { connected: { kind: 'range', from: isoOf(dayFromParts(y, mi, 1)), to: isoOf(dayFromParts(y, mi + 1, 0)), label: `in ${monthName(dayFromParts(y, mi, 1))}` }, cuts: [monthRe] };
  }
  // "since 2023", "after 2022", "before 2020"
  const sinceRe = /\b(since|after|from|before|prior\s+to)\s+((?:19|20)\d{2})\b/i;
  if ((m = t.match(sinceRe)) && yearOk(Number(m[2]))) {
    const y = Number(m[2]);
    const word = m[1].toLowerCase();
    if (word === 'before' || word.startsWith('prior')) return { connected: { kind: 'range', from: null, to: `${y - 1}-12-31`, label: `before ${y}` }, cuts: [sinceRe] };
    const from = word === 'after' ? `${y + 1}-01-01` : `${y}-01-01`;
    return { connected: { kind: 'range', from, to: null, label: word === 'after' ? `after ${y}` : `since ${y}` }, cuts: [sinceRe] };
  }
  // "in 2024", "during 2024", "connected 2024"
  const yearRe = /\b(?:in|during|connected|added|met)\s+((?:19|20)\d{2})\b/i;
  if ((m = t.match(yearRe)) && yearOk(Number(m[1]))) {
    const y = Number(m[1]);
    return { connected: { kind: 'range', from: `${y}-01-01`, to: `${y}-12-31`, label: `in ${y}` }, cuts: [/\b(?:in|during)\s+(?:19|20)\d{2}\b/i, new RegExp(`\\b${y}\\b`)] };
  }
  return null;
}

/**
 * The words of one file the rules can recognise: its tags, the map's
 * industry labels that are sectors and that someone in the file falls under,
 * and its location strings. Read from the contacts on the server; nothing is
 * sent anywhere.
 */
export function vocabularyOf(contacts) {
  const tags = new Set();
  const industries = new Set();
  for (const c of Array.isArray(contacts) ? contacts : []) {
    for (const t of tagsOf(c)) tags.add(t);
    const ind = industryOf(c);
    if (isSector(ind)) industries.add(ind);
  }
  return { tags: [...tags], industries: [...industries] };
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

/** Validate an LLM (or client) filter object into the canonical shape, or null. */
export function validateFilters(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const f = {
    companies: cleanList(obj.companies, 5),
    roles: cleanList(obj.roles),
    keywords: cleanList(obj.keywords),
    locations: cleanList(obj.locations, 5),
    intent: INTENTS.includes(obj.intent) ? obj.intent : null,
    lens: LENS_KEYS.includes(obj.lens) ? obj.lens : null,
  };
  if (!f.intent) {
    if (f.companies.length) f.intent = 'who-at';
    else if (f.roles.length) f.intent = 'role';
    else if (f.lens) f.intent = 'lens';
    else f.intent = 'general';
  }
  if (f.intent === 'intro-path' && !f.companies.length) f.intent = 'general';
  if (!f.companies.length && !f.roles.length && !f.keywords.length && !f.locations.length && !f.lens) return null;
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
Return ONLY a JSON object: {"companies": [], "roles": [], "keywords": [], "locations": [], "intent": "who-at" | "role" | "intro-path" | "general" | "lens", "lens": null | "raise" | "source" | "diligence"}.
lens: "raise" when the asker wants money or LP/investor introductions, "source" when they want deal flow or founders to meet, "diligence" when they want people who can vet, reference or evaluate a company, founder or market; otherwise null.
companies: organisation names mentioned. roles: job roles (e.g. "software engineers", "investors", "founders").
keywords: industries or topics (e.g. "fintech", "ai"). locations: places. intent: "intro-path" when asking for an introduction or path to a company,
"who-at" when asking who works at a company, "role" when asking for a kind of person, otherwise "general". Use [] when absent. No commentary.`;

/** Ask the configured LLM for filters. Sends only the question text. */
export async function parseQuestionWithLlm(question, { complete = chatComplete } = {}) {
  try {
    const result = await complete([
      { role: 'system', content: LLM_SYSTEM },
      { role: 'user', content: String(question).slice(0, 500) },
    ], { maxTokens: 300, temperature: 0, timeoutMs: 12000 });
    if (!result?.text) return null;
    return validateFilters(extractJson(result.text));
  } catch {
    return null;
  }
}

/**
 * Question -> { filters, parsedBy }. Rules first; the LLM (when configured
 * and allowed) is only consulted when the rules recognised nothing specific.
 */
export async function parseQuestion(question, { useLlm = true, complete, knownLocations, vocab, today } = {}) {
  const rules = parseQuestionRules(question, { knownLocations, vocab, today });
  const specific = rules.companies.length || rules.roles.length || rules.locations.length
    || rules.tags.length || rules.industries.length || rules.connected
    || rules.keywords.some((k) => KEYWORD_GROUPS.some((g) => g.label === k));
  if (specific || !useLlm || String(question || '').trim().split(/\s+/).length < 2) {
    return { filters: rules, parsedBy: 'rules' };
  }
  const llm = await parseQuestionWithLlm(question, complete ? { complete } : undefined);
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
 * and marketing people", "investor"), or a group whose words it contains
 * (a model may say "VCs"). Null when nothing fits.
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

/** Does the contact belong to a role group? Families come from the map's classifier. */
function roleHit(group, contact, position) {
  if (group.senior) return seniority(contact) === 0;
  if (group.family) {
    if (classifyContact(contact).family !== group.family) return false;
    return group.title ? group.title.test(position) : true;
  }
  return group.match.test(position);
}

/** Why the contact counts under a role group, in plain words. */
function roleReason(group, contact, position) {
  if (group.family && !group.title) {
    const kind = classifyContact(contact);
    const fam = familyByKey(group.family);
    const why = kind.reason.startsWith('Company:') ? `from their employer, ${String(contact.company || '').slice(0, 60)}`
      : position ? `title "${position.slice(0, 80)}"` : 'from their employer';
    return `${fam ? fam.one.charAt(0).toUpperCase() + fam.one.slice(1) : group.label} (${why})`;
  }
  if (group.senior) return `Senior leader: "${position.slice(0, 80)}"`;
  return position ? `Title "${position.slice(0, 80)}" matches ${group.label}` : `Company "${contact.company}" matches ${group.label}`;
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
 * (company AND role AND location); keywords match if any one does. Several
 * companies are OR-ed: the best relation wins and is reported as
 * `companyMatch` ('exact' | 'contains' | 'within' | 'related' | 'title').
 * Returns { results: [{ contact, score, reasons, companyMatch }], total,
 * strictTotal (results whose companyMatch is exact/contains/within), notes }.
 */
export function scoreContacts(contacts, filters, { limit = MAX_RESULTS, today } = {}) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const f = {
    companies: arr(filters?.companies), roles: arr(filters?.roles),
    keywords: arr(filters?.keywords), locations: arr(filters?.locations),
    tags: arr(filters?.tags).map((t) => String(t).toLowerCase().trim()).filter(Boolean),
    industries: arr(filters?.industries).map((t) => String(t).trim()).filter(Boolean),
  };
  const list = Array.isArray(contacts) ? contacts : [];
  const targets = f.companies.map((name) => ({ name, key: normalizeCompanyKey(name), re: wordRe(name) })).filter((t) => t.key);
  const roles = f.roles.map((label) => roleGroupFor(label) || { label, match: wordRe(String(label).replace(/s$/i, '')) });
  const keywords = f.keywords.map((label) => {
    const g = keywordGroupFor(label);
    return g ? { label: g.label, res: g.terms.map((t) => ({ term: t, re: wordRe(t) })) } : { label, res: [{ term: label, re: wordRe(label) }] };
  });
  // A place that is one of the contacts' own cities matches by city, as the
  // place chip counts ("New York" is not also "New York Mills"); any other
  // place (a country, a region) matches the location text.
  let cities = null;
  const locations = f.locations.map((place) => {
    if (!cities) cities = new Set(list.map((c) => cityOf(c).toLowerCase()).filter(Boolean));
    const city = cityOf({ location: place }).toLowerCase();
    if (city && cities.has(city)) return { place, city };
    const aliases = LOCATION_ALIASES[place.toLowerCase()] || [place];
    return { place, res: aliases.map((a) => wordRe(a)) };
  });
  // Industry labels compare without case, as typed or as the map shows them.
  const industries = f.industries.map((label) => label.toLowerCase());
  let newest = null;
  if (filters?.connected) for (const c of list) { const d = dayOf(c.connectedOn); if (d !== null && (newest === null || d > newest)) newest = d; }
  const when = connectedWindow(filters?.connected, { today, newest });

  const lens = LENS_KEYS.includes(filters?.lens) ? filters.lens : null;
  const notes = [];
  if (locations.length && !list.some((c) => c.location)) {
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
  if (!targets.length && !roles.length && !keywords.length && !locations.length && !lens && !f.tags.length && !industries.length && !when) {
    return { results: [], total: 0, notes: ['Ask about a company, a role, an industry or a place, e.g. "Who do I know at Stripe?"'] };
  }

  const scored = [];
  for (const c of list) {
    const reasons = [];
    let score = 0;
    const companyKey = normalizeCompanyKey(c.company);
    const position = String(c.position || '');
    const tagText = (c.tags || []).join(' ');

    let companyMatch = null;
    let kind = null;
    if (lens) {
      kind = classifyContact(c);
      if (!kind.lenses.includes(lens)) continue;
      // LPs first when raising, founders first when sourcing, then the rest.
      const lead = lens === 'raise' ? ['lp', 'investor', 'banker'] : lens === 'source' ? ['founder', 'investor', 'accelerator', 'executive'] : ['founder', 'executive', 'operator', 'academic', 'consultant'];
      const rank = lead.indexOf(kind.role);
      score += 30 + (rank >= 0 ? (lead.length - rank) * 4 : 0);
      reasons.push(`${kind.label}${kind.reason ? ` (${kind.reason.replace(/^(Title|Company): /, '').replace(/^Title and company: /, '')})` : ''}`);
    }
    if (targets.length) {
      let best = null;
      for (const t of targets) {
        const rel = companyRelation(companyKey, t.key);
        if (rel === 'exact') { best = { pts: 100, rel, reason: `Works at ${c.company}` }; break; }
        if ((rel === 'contains' || rel === 'within') && (!best || best.pts < 80)) best = { pts: 80, rel, reason: `Works at ${c.company} (matches ${t.name})` };
        else if (rel === 'related' && (!best || best.pts < 60)) best = { pts: 60, rel, reason: `Company "${c.company}" looks related to ${t.name}` };
        else if (!rel && position && t.re.test(position) && (!best || best.pts < 35)) best = { pts: 35, rel: 'title', reason: `Title mentions ${t.name}: "${position.slice(0, 80)}"` };
      }
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
      if (!hits.length) continue;
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
      const loc = String(c.location || '');
      const hit = loc && locations.find((l) => (l.city ? cityOf(c).toLowerCase() === l.city : l.res.some((re) => re.test(loc))));
      if (!hit) continue;
      score += 20;
      reasons.push(`Located in ${loc}`);
    }

    scored.push({ contact: publicContact(c), score, reasons, ...(companyMatch ? { companyMatch } : {}), ...(kind ? { role: kind.role, roleLabel: kind.label } : {}) });
  }

  scored.sort((a, b) => b.score - a.score
    || String(b.contact.connectedOn || '').localeCompare(String(a.contact.connectedOn || ''))
    || a.contact.name.localeCompare(b.contact.name));
  const strictTotal = targets.length ? scored.filter((r) => STRICT_COMPANY.has(r.companyMatch)).length : scored.length;
  return { results: scored.slice(0, limit), total: scored.length, strictTotal, notes };
}

/**
 * Split company results into people who work there (exact / contains /
 * within) and "possibly related" ones (similar company name, or the company
 * only mentioned in their title). Both lists keep their ranking.
 */
export function splitByCompanyMatch({ results, total, strictTotal }) {
  const strict = results.filter((r) => STRICT_COMPANY.has(r.companyMatch));
  const related = results.filter((r) => !STRICT_COMPANY.has(r.companyMatch));
  return {
    results: strict,
    total: strictTotal,
    possiblyRelated: { results: related, total: Math.max(0, total - strictTotal) },
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
 *  direct:        contacts whose company is the target (exact or whole-word containment)
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
  const keyed = list.map((c) => ({ c, key: normalizeCompanyKey(c.company) })).filter((x) => x.key);
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
      viaInvestors.push({ investor: inv.name, evidence: inv.evidence, contacts: people.slice(0, 50), total: people.length });
    }
  }
  viaInvestors.sort((a, b) => b.total - a.total);
  notes.push('Past employees cannot be identified: the imported data has no employment history.');
  return {
    target: company,
    direct,
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

/**
 * What the rules read from a question, as short plain phrases the page can
 * show under the answer ("At Stripe", "Investors", "Tagged “prospect”",
 * "In Healthcare", "In New York", "Connected in 2024").
 */
export function understoodOf(filters) {
  const out = [];
  if (!filters) return out;
  const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
  for (const c of filters.companies || []) out.push(`At ${c}`);
  for (const r of filters.roles || []) out.push(cap(r));
  for (const t of filters.tags || []) out.push(`Tagged “${t}”`);
  for (const i of filters.industries || []) out.push(`In ${i}`);
  for (const l of filters.locations || []) out.push(`In ${l}`);
  if (filters.connected?.label) out.push(`Connected ${filters.connected.label}`);
  for (const k of filters.keywords || []) out.push(`Mentions ${k}`);
  return out;
}

// The page never names the lenses (spec section 1): a note says whom it looked for.
const LENS_PEOPLE = {
  raise: 'an investor, an allocator or a banker',
  source: 'a founder, an investor or someone who sees new companies early',
  diligence: 'an expert, an operator or an advisor',
};

/** Full pipeline used by the API route. */
export async function answerQuestion(contacts, { question, target, useLlm = true, profileLoader, complete, today } = {}) {
  const parsed = target
    ? { filters: { companies: [String(target).trim().slice(0, 120)], roles: [], keywords: [], locations: [], intent: 'intro-path' }, parsedBy: 'target' }
    : await parseQuestion(question, { useLlm, complete, knownLocations: knownLocationsOf(contacts), vocab: vocabularyOf(contacts), today });
  const { filters } = parsed;
  const response = {
    question: String(question || '').slice(0, 500),
    filters,
    understood: understoodOf(filters),
    parsedBy: parsed.parsedBy,
    intent: filters.intent,
    contactCount: Array.isArray(contacts) ? contacts.length : 0,
  };
  if (filters.intent === 'intro-path' && filters.companies[0]) {
    const intro = await introPaths(contacts, filters.companies[0], profileLoader ? { profileLoader } : undefined);
    return { ...response, results: intro.direct, total: intro.direct.length, intro, notes: intro.notes };
  }
  const scored = scoreContacts(contacts, filters, { today });
  if (filters.lens && scored.total === 0) {
    scored.notes = [...(scored.notes || []), `Nobody in your network looks like ${LENS_PEOPLE[filters.lens]}${filters.keywords.length || filters.companies.length || filters.locations.length || filters.tags?.length || filters.industries?.length || filters.connected ? ' with those filters' : ''}. Roles come from titles and company names in your import.`];
  }
  if (filters.companies.some((name) => normalizeCompanyKey(name))) {
    // "Who do I know at X": people at X first; similar names and title
    // mentions are listed separately so they are not mistaken for employees.
    const split = splitByCompanyMatch(scored);
    return { ...response, ...split, notes: scored.notes };
  }
  return { ...response, results: scored.results, total: scored.total, notes: scored.notes };
}
