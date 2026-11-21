/**
 * How the Network Map groups contacts into hubs: by role (see roles.js),
 * by industry (sector vocabulary over title, company and tags), by place
 * (country, or city when one country holds most people) or by the user's
 * own tags. Deterministic, no model. Which arrangements a file is offered
 * depends on the file: one that does not split it is not offered.
 */
import { classifyContact, ROLE_GROUPS } from './roles';
import { KEYWORD_GROUPS } from './sectors';
import { normalizeCompanyKey } from './parseContacts';

const companyKeys = new WeakMap();
/** The contact's normalised company key ('' when none). Cached per contact. */
export function companyKeyFor(contact) {
  if (!contact || typeof contact !== 'object') return '';
  let k = companyKeys.get(contact);
  if (k === undefined) { k = normalizeCompanyKey(contact.company); companyKeys.set(contact, k); }
  return k;
}

// The key 'country' is kept (the page and saved views use it); the
// arrangement groups by place, which is the country or the city.
export const GROUPINGS = [
  { key: 'role', label: 'By role' },
  { key: 'company', label: 'By company' },
  { key: 'industry', label: 'By industry' },
  { key: 'country', label: 'By place' },
  { key: 'tag', label: 'By tag' },
];

const INDUSTRY_LABEL = {
  fintech: 'Fintech', healthcare: 'Healthcare', ai: 'AI', crypto: 'Crypto', saas: 'Software', climate: 'Climate & energy',
  education: 'Education', security: 'Security', gaming: 'Gaming', ecommerce: 'Commerce', biotech: 'Biotech', 'real estate': 'Real estate',
  media: 'Media', 'venture capital': 'Venture capital',
};
export const OTHER_INDUSTRY = 'Other';
export const UNKNOWN_COUNTRY = 'Unknown';
export const NO_TAG = 'No tag';
export const OTHER_TAGS = 'Other tags';

// "venture capital" terms ("partners", "fund") are too generic for an industry grouping.
const SECTOR_GROUPS = () => KEYWORD_GROUPS.filter((g) => g.label !== 'venture capital');
let sectorIndex = null;

/**
 * Well-known employers by industry. Checked before title words, so "Software
 * Engineer at Stripe" is Fintech and "Engineer at Google" is Big Tech.
 * Keys are matched against the normalised company name (whole words).
 */
const COMPANY_INDUSTRY = [
  ['Big Tech', ['google', 'alphabet', 'meta', 'facebook', 'instagram', 'whatsapp', 'amazon', 'aws', 'microsoft', 'linkedin', 'apple', 'netflix', 'nvidia', 'intel', 'ibm', 'oracle', 'salesforce', 'adobe', 'cisco', 'samsung', 'tesla', 'uber', 'airbnb', 'x corp', 'twitter', 'bytedance', 'tiktok', 'tencent', 'alibaba', 'baidu', 'sony', 'qualcomm', 'amd', 'dell', 'hp']],
  ['AI', ['openai', 'anthropic', 'deepmind', 'google deepmind', 'mistral', 'cohere', 'hugging face', 'huggingface', 'scale ai', 'stability ai', 'perplexity', 'inflection', 'character ai', 'xai', 'runway', 'midjourney', 'databricks', 'anyscale', 'together ai', 'groq', 'cerebras', 'harvey', 'glean', 'cursor', 'anysphere', 'replit', 'adept', 'synthesia', 'elevenlabs', 'writer', 'jasper']],
  ['Fintech', ['stripe', 'ramp', 'brex', 'plaid', 'square', 'block', 'paypal', 'venmo', 'chime', 'robinhood', 'coinbase', 'affirm', 'klarna', 'revolut', 'wise', 'nubank', 'mercury', 'rippling', 'gusto', 'carta', 'adyen', 'checkout com', 'marqeta', 'sofi', 'monzo', 'n26', 'deel', 'remote']],
  ['Finance & banking', ['goldman sachs', 'goldman', 'morgan stanley', 'jpmorgan', 'jp morgan', 'chase', 'citi', 'citigroup', 'bank of america', 'wells fargo', 'blackrock', 'blackstone', 'kkr', 'carlyle', 'apollo', 'bridgewater', 'citadel', 'jane street', 'two sigma', 'fidelity', 'vanguard', 'ubs', 'barclays', 'hsbc', 'deutsche bank', 'credit suisse', 'lazard', 'evercore', 'moelis', 'jefferies', 'tpg', 'warburg pincus', 'bain capital', 'thoma bravo', 'vista equity']],
  ['Venture capital', ['sequoia', 'sequoia capital', 'andreessen horowitz', 'a16z', 'y combinator', 'ycombinator', 'khosla', 'khosla ventures', 'accel', 'benchmark', 'greylock', 'kleiner perkins', 'lightspeed', 'index ventures', 'general catalyst', 'founders fund', 'insight partners', 'tiger global', 'coatue', 'gv', 'google ventures', 'nea', 'bessemer', 'first round', 'union square ventures', 'redpoint', 'ivp', 'battery ventures', 'techstars', '500 global', 'softbank', 'lux capital', 'thrive capital', 'craft ventures', 'initialized', 'felicis', 'spark capital', 'menlo ventures']],
  ['Consulting', ['mckinsey', 'mckinsey company', 'boston consulting group', 'bcg', 'bain', 'bain company', 'deloitte', 'pwc', 'pricewaterhousecoopers', 'ey', 'ernst young', 'kpmg', 'accenture', 'oliver wyman', 'kearney', 'roland berger', 'lek', 'alixpartners', 'booz allen']],
  ['Software', ['figma', 'notion', 'atlassian', 'slack', 'zoom', 'dropbox', 'shopify', 'hubspot', 'snowflake', 'datadog', 'mongodb', 'twilio', 'workday', 'servicenow', 'canva', 'airtable', 'asana', 'linear', 'vercel', 'github', 'gitlab', 'zapier', 'retool', 'webflow', 'miro', 'okta', 'cloudflare', 'palantir', 'confluent', 'hashicorp', 'elastic', 'intercom', 'loom', 'calendly']],
  ['Healthcare', ['kaiser', 'mayo clinic', 'unitedhealth', 'cvs', 'pfizer', 'moderna', 'johnson johnson', 'merck', 'novartis', 'roche', 'genentech', 'oscar health', 'one medical', 'hims', 'ro', 'tempus', 'flatiron']],
  ['Education', ['university', 'college', 'school of', 'business school', 'institute of technology', 'academy', 'coursera', 'udemy', 'khan academy', 'duolingo', 'chegg']],
  ['Media', ['techcrunch', 'bloomberg', 'reuters', 'new york times', 'wall street journal', 'forbes', 'the information', 'axios', 'cnbc', 'bbc', 'cnn', 'vox', 'substack', 'medium']],
  ['Climate & energy', ['tesla energy', 'rivian', 'lucid', 'sunrun', 'enphase', 'northvolt', 'commonwealth fusion', 'helion', 'climeworks']],
  ['Commerce', ['walmart', 'target', 'instacart', 'doordash', 'shein', 'etsy', 'ebay', 'wayfair', 'faire']],
];

/**
 * Whole-word lookup of many names at once: the text is split into words and
 * every run of up to `maxWords` words is looked up, so the cost follows the
 * length of the text, not the number of names (a regex per name was most of
 * the time on a 30,000-person file). Returns the index of the first list
 * that holds a match, or -1. Words are runs of a-z and 0-9, as the old
 * whole-word regexes read them.
 */
const words = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
function wordIndex(lists) {
  const map = new Map();
  let maxWords = 1;
  lists.forEach((names, i) => names.forEach((name) => {
    const k = words(name).join(' ');
    if (!k) return;
    maxWords = Math.max(maxWords, k.split(' ').length);
    if (!map.has(k) || map.get(k) > i) map.set(k, i);
  }));
  return { map, maxWords };
}
function firstList(index, text) {
  const w = words(text);
  let best = -1;
  for (let i = 0; i < w.length; i += 1) {
    if (!w[i]) continue;
    let key = '';
    for (let n = 0; n < index.maxWords && i + n < w.length; n += 1) {
      key = n ? `${key} ${w[i + n]}` : w[i];
      const hit = index.map.get(key);
      if (hit !== undefined && (best < 0 || hit < best)) best = hit;
    }
  }
  return best;
}
const COMPANY_INDUSTRY_INDEX = wordIndex(COMPANY_INDUSTRY.map(([, names]) => names));

/**
 * Allocators: pension plans, endowments, family offices, wealth managers.
 * Checked right after the known employers so "Driftwood Wealth Management"
 * is not Fintech and an endowment is not a nonprofit.
 */
const ALLOCATOR_COMPANY = /(^|[^a-z0-9])(family office|endowment|pension( plan| fund)?|fund of funds|wealth management|wealth|asset management|investment management|investments? office|retirement system|superannuation|calpers|calstrs|ontario teachers|sovereign wealth)([^a-z0-9]|$)/i;
export const ASSET_MANAGEMENT = 'Asset management';

/** Title words that place someone in an industry regardless of employer. */
const TITLE_INDUSTRY = [
  ['Education', /\b(student|mba candidate|mba student|phd candidate|undergraduate|graduate student|teaching assistant|alumn)/i],
  ['Venture capital', /\b(venture capital|vc investor|venture partner|general partner|angel investor|scout)\b/i],
  ['Consulting', /\b(management consultant|consultant|consulting)\b/i],
];

/**
 * Words in a company's own name that give its sector away ("Acme Capital",
 * "Northside Health", "Orbit Labs"). Checked after the known employers.
 */
const COMPANY_WORD_INDUSTRY = [
  ['Venture capital', /\b(capital|ventures?|vc|angels?|seed fund|growth equity|private equity)\b/i],
  ['Finance & banking', /\b(bank|banking|financial|finance|insurance|assurance|asset management|wealth|securities|investments?|credit union|holdings)\b/i],
  // "pharma", not "pharmacy": a pharmacy chain is a shop.
  ['Healthcare', /\b(health\w*|medical|medicine|clinic\w*|hospital|pharma|pharmaceuticals?|bio\w*|therapeutics|genomics|care|dental|wellness)\b/i],
  ['Legal', /\b(law|legal|llp|attorneys?|solicitors)\b/i],
  ['Consulting', /\b(consulting|consultants?|advisors?|advisory|strategy group)\b/i],
  ['Education', /\b(university|college|school|academy|education|learning|institute)\b/i],
  ['Government & nonprofit', /\b(government|department of|ministry|federal|city of|state of|county|agency|foundation|nonprofit|non-profit|ngo|charity|association|council|united nations|world bank)\b/i],
  ['Media', /\b(media|news|studios?|entertainment|films?|pictures|records|publishing|press|broadcasting|radio|tv|magazine)\b/i],
  ['Climate & energy', /\b(energy|solar|power|climate|renewables?|utilities|oil|gas|petroleum|nuclear|fusion|battery)\b/i],
  ['Real estate', /\b(real estate|realty|properties|property|homes|housing|construction|architects?)\b/i],
  ['Commerce', /\b(retail\w*|foods?|restaurants?|hotels?|hospitality|consumer|brands?|apparel|fashion|beauty|grocery|groceries|grocers?|markets?|supermarkets?|shops?|stores?|department stores?|outfitters?|pharmacy|pharmacies|drugstores?|home goods|goods|outdoor|travel|mart)\b/i],
  ['Industrials', /\b(logistics|shipping|freight|airlines?|aviation|aerospace|automotive|motors|manufacturing|industries|industrial|robotics|steel|chemicals?|mining|defen[cs]e|space)\b/i],
  ['AI', /\b(ai|a\.i\.|machine learning|intelligence|neural|robot\w*)\b/i],
  ['Software', /\b(software|labs?|technolog\w+|tech|systems|cloud|data|digital|analytics|platform|apps?|io|cyber\w*|security|networks?|computing|solutions|interactive)\b/i],
];

/**
 * When the sector cannot be told from the employer, people are grouped by
 * what they do instead (read from the title), so nobody useful is lost in
 * "Other". Most specific first.
 */
const FUNCTION_GROUP = [
  ['Self-employed', null, /\b(self[- ]employed|freelance\w*|independent|sole proprietor|stealth)\b/i],
  ['Founders & CEOs', /\b(co-?founder|founder|founding|owner|ceo|chief executive|(?<!vice )president|entrepreneur)\b/i],
  ['Students', /\b(student|mba candidate|mba student|ph\.?d\.? (candidate|student)|undergraduate|graduate student|intern|trainee)\b/i],
  ['Investing', /\b(investor|investing|investment|partner|principal|venture|portfolio|fund|private (markets|equity))\b/i],
  ['Engineering & data', /\b(engineer\w*|develop\w*|programmer|software|architect|data|scientist|machine learning|ml|devops|sre|qa|technical|technology|cto|it)\b/i],
  ['Product & design', /\b(product|design\w*|ux|ui|creative|cpo)\b/i],
  // "marketing", not "markets": "Managing Director, Private Markets" invests.
  ['Sales & marketing', /\b(sales|account\w*|business development|bd|marketing|marketer|go-to-market|growth|partnerships?|customer|success|revenue|brand|communications|pr|cmo|cro)\b/i],
  ['People & talent', /\b(recruit\w*|talent|people|hr|human resources)\b/i],
  ['Legal & policy', /\b(lawyer|attorney|counsel|legal|policy|compliance|regulat\w*)\b/i],
  ['Finance & operations', /\b(finance|financial|accounting|accountant|controller|cfo|coo|operations|ops|strategy|chief of staff|supply chain|procurement|program|project|analyst|associate|manag\w*|director|head|vp|vice president|chief|executive|lead|administrator|coordinator|assistant|specialist)\b/i],
  ['Research & teaching', /\b(research\w*|professor|lecturer|teacher|scientist|faculty)\b/i],
];

const industryCache = new WeakMap();
/** Industry label for a contact from its title, company and tags; 'Other' when nothing matches. */
export function industryOf(contact) {
  if (!contact || typeof contact !== 'object') return OTHER_INDUSTRY;
  const hit = industryCache.get(contact);
  if (hit) return hit;
  const companyName = String(contact.company || '').toLowerCase().replace(/[^a-z0-9& ]+/g, ' ').replace(/&/g, ' ').replace(/\s+/g, ' ').trim();
  let out = OTHER_INDUSTRY;
  // 1. Known employer, 2. decisive title words, 3. sector words anywhere.
  if (companyName) {
    const i = firstList(COMPANY_INDUSTRY_INDEX, companyName);
    if (i >= 0) out = COMPANY_INDUSTRY[i][0];
  }
  if (out === OTHER_INDUSTRY && companyName && ALLOCATOR_COMPANY.test(companyName)) out = ASSET_MANAGEMENT;
  if (out === OTHER_INDUSTRY) for (const [label, re] of TITLE_INDUSTRY) if (re.test(String(contact.position || ''))) { out = label; break; }
  if (out !== OTHER_INDUSTRY) { industryCache.set(contact, out); return out; }
  const text = `${contact.position || ''} ${contact.company || ''} ${(contact.tags || []).join(' ')}`.replace(/\bOpenAI\b/gi, 'open ai').replace(/\b(\w+)AI\b/g, '$1 ai');
  if (!sectorIndex) { const groups = SECTOR_GROUPS(); sectorIndex = { groups, index: wordIndex(groups.map((g) => g.terms)) }; }
  const gi = firstList(sectorIndex.index, text);
  if (gi >= 0) out = INDUSTRY_LABEL[sectorIndex.groups[gi].label] || sectorIndex.groups[gi].label;
  // 4. Sector words in the company's own name, 5. what the person does.
  if (out === OTHER_INDUSTRY && companyName) for (const [label, re] of COMPANY_WORD_INDUSTRY) if (re.test(companyName)) { out = label; break; }
  if (out === OTHER_INDUSTRY) {
    const title = String(contact.position || '');
    for (const [label, titleRe, companyRe] of FUNCTION_GROUP) {
      if ((titleRe && titleRe.test(title)) || (companyRe && companyRe.test(companyName))) { out = label; break; }
    }
  }
  industryCache.set(contact, out);
  return out;
}

const COUNTRY_ALIASES = {
  us: 'United States', usa: 'United States', 'u.s.': 'United States', 'u.s.a.': 'United States', 'united states': 'United States', 'united states of america': 'United States',
  uk: 'United Kingdom', 'u.k.': 'United Kingdom', 'united kingdom': 'United Kingdom', england: 'United Kingdom', scotland: 'United Kingdom', wales: 'United Kingdom', 'great britain': 'United Kingdom',
  uae: 'United Arab Emirates', 'united arab emirates': 'United Arab Emirates', 'south korea': 'South Korea', korea: 'South Korea', 'republic of korea': 'South Korea',
  'hong kong sar': 'Hong Kong', 'the netherlands': 'Netherlands', holland: 'Netherlands', deutschland: 'Germany', schweiz: 'Switzerland', 'czech republic': 'Czechia',
};
const US_STATES = new Set(['al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy', 'dc',
  'california', 'new york', 'texas', 'florida', 'massachusetts', 'washington', 'illinois', 'colorado', 'georgia', 'pennsylvania', 'new jersey', 'virginia', 'north carolina', 'ohio', 'michigan', 'arizona', 'oregon', 'utah', 'minnesota', 'tennessee', 'maryland', 'connecticut', 'nevada', 'district of columbia']);
const US_CITIES = new Set(['san francisco', 'new york city', 'nyc', 'los angeles', 'boston', 'seattle', 'austin', 'chicago', 'miami', 'denver', 'palo alto', 'menlo park', 'mountain view', 'san jose', 'oakland', 'berkeley', 'san diego', 'atlanta', 'washington dc', 'bay area', 'san francisco bay area', 'silicon valley', 'greater boston', 'greater seattle area', 'new york city metropolitan area']);
const CITY_COUNTRY = {
  london: 'United Kingdom', paris: 'France', berlin: 'Germany', munich: 'Germany', amsterdam: 'Netherlands', dublin: 'Ireland', zurich: 'Switzerland', stockholm: 'Sweden',
  toronto: 'Canada', vancouver: 'Canada', montreal: 'Canada', singapore: 'Singapore', 'hong kong': 'Hong Kong', tokyo: 'Japan', sydney: 'Australia', melbourne: 'Australia',
  bangalore: 'India', bengaluru: 'India', mumbai: 'India', delhi: 'India', 'new delhi': 'India', 'tel aviv': 'Israel', dubai: 'United Arab Emirates', 'são paulo': 'Brazil', 'sao paulo': 'Brazil',
  'mexico city': 'Mexico', madrid: 'Spain', barcelona: 'Spain', lisbon: 'Portugal', milan: 'Italy', copenhagen: 'Denmark', oslo: 'Norway', helsinki: 'Finland', kathmandu: 'Nepal', shanghai: 'China', beijing: 'China', seoul: 'South Korea',
};

const tidy = (s) => String(s || '').trim().replace(/\s+/g, ' ');

const countryCache = new WeakMap();
/** Country for a contact from its location ("City, State, Country" or "City, Country"); 'Unknown' when absent. */
export function countryOf(contact) {
  if (!contact || typeof contact !== 'object') return UNKNOWN_COUNTRY;
  let hit = countryCache.get(contact);
  if (hit === undefined) { hit = byLocation(countryByLocation, contact.location, readCountry); countryCache.set(contact, hit); }
  return hit;
}

// Locations repeat a great deal ("New York, NY"), so each distinct string is
// read once. The maps are bounded so a huge file cannot grow them forever.
const countryByLocation = new Map();
const cityByLocation = new Map();
function byLocation(map, location, read) {
  const key = String(location || '');
  let v = map.get(key);
  if (v === undefined) {
    v = read({ location: key });
    if (map.size > 20000) map.clear();
    map.set(key, v);
  }
  return v;
}

function readCountry(contact) {
  const loc = tidy(contact?.location).replace(/\b(area|metropolitan area|metro area|greater)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (/\bbay\b/i.test(loc) && /san francisco|silicon valley/i.test(loc)) return 'United States';
  if (!loc) return UNKNOWN_COUNTRY;
  const parts = loc.split(',').map((p) => tidy(p)).filter(Boolean);
  const last = parts[parts.length - 1] || '';
  const key = last.toLowerCase().replace(/\.$/, '');
  if (COUNTRY_ALIASES[key]) return COUNTRY_ALIASES[key];
  if (US_STATES.has(key) || US_CITIES.has(key)) return 'United States';
  if (CITY_COUNTRY[key]) return CITY_COUNTRY[key];
  // "San Francisco, CA" style: a state in the middle also means the US.
  if (parts.some((p) => US_STATES.has(p.toLowerCase()) || US_CITIES.has(p.toLowerCase()))) return 'United States';
  for (const p of parts) if (CITY_COUNTRY[p.toLowerCase()]) return CITY_COUNTRY[p.toLowerCase()];
  // A proper-noun last part is most likely the country name itself.
  return /^[A-Z][A-Za-z .'-]{2,}$/.test(last) ? last : UNKNOWN_COUNTRY;
}

// ------------------------------------------------------------ sectors

const SECTOR_LABELS = new Set([
  ...COMPANY_INDUSTRY.map(([label]) => label),
  ...Object.values(INDUSTRY_LABEL),
  ...COMPANY_WORD_INDUSTRY.map(([label]) => label),
  ASSET_MANAGEMENT,
]);
/**
 * True when an industry label names a sector ("Healthcare", "Big Tech"),
 * false for the job-function fallbacks ("Investing", "Sales & marketing")
 * and for "Other": only sectors are offered as "in {sector}" shortcuts.
 */
export function isSector(label) {
  return SECTOR_LABELS.has(label);
}

// ------------------------------------------------------------ tags

const tagsCache = new WeakMap();
/**
 * The contact's tags, lower-cased and trimmed, without duplicates. X handles
 * ("@name") are identifiers, not tags, and are left out.
 */
export function tagsOf(contact) {
  if (!contact || typeof contact !== 'object') return [];
  const hit = tagsCache.get(contact);
  if (hit) return hit;
  const out = [];
  for (const t of Array.isArray(contact.tags) ? contact.tags : []) {
    const k = normTag(t);
    if (k && !k.startsWith('@') && !out.includes(k)) out.push(k);
  }
  tagsCache.set(contact, out);
  return out;
}

/** A tag trimmed with inner spaces collapsed (the regex only runs when needed). */
const tidyTag = (t) => {
  const s = String(t || '').trim();
  return /\s\s|[\t\n\r]/.test(s) ? s.replace(/\s+/g, ' ') : s;
};
const normTag = (t) => tidyTag(t).toLowerCase();

/** The commonest original spelling of each normalised tag. */
function tagSpellings(contacts) {
  const seen = new Map();
  for (const c of contacts || []) {
    for (const raw of Array.isArray(c?.tags) ? c.tags : []) {
      const label = tidyTag(raw);
      const k = label.toLowerCase();
      if (!k || k.startsWith('@')) continue;
      let m = seen.get(k);
      if (!m) { m = new Map(); seen.set(k, m); }
      m.set(label, (m.get(label) || 0) + 1);
    }
  }
  const out = new Map();
  for (const [k, m] of seen) {
    let best = k; let n = 0;
    for (const [label, c] of m) if (c > n || (c === n && label < best)) { best = label; n = c; }
    out.set(k, best);
  }
  return out;
}

/**
 * Whether the file's tags say something: tags are filled for 30% or more of
 * the people, and at least two tags each cover 5% to 80% of them (with at
 * least 3 people). Pipeline stages and fundraising stages do; X handles and
 * one-off notes do not. Returns { signal, filled, counts: [[tag, n]] largest
 * first, spelling: Map, multi } where multi is the share of tagged people
 * with more than one tag.
 */
const tagProfiles = new WeakMap();
export function tagProfile(contacts) {
  const list = contacts || [];
  // The same array is read several times while one file is profiled.
  const hit = tagProfiles.get(list);
  if (hit) return hit;
  const out = readTagProfile(list);
  tagProfiles.set(list, out);
  return out;
}

function readTagProfile(list) {
  const n = list.length;
  const counts = new Map();
  let filled = 0; let several = 0;
  for (const c of list) {
    const tags = tagsOf(c);
    if (!tags.length) continue;
    filled += 1;
    if (tags.length > 1) several += 1;
    for (const t of tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const useful = sorted.filter(([, k]) => k >= 3 && k >= n * 0.05 && k <= n * 0.8);
  const signal = n > 0 && filled >= n * 0.3 && useful.length >= 2;
  return { signal, filled, counts: sorted, useful, spelling: signal ? tagSpellings(list) : new Map(), multi: filled ? several / filled : 0 };
}

// ------------------------------------------------------------ places

const CITY_ALIASES = { nyc: 'New York', 'new york city': 'New York', sf: 'San Francisco', 'bay area': 'San Francisco', 'silicon valley': 'San Francisco', la: 'Los Angeles', dc: 'Washington', 'washington dc': 'Washington', 'washington d.c.': 'Washington' };

/**
 * The contact's city: the first comma part of the location, with "Greater
 * Boston Area" read as Boston and "San Francisco Bay Area" as San Francisco.
 * '' when there is no location.
 */
const cityCache = new WeakMap();
export function cityOf(contact) {
  if (!contact || typeof contact !== 'object') return '';
  let hit = cityCache.get(contact);
  if (hit === undefined) { hit = byLocation(cityByLocation, contact.location, readCity); cityCache.set(contact, hit); }
  return hit;
}

function readCity(contact) {
  let first = tidy(String(contact?.location || '').split(',')[0]);
  if (!first) return '';
  first = first.replace(/^greater\s+/i, '').replace(/\s+(bay area|metropolitan area|metro area|metroplex|area|region)$/i, '').trim();
  const alias = CITY_ALIASES[first.toLowerCase()];
  return alias || first;
}

/**
 * Which place level splits these contacts: 'country', or 'city' when one
 * country holds more than 60% of the located people or fewer than three
 * countries appear (a US-only CRM is split by city).
 */
export function placeLevel(contacts) {
  const counts = new Map();
  let known = 0;
  for (const c of contacts || []) {
    const k = countryOf(c);
    if (k === UNKNOWN_COUNTRY) continue;
    known += 1;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  if (!known) return 'country';
  const top = Math.max(...counts.values());
  return counts.size < 3 || top > known * 0.6 ? 'city' : 'country';
}

// ------------------------------------------------------------ buckets

/** Hub key for a contact under a grouping; null for 'company' (no hubs). */
export function groupKeyFor(contact, groupBy) {
  if (groupBy === 'role') return classifyContact(contact).group;
  if (groupBy === 'industry') return industryOf(contact);
  if (groupBy === 'country' || groupBy === 'place') return countryOf(contact);
  if (groupBy === 'city') return cityOf(contact) || UNKNOWN_COUNTRY;
  if (groupBy === 'tag') return tagsOf(contact)[0] || NO_TAG;
  return null;
}

export const MAX_HUBS = 16;

/** Largest first, the long tail and the catch-all bucket last. */
function rankedBuckets(list, keyOf, { tailKey, tailLabel, tailHint, labelOf = (k) => k, hint = '', extraTail = null }) {
  const byKey = new Map();
  for (const c of list) {
    const k = keyOf(c);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(c);
  }
  const named = [...byKey.entries()].filter(([k]) => k !== tailKey).sort((a, b) => b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0])));
  // Room for the catch-all (and, for tags, "Other tags") within MAX_HUBS.
  const keep = extraTail ? MAX_HUBS - 2 : MAX_HUBS - 1;
  const kept = named.slice(0, keep);
  const rest = named.slice(keep).flatMap(([, v]) => v);
  const out = kept.map(([k, v]) => ({ key: k, label: labelOf(k), hint, lens: null, contacts: v }));
  if (extraTail && rest.length) {
    out.push({ key: extraTail.key, label: extraTail.label, hint: extraTail.hint, lens: null, contacts: rest });
    const tail = byKey.get(tailKey) || [];
    if (tail.length) out.push({ key: tailKey, label: tailLabel, hint: tailHint, lens: null, contacts: tail });
    return out;
  }
  const tail = [...(byKey.get(tailKey) || []), ...rest];
  if (tail.length) out.push({ key: tailKey, label: tailLabel, hint: tailHint, lens: null, contacts: tail });
  return out;
}

/**
 * Buckets for a grouping: [{ key, label, hint, lens?, contacts }], ordered
 * for the map. Role groups keep their fixed order; industries, places and
 * tags are largest first with the long tail folded into 'Other' /
 * 'Unknown' / 'Other tags'. Place is the country, or the city when the
 * country would not split these people (see placeLevel). A tag bucket holds
 * the people whose first tag it is.
 */
export function bucketsFor(contacts, groupBy) {
  const list = contacts || [];
  if (groupBy === 'role') {
    // One pass over the people, not one per role group.
    const byGroup = new Map(ROLE_GROUPS.map((rg) => [rg.key, []]));
    for (const c of list) byGroup.get(classifyContact(c).group)?.push(c);
    return ROLE_GROUPS.map((rg) => ({ ...rg, contacts: byGroup.get(rg.key) })).filter((b) => b.contacts.length);
  }
  if (groupBy === 'industry') {
    return rankedBuckets(list, industryOf, { tailKey: OTHER_INDUSTRY, tailLabel: OTHER_INDUSTRY, tailHint: 'No sector word in the title or company', hint: 'From titles, company names and tags' });
  }
  if (groupBy === 'country' || groupBy === 'place' || groupBy === 'city') {
    const city = groupBy === 'city' || placeLevel(list) === 'city';
    return rankedBuckets(list, city ? (c) => cityOf(c) || UNKNOWN_COUNTRY : countryOf, { tailKey: UNKNOWN_COUNTRY, tailLabel: UNKNOWN_COUNTRY, tailHint: 'No location in the import (LinkedIn exports have none)', hint: 'From the location field' });
  }
  if (groupBy === 'tag') {
    // The tag profile of this same list already holds the spellings when tags carry signal.
    const known = tagProfile(list);
    const spelling = known.signal ? known.spelling : tagSpellings(list);
    return rankedBuckets(list, (c) => tagsOf(c)[0] || NO_TAG, {
      tailKey: NO_TAG, tailLabel: NO_TAG, tailHint: 'No tag in the import', hint: 'From the tags in the file',
      labelOf: (k) => spelling.get(k) || k, extraTail: { key: OTHER_TAGS, label: OTHER_TAGS, hint: 'Smaller tags' },
    });
  }
  return [{ key: null, label: '', hint: '', contacts: list }];
}

// ------------------------------------------------------------ which arrangements fit

const TAIL_KEYS = new Set([OTHER_INDUSTRY, UNKNOWN_COUNTRY, NO_TAG, OTHER_TAGS, 'other']);

/** True when the buckets split the people: two real groups of 5% or more each, and none over 90%. */
function splits(buckets, n) {
  if (!n) return false;
  const big = buckets.filter((b) => !TAIL_KEYS.has(b.key) && b.contacts.length >= n * 0.05).length;
  const largest = Math.max(0, ...buckets.map((b) => b.contacts.length));
  return big >= 2 && largest <= n * 0.9;
}

/**
 * The arrangements that split these contacts, in GROUPINGS order:
 * [{ key, label }]. An arrangement that would put (nearly) everyone in one
 * group, or leave nobody in groups of a useful size, is left out. By
 * company is offered when most people have a company, more than one
 * company appears and no company holds over 90%: companies are small, so
 * the 5% rule would hide it on almost every file.
 */
export function usefulGroupings(contacts) {
  const list = contacts || [];
  const n = list.length;
  const out = [];
  for (const g of GROUPINGS) {
    let ok = false;
    if (g.key === 'company') {
      const counts = new Map();
      let filled = 0;
      for (const c of list) {
        const k = companyKeyFor(c);
        if (!k) continue;
        filled += 1;
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      ok = n > 0 && filled >= n * 0.5 && counts.size >= 2 && Math.max(...counts.values()) <= n * 0.9;
    } else if (g.key === 'tag') {
      ok = tagProfile(list).signal && splits(bucketsFor(list, 'tag'), n);
    } else {
      ok = splits(bucketsFor(list, g.key), n);
    }
    if (ok) out.push({ key: g.key, label: g.label });
  }
  return out;
}

/**
 * The arrangement the map opens on: By tag when the tags carry signal and
 * most tagged people have exactly one tag (a pipeline or a fundraising
 * list), otherwise By role; when role does not split the file, the first
 * arrangement that does.
 */
export function defaultGrouping(contacts, useful = usefulGroupings(contacts)) {
  const keys = useful.map((g) => g.key);
  if (keys.includes('tag') && tagProfile(contacts).multi < 0.5) return 'tag';
  if (keys.includes('role')) return 'role';
  return keys[0] || 'role';
}
