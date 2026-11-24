/**
 * How the Network Map groups contacts into hubs: by role family (see
 * roles.js), by industry (read from the employer only), by place (country,
 * or city when one country holds most people) or by the user's own tags.
 * Deterministic, no model. Which arrangements a file is offered depends on
 * the file: one that does not split it is not offered.
 *
 * Every bucket is { key, label, hint, contacts, last? }. `last: true` marks
 * a group that holds what is left over or not known ("Other roles",
 * "Industry not known", "Place not known", "Other tags", "No tag"): the map
 * puts it on the far side and the list shows it last.
 */
import { classifyContact, familyByKey, LAW_FIRMS } from './roles';
import { KEYWORD_GROUPS } from './sectors';
import { normalizeCompanyKey, isPlaceholderCompany, isPlaceholderKey } from './parseContacts';

export { isPlaceholderCompany };

// The caches below are per contact object, with the field they were read
// from: a contact edited in place is read again.
const companyKeys = new WeakMap();
/**
 * The contact's company key: one key for every spelling of the company
 * (normalizeCompanyKey), '' when there is none or the cell is a placeholder
 * ("Self-employed", "Stealth", "N/A").
 */
export function companyKeyFor(contact) {
  if (!contact || typeof contact !== 'object') return '';
  const company = contact.company || '';
  const hit = companyKeys.get(contact);
  if (hit && hit.company === company) return hit.key;
  const raw = normalizeCompanyKey(company);
  const key = raw && !isPlaceholderKey(raw) ? raw : '';
  companyKeys.set(contact, { company, key });
  return key;
}

/**
 * The name to show for a company: the spelling most of these people use
 * ("McKinsey & Company" over "McKinsey"), ties broken alphabetically. ''
 * when nobody has a company.
 */
export function companyLabelFor(contacts) {
  const counts = new Map();
  for (const c of contacts || []) {
    if (!companyKeyFor(c)) continue;
    const name = String(c.company).trim().replace(/\s+/g, ' ');
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  let best = ''; let n = 0;
  for (const [name, k] of counts) if (k > n || (k === n && name < best)) { best = name; n = k; }
  return best;
}

// Mail services anyone can sign up to: their domain says nothing about an employer.
const WEBMAIL = new Set([
  'gmail', 'googlemail', 'yahoo', 'ymail', 'rocketmail', 'hotmail', 'outlook', 'live', 'msn', 'passport', 'aol', 'aim', 'icloud', 'me', 'mac',
  'proton', 'protonmail', 'pm', 'gmx', 'mail', 'email', 'inbox', 'zoho', 'zohomail', 'yandex', 'qq', '163', '126', 'sina', 'sohu', 'fastmail', 'hey',
  'tutanota', 'tuta', 'hushmail', 'comcast', 'verizon', 'att', 'sbcglobal', 'bellsouth', 'cox', 'charter', 'earthlink', 'optonline', 'web', 't-online',
  'orange', 'free', 'laposte', 'wanadoo', 'btinternet', 'sky', 'virginmedia', 'ntlworld', 'talktalk', 'libero', 'virgilio', 'rediffmail', 'naver',
  'hanmail', 'daum', 'seznam', 'wp', 'o2', 'interia', 'bigpond', 'optusnet', 'shaw', 'rogers', 'sympatico', 'telus', 'uol', 'bol', 'terra', 'skynet',
  'duck', 'mailbox', 'posteo', 'runbox', 'lycos', 'excite', 'juno', 'netzero', 'rambler', 'list', 'bk', 'ukr', 'abv',
]);

/**
 * A work email's domain, to stand in for the company when a file has none
 * ("ana@stripe.com" -> "stripe.com"). '' for a mail service anyone can use
 * (gmail.com, outlook.com...), a reserved example domain, or no email.
 */
export function companyFromEmail(contact) {
  const email = String(contact?.email || '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 1) return '';
  const host = email.slice(at + 1).replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return '';
  const parts = host.split('.');
  // The name a company registers: the last two labels, or three under a
  // country's own second level ("acme.co.uk", "acme.com.au").
  const tld = parts[parts.length - 1];
  const n = parts.length >= 3 && tld.length === 2 && /^(co|com|org|net|ac|gov|edu|ne|or|go|gob|nic)$/.test(parts[parts.length - 2]) ? 3 : 2;
  const domain = parts.slice(-n).join('.');
  if (WEBMAIL.has(parts[parts.length - n])) return '';
  if (/^example\.(com|org|net)$/.test(domain) || /^(test|example|invalid|localhost|local)$/.test(tld)) return '';
  return domain;
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
/** industryOf's answer when the employer says nothing; its group is "Industry not known". */
export const OTHER_INDUSTRY = 'Other';
export const INDUSTRY_NOT_KNOWN = 'Industry not known';
/** Industries past the largest ones under By industry share this group. */
export const OTHER_INDUSTRIES = '__other_industries__';
export const UNKNOWN_COUNTRY = 'Unknown';
export const PLACE_NOT_KNOWN = 'Place not known';
/** Places past the largest ones under By place share this group. */
export const OTHER_PLACES = '__other_places__';
export const NO_TAG = 'No tag';
export const OTHER_TAGS = 'Other tags';
/** The last group under By role: the families too small or too many to get their own. */
export const OTHER_ROLES = 'other-roles';

// Sector words read in a company's name. "Venture capital" terms
// ("partners", "fund") are too generic, and the words of old-style banking
// ("bank", "financial", "insurance", "wealth") name a bank, not a fintech:
// COMPANY_WORD_INDUSTRY files those under "Finance & banking".
// Drug makers ("Therapeutics", "Pharma") are Biotech, not care providers.
const NOT_FROM_COMPANY_NAME = new Set(['bank', 'banking', 'financial', 'finance', 'insurance', 'wealth', 'capital markets', 'trading', 'enterprise', 'platform', 'consumer', 'identity', 'token', 'learning']);
const NOT_HEALTHCARE = new Set(['therapeutics', 'pharma', 'biotech']);
const SECTOR_GROUPS = () => KEYWORD_GROUPS
  .filter((g) => g.label !== 'venture capital')
  .map((g) => ({ label: g.label, terms: g.terms.filter((t) => !NOT_FROM_COMPANY_NAME.has(t) && !(g.label === 'healthcare' && NOT_HEALTHCARE.has(t))) }));
let sectorIndex = null;

/**
 * A hospital, clinic or health system is Healthcare even when a university
 * runs it ("Acme University Hospital"): checked before the known employers,
 * whose Education list holds the word "university".
 */
const HEALTH_PROVIDER = /(^|[^a-z0-9])(hospitals?|medical cent(er|re)s?|medical group|health ?system|health ?care|health network|clinics?|infirmary|medical school|school of medicine|cancer cent(er|re))([^a-z0-9]|$)/;

/**
 * Well-known employers by industry. Checked before the words in a name, so
 * "Stripe" is Fintech and "Google" is Big Tech. Keys are matched against
 * the normalised company name (whole words).
 */
const COMPANY_INDUSTRY = [
  ['Big Tech', ['google', 'alphabet', 'meta', 'facebook', 'instagram', 'whatsapp', 'amazon', 'aws', 'microsoft', 'linkedin', 'apple', 'netflix', 'nvidia', 'intel', 'ibm', 'oracle', 'salesforce', 'adobe', 'cisco', 'samsung', 'tesla', 'uber', 'airbnb', 'x corp', 'twitter', 'bytedance', 'tiktok', 'tencent', 'alibaba', 'baidu', 'sony', 'qualcomm', 'amd', 'dell', 'hp']],
  ['AI', ['openai', 'anthropic', 'deepmind', 'google deepmind', 'mistral', 'cohere', 'hugging face', 'huggingface', 'scale ai', 'stability ai', 'perplexity', 'inflection', 'character ai', 'xai', 'runway', 'midjourney', 'databricks', 'anyscale', 'together ai', 'groq', 'cerebras', 'harvey', 'glean', 'cursor', 'anysphere', 'replit', 'adept', 'synthesia', 'elevenlabs', 'writer', 'jasper']],
  ['Fintech', ['stripe', 'ramp', 'brex', 'plaid', 'square', 'block', 'paypal', 'venmo', 'chime', 'robinhood', 'coinbase', 'affirm', 'klarna', 'revolut', 'wise', 'nubank', 'mercury', 'rippling', 'gusto', 'carta', 'adyen', 'checkout com', 'marqeta', 'sofi', 'monzo', 'n26', 'deel', 'remote']],
  ['Finance & banking', ['goldman sachs', 'goldman', 'morgan stanley', 'jpmorgan', 'jp morgan', 'chase', 'citi', 'citigroup', 'bank of america', 'wells fargo', 'blackrock', 'blackstone', 'kkr', 'carlyle', 'apollo', 'bridgewater', 'citadel', 'jane street', 'two sigma', 'fidelity', 'vanguard', 'ubs', 'barclays', 'hsbc', 'deutsche bank', 'credit suisse', 'lazard', 'evercore', 'moelis', 'jefferies', 'tpg', 'warburg pincus', 'bain capital', 'thoma bravo', 'vista equity', 'centerview', 'perella', 'houlihan lokey', 'piper sandler', 'raymond james', 'qatalyst', 'guggenheim', 'rothschild']],
  ['Venture capital', ['sequoia', 'sequoia capital', 'andreessen horowitz', 'a16z', 'y combinator', 'ycombinator', 'khosla', 'khosla ventures', 'accel', 'benchmark', 'greylock', 'kleiner perkins', 'lightspeed', 'index ventures', 'general catalyst', 'founders fund', 'insight partners', 'tiger global', 'coatue', 'gv', 'google ventures', 'nea', 'bessemer', 'first round', 'union square ventures', 'redpoint', 'ivp', 'battery ventures', 'techstars', '500 global', 'softbank', 'lux capital', 'thrive capital', 'craft ventures', 'initialized', 'felicis', 'spark capital', 'menlo ventures']],
  ['Consulting', ['mckinsey', 'mckinsey company', 'boston consulting group', 'bcg', 'bain', 'bain company', 'deloitte', 'pwc', 'pricewaterhousecoopers', 'ey', 'ernst young', 'kpmg', 'accenture', 'oliver wyman', 'kearney', 'roland berger', 'lek', 'alixpartners', 'booz allen']],
  ['Legal', LAW_FIRMS],
  ['Software', ['figma', 'notion', 'atlassian', 'slack', 'zoom', 'dropbox', 'shopify', 'hubspot', 'snowflake', 'datadog', 'mongodb', 'twilio', 'workday', 'servicenow', 'canva', 'airtable', 'asana', 'linear', 'vercel', 'github', 'gitlab', 'zapier', 'retool', 'webflow', 'miro', 'okta', 'cloudflare', 'palantir', 'confluent', 'hashicorp', 'elastic', 'intercom', 'loom', 'calendly']],
  ['Biotech', ['moderna', 'genentech', 'regeneron', 'vertex pharmaceuticals', 'biogen', 'amgen', 'gilead', 'illumina', '10x genomics', 'ginkgo bioworks', 'recursion', 'insitro']],
  ['Healthcare', ['kaiser', 'kaiser permanente', 'mayo clinic', 'cleveland clinic', 'mount sinai', 'nyu langone', 'unitedhealth', 'unitedhealthcare', 'cvs', 'pfizer', 'johnson johnson', 'merck', 'novartis', 'roche', 'oscar health', 'one medical', 'hims', 'ro', 'tempus', 'flatiron']],
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
export const VENTURE_CAPITAL = 'Venture capital';

/**
 * Words in a company's own name that give its sector away ("Acme Capital",
 * "Northside Health", "Orbit Labs"). Checked after the known employers.
 */
const COMPANY_WORD_INDUSTRY = [
  ['Venture capital', /\b(capital|ventures?|vc|angels?|seed fund|growth equity|private equity)\b/i],
  ['Finance & banking', /\b(bank|banking|bancorp|financial|finance|insurance|assurance|asset management|wealth|securities|investments?|credit union|holdings)\b/i],
  // "pharma", not "pharmacy": a pharmacy chain is a shop.
  ['Healthcare', /\b(health\w*|medical|medicine|clinic\w*|hospital|pharma|pharmaceuticals?|bio\w*|therapeutics|genomics|care|dental|wellness)\b/i],
  ['Legal', /\b(law|legal|llp|attorneys?|solicitors)\b/i],
  ['Consulting', /\b(consulting|consultants?|advisors?|advisory|strategy group)\b/i],
  ['Education', /\b(university|college|school|academy|education|learning|institute)\b/i],
  ['Government & nonprofit', /\b(government|department of|ministry|federal|city of|state of|county|agency|foundation|nonprofit|non-profit|ngo|charity|association|council|united nations|world bank)\b/i],
  ['Media', /\b(media|news|studios?|entertainment|films?|pictures|records|publishing|press|broadcasting|radio|tv|magazine)\b/i],
  ['Climate & energy', /\b(energy|solar|power|climate|renewables?|utilities|oil|gas|petroleum|nuclear|fusion|battery)\b/i],
  ['Real estate', /\b(real estate|realty|properties|property|homes|housing|construction|architects?)\b/i],
  ['Commerce', /\b(retail\w*|foods?|restaurants?|hotels?|hospitality|consumer|brands?|apparel|fashion|beauty|grocery|groceries|grocers?|markets?|supermarkets?|shops?|stores?|department stores?|outfitters?|pharmacy|pharmacies|drugstores?|home goods|goods|outdoor|travel|mart|supply|supplies|wholesale|distribution|distributors?)\b/i],
  ['Industrials', /\b(logistics|shipping|freight|airlines?|aviation|aerospace|automotive|motors|manufacturing|industries|industrial|robotics|steel|chemicals?|mining|defen[cs]e|space)\b/i],
  ['AI', /\b(ai|a\.i\.|machine learning|intelligence|neural|robot\w*)\b/i],
  ['Software', /\b(software|labs?|technolog\w+|tech|systems|cloud|data|digital|analytics|platform|apps?|io|cyber\w*|security|networks?|computing|solutions|interactive)\b/i],
];

const companyText = (company) => String(company || '').toLowerCase().replace(/[^a-z0-9& ]+/g, ' ').replace(/&/g, ' ').replace(/\s+/g, ' ').trim();

const industryCache = new WeakMap();
/**
 * Industry label for a contact, read from the employer only: its name,
 * the known-employer table and the words in the name ("Capital", "Health
 * System", "University"). The job title never sets a sector: a Software
 * Engineer at Acme is not "in Software", a Student is not "in Education".
 * The person's role is used only where the name says nothing more: someone
 * counted as an investor at "Orchard Group" works at an investment firm
 * (Venture capital, or Asset management for an allocator), and an allocator
 * at a foundation manages its money. OTHER_INDUSTRY ('Other') when the employer says
 * nothing; its group is "Industry not known".
 */
export function industryOf(contact) {
  if (!contact || typeof contact !== 'object') return OTHER_INDUSTRY;
  const company = String(contact.company || '');
  const kind = company ? classifyContact(contact) : null;
  const role = kind && kind.family === 'investors' ? kind.role : '';
  const hit = industryCache.get(contact);
  if (hit && hit.company === company && hit.role === role) return hit.out;
  // Many people share an employer: each (employer, role) is read once.
  const k = `${role}|${company}`;
  let out = industryByCompany.get(k);
  if (out === undefined) {
    out = readIndustry(company, role);
    if (industryByCompany.size > 20000) industryByCompany.clear();
    industryByCompany.set(k, out);
  }
  industryCache.set(contact, { company, role, out });
  return out;
}
const industryByCompany = new Map();

function readIndustry(company, investorRole) {
  const key = normalizeCompanyKey(company);
  const name = companyText(company);
  if (!name || !key || isPlaceholderKey(key)) return OTHER_INDUSTRY;
  // Every spelling of one employer gets one industry: the shared company key
  // ("jpmorgan" for "J.P. Morgan" and "JPMorgan Chase & Co.", "gv" for
  // "Google Ventures") is read first, and the name as written only when the
  // key says nothing ("Smith LLP" keeps its "LLP").
  const byKey = readIndustryName(key, key, investorRole);
  if (byKey !== OTHER_INDUSTRY) return byKey;
  // The name as written, when it says more than its key (same words: same answer).
  const byName = name === key ? OTHER_INDUSTRY : readIndustryName(name, company, investorRole);
  if (byName !== OTHER_INDUSTRY) return byName;
  // A name that says nothing, but its people invest: an investment firm.
  if (investorRole) return investorRole === 'lp' ? ASSET_MANAGEMENT : VENTURE_CAPITAL;
  return OTHER_INDUSTRY;
}

/** The industry a company's name gives (with an allocator's role for a foundation), or OTHER_INDUSTRY. */
function readIndustryName(name, company, investorRole) {
  // 1. A hospital, clinic or a university's medical arm, 2. a known employer, 3. an allocator.
  if (HEALTH_PROVIDER.test(name)) return 'Healthcare';
  if (/\b(university|college)\b/.test(name) && /\b(medicine|medical|health)\b/.test(name)) return 'Healthcare';
  const i = firstList(COMPANY_INDUSTRY_INDEX, name);
  if (i >= 0) return COMPANY_INDUSTRY[i][0];
  if (ALLOCATOR_COMPANY.test(name)) return ASSET_MANAGEMENT;
  // A foundation's or a trust's investment staff manage its money.
  if (investorRole === 'lp' && /\b(foundation|trust|endowment)\b/.test(name)) return ASSET_MANAGEMENT;
  // 4. Sector words in the name ("Alder Payments"), 5. other words in it.
  const text = company.replace(/\bOpenAI\b/gi, 'open ai').replace(/\b(\w+)AI\b/g, '$1 ai');
  if (!sectorIndex) { const groups = SECTOR_GROUPS(); sectorIndex = { groups, index: wordIndex(groups.map((g) => g.terms)) }; }
  const gi = firstList(sectorIndex.index, text);
  if (gi >= 0) return INDUSTRY_LABEL[sectorIndex.groups[gi].label] || sectorIndex.groups[gi].label;
  for (const [label, re] of COMPANY_WORD_INDUSTRY) if (re.test(name)) return label;
  // 6. "Juniper Partners" with nothing else in the name is an investment
  // firm, for everyone who works there.
  if (/^\w+( \w+)? partners$/.test(name)) return VENTURE_CAPITAL;
  return OTHER_INDUSTRY;
}

// ------------------------------------------------------------ places

const COUNTRY_ALIASES = {
  us: 'United States', usa: 'United States', 'u s': 'United States', 'u s a': 'United States', 'united states': 'United States', 'united states of america': 'United States', america: 'United States',
  uk: 'United Kingdom', 'u k': 'United Kingdom', 'united kingdom': 'United Kingdom', england: 'United Kingdom', scotland: 'United Kingdom', wales: 'United Kingdom', 'northern ireland': 'United Kingdom', 'great britain': 'United Kingdom', britain: 'United Kingdom', gb: 'United Kingdom',
  uae: 'United Arab Emirates', 'united arab emirates': 'United Arab Emirates', 'south korea': 'South Korea', korea: 'South Korea', 'republic of korea': 'South Korea',
  'hong kong sar': 'Hong Kong', 'the netherlands': 'Netherlands', holland: 'Netherlands', deutschland: 'Germany', schweiz: 'Switzerland', suisse: 'Switzerland', 'czech republic': 'Czechia',
  espana: 'Spain', españa: 'Spain', italia: 'Italy', brasil: 'Brazil', 'méxico': 'Mexico', prc: 'China', 'mainland china': 'China', 'russian federation': 'Russia', 'viet nam': 'Vietnam', türkiye: 'Turkey', turkiye: 'Turkey',
};
// Country names as written in English, so a location that ends in one is
// read as that country and anything else is not taken for a country.
const COUNTRIES = [
  'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Argentina', 'Armenia', 'Australia', 'Austria', 'Azerbaijan', 'Bahamas', 'Bahrain', 'Bangladesh', 'Barbados',
  'Belarus', 'Belgium', 'Belize', 'Benin', 'Bermuda', 'Bhutan', 'Bolivia', 'Bosnia and Herzegovina', 'Botswana', 'Brazil', 'Brunei', 'Bulgaria', 'Burkina Faso', 'Cambodia',
  'Cameroon', 'Canada', 'Cayman Islands', 'Chile', 'China', 'Colombia', 'Costa Rica', 'Croatia', 'Cuba', 'Cyprus', 'Czechia', 'Denmark', 'Dominican Republic', 'Ecuador',
  'Egypt', 'El Salvador', 'Estonia', 'Ethiopia', 'Fiji', 'Finland', 'France', 'Georgia', 'Germany', 'Ghana', 'Greece', 'Guatemala', 'Honduras', 'Hong Kong', 'Hungary',
  'Iceland', 'India', 'Indonesia', 'Iran', 'Iraq', 'Ireland', 'Israel', 'Italy', 'Ivory Coast', 'Jamaica', 'Japan', 'Jordan', 'Kazakhstan', 'Kenya', 'Kosovo', 'Kuwait',
  'Kyrgyzstan', 'Laos', 'Latvia', 'Lebanon', 'Libya', 'Liechtenstein', 'Lithuania', 'Luxembourg', 'Macau', 'Madagascar', 'Malawi', 'Malaysia', 'Maldives', 'Mali', 'Malta',
  'Mauritius', 'Mexico', 'Moldova', 'Monaco', 'Mongolia', 'Montenegro', 'Morocco', 'Mozambique', 'Myanmar', 'Namibia', 'Nepal', 'Netherlands', 'New Zealand', 'Nicaragua',
  'Nigeria', 'North Macedonia', 'Norway', 'Oman', 'Pakistan', 'Palestine', 'Panama', 'Paraguay', 'Peru', 'Philippines', 'Poland', 'Portugal', 'Puerto Rico', 'Qatar',
  'Romania', 'Russia', 'Rwanda', 'Saudi Arabia', 'Senegal', 'Serbia', 'Singapore', 'Slovakia', 'Slovenia', 'South Africa', 'South Korea', 'Spain', 'Sri Lanka', 'Sudan',
  'Sweden', 'Switzerland', 'Syria', 'Taiwan', 'Tajikistan', 'Tanzania', 'Thailand', 'Trinidad and Tobago', 'Tunisia', 'Turkey', 'Uganda', 'Ukraine', 'United Arab Emirates',
  'United Kingdom', 'United States', 'Uruguay', 'Uzbekistan', 'Venezuela', 'Vietnam', 'Yemen', 'Zambia', 'Zimbabwe',
];
const COUNTRY_BY_NAME = new Map([...COUNTRIES.map((c) => [c.toLowerCase(), c]), ...Object.entries(COUNTRY_ALIASES)]);
const US_STATES = new Set(['al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy', 'dc',
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas',
  'georgia', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire',
  'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota',
  'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming', 'district of columbia']);
// US cities and the metro names LinkedIn uses for them ("Greater Houston",
// "Dallas-Fort Worth Metroplex"), read after the "Greater" and "Area" words go.
const US_CITIES = new Set(['san francisco', 'new york', 'new york city', 'nyc', 'los angeles', 'boston', 'seattle', 'austin', 'chicago', 'miami', 'denver', 'palo alto',
  'menlo park', 'mountain view', 'san jose', 'oakland', 'berkeley', 'san diego', 'atlanta', 'washington dc', 'washington d c', 'silicon valley', 'houston', 'philadelphia',
  'dallas', 'fort worth', 'fort lauderdale', 'baltimore', 'salt lake city', 'phoenix', 'detroit', 'minneapolis', 'st paul', 'saint paul', 'st louis', 'saint louis',
  'pittsburgh', 'charlotte', 'raleigh', 'durham', 'raleigh durham', 'nashville', 'portland', 'sacramento', 'las vegas', 'orlando', 'tampa', 'kansas city', 'columbus',
  'indianapolis', 'cleveland', 'cincinnati', 'milwaukee', 'new orleans', 'san antonio', 'boulder', 'ann arbor', 'providence', 'hartford', 'richmond', 'buffalo',
  'albany', 'honolulu', 'anchorage', 'jacksonville', 'memphis', 'louisville', 'oklahoma city', 'tucson', 'albuquerque', 'el paso', 'omaha', 'des moines', 'madison',
  'boise', 'spokane', 'santa clara', 'sunnyvale', 'cupertino', 'redwood city', 'santa monica', 'irvine', 'pasadena', 'cambridge ma', 'somerville', 'brooklyn',
  'manhattan', 'queens', 'bronx', 'staten island', 'jersey city', 'hoboken', 'stamford', 'greenwich', 'princeton', 'new haven', 'scottsdale', 'tempe', 'plano',
  'irving', 'round rock', 'bellevue', 'redmond', 'kirkland', 'research triangle', 'tri state', 'tristate']);
const CITY_COUNTRY = {
  london: 'United Kingdom', manchester: 'United Kingdom', edinburgh: 'United Kingdom', glasgow: 'United Kingdom', bristol: 'United Kingdom', oxford: 'United Kingdom',
  paris: 'France', lyon: 'France', berlin: 'Germany', munich: 'Germany', hamburg: 'Germany', frankfurt: 'Germany', amsterdam: 'Netherlands', rotterdam: 'Netherlands',
  dublin: 'Ireland', zurich: 'Switzerland', geneva: 'Switzerland', stockholm: 'Sweden', brussels: 'Belgium', vienna: 'Austria', prague: 'Czechia', warsaw: 'Poland',
  toronto: 'Canada', vancouver: 'Canada', montreal: 'Canada', calgary: 'Canada', ottawa: 'Canada', waterloo: 'Canada', singapore: 'Singapore', 'hong kong': 'Hong Kong',
  tokyo: 'Japan', osaka: 'Japan', sydney: 'Australia', melbourne: 'Australia', brisbane: 'Australia', perth: 'Australia', auckland: 'New Zealand',
  bangalore: 'India', bengaluru: 'India', mumbai: 'India', delhi: 'India', 'new delhi': 'India', hyderabad: 'India', pune: 'India', chennai: 'India', gurgaon: 'India', gurugram: 'India', noida: 'India',
  'tel aviv': 'Israel', jerusalem: 'Israel', dubai: 'United Arab Emirates', 'abu dhabi': 'United Arab Emirates', riyadh: 'Saudi Arabia', doha: 'Qatar',
  'são paulo': 'Brazil', 'sao paulo': 'Brazil', 'rio de janeiro': 'Brazil', 'buenos aires': 'Argentina', santiago: 'Chile', bogota: 'Colombia', 'bogotá': 'Colombia', lima: 'Peru',
  'mexico city': 'Mexico', madrid: 'Spain', barcelona: 'Spain', lisbon: 'Portugal', milan: 'Italy', rome: 'Italy', copenhagen: 'Denmark', oslo: 'Norway', helsinki: 'Finland',
  kathmandu: 'Nepal', shanghai: 'China', beijing: 'China', shenzhen: 'China', seoul: 'South Korea', taipei: 'Taiwan', jakarta: 'Indonesia', manila: 'Philippines',
  'kuala lumpur': 'Malaysia', bangkok: 'Thailand', 'ho chi minh city': 'Vietnam', hanoi: 'Vietnam', lagos: 'Nigeria', nairobi: 'Kenya', 'cape town': 'South Africa',
  johannesburg: 'South Africa', cairo: 'Egypt', istanbul: 'Turkey', athens: 'Greece', budapest: 'Hungary', tallinn: 'Estonia', karachi: 'Pakistan', lahore: 'Pakistan', dhaka: 'Bangladesh',
};
// How a city is written when people write it differently ("NYC", "Bay
// Area", "Brooklyn"). Read before and after the metro words are taken off.
const CITY_ALIASES = {
  nyc: 'New York', 'new york city': 'New York', manhattan: 'New York', brooklyn: 'New York', queens: 'New York', bronx: 'New York', 'the bronx': 'New York', 'staten island': 'New York',
  sf: 'San Francisco', 'bay area': 'San Francisco', 'sf bay area': 'San Francisco', 'san francisco bay': 'San Francisco', 'silicon valley': 'San Francisco',
  la: 'Los Angeles', dc: 'Washington', 'washington dc': 'Washington', 'washington d c': 'Washington', 'washington d.c.': 'Washington', 'washington d.c': 'Washington',
  bengaluru: 'Bangalore', gurugram: 'Gurgaon', 'st paul': 'Minneapolis', 'saint paul': 'Minneapolis', 'minneapolis st paul': 'Minneapolis',
  'raleigh durham': 'Raleigh', 'research triangle': 'Raleigh',
};
// Words that say nothing about where: a remote worker is not in a country.
const NOWHERE = /^(remote|remote first|fully remote|anywhere|worldwide|global|international|earth|online|virtual|distributed|various|multiple|n a|na|none|unknown|tbd|other|location|planet earth|everywhere|nomad|digital nomad)$/;

const tidy = (s) => String(s || '').trim().replace(/\s+/g, ' ');
const lowerKey = (s) => tidy(s).toLowerCase().replace(/\.+$/, '').replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
const titleCase = (s) => s.replace(/(^|[\s-])([a-z])/g, (m, a, b) => a + b.toUpperCase());

/**
 * A metro or city string as one city: "Greater Houston" -> Houston,
 * "Miami-Fort Lauderdale Area" -> Miami, "Bay Area" -> San Francisco,
 * "Brooklyn" -> New York. '' for words that name no place ("Remote").
 */
function cityName(part) {
  let raw = tidy(part);
  if (!raw) return '';
  let k = lowerKey(raw);
  if (NOWHERE.test(k)) return '';
  if (CITY_ALIASES[k]) return CITY_ALIASES[k];
  const stripped = raw.replace(/^greater\s+/i, '').replace(/\s+(bay area|metropolitan area|metro area|metroplex|metro|area|region|urban|rural|city area)$/i, '').trim();
  if (stripped && stripped !== raw) { raw = stripped; k = lowerKey(raw); if (CITY_ALIASES[k]) return CITY_ALIASES[k]; }
  // "Miami-Fort Lauderdale", "Washington DC-Baltimore": the first city names the metro.
  const pair = raw.split(/\s*[-–—\/]\s*/);
  if (pair.length > 1) {
    const a = lowerKey(pair[0]);
    if (CITY_ALIASES[a]) return CITY_ALIASES[a];
    if (US_CITIES.has(a) || CITY_COUNTRY[a]) return tidy(pair[0]);
  }
  return /^[a-z]/.test(raw) ? titleCase(raw) : raw;
}

/** { city, country } for a location string; each distinct string is read once (see placeFor). */
function readPlace(location) {
  const loc = tidy(location);
  if (!loc) return { city: '', country: UNKNOWN_COUNTRY };
  const parts = loc.split(',').map((p) => tidy(p)).filter(Boolean);
  const keys = parts.map(lowerKey);
  let city = cityName(parts[0] || '');
  const cityKey = lowerKey(city);
  // A location that is only a country or a US state names no city.
  // Singapore and Hong Kong are both.
  if ((COUNTRY_BY_NAME.has(keys[0]) && !CITY_COUNTRY[keys[0]]) || (keys[0].length > 2 && US_STATES.has(keys[0]) && keys[0] !== 'new york' && keys[0] !== 'washington')) city = '';
  let country = UNKNOWN_COUNTRY;
  const last = keys[keys.length - 1] || '';
  // "Atlanta, Georgia": a state name after a US city is the state, not the country.
  if (COUNTRY_BY_NAME.has(last) && US_STATES.has(last) && keys.length > 1 && (US_CITIES.has(keys[0]) || US_CITIES.has(cityKey))) country = 'United States';
  else if (COUNTRY_BY_NAME.has(last)) country = COUNTRY_BY_NAME.get(last);
  else if (US_STATES.has(last) || US_CITIES.has(last)) country = 'United States';
  else if (CITY_COUNTRY[last]) country = CITY_COUNTRY[last];
  else if (keys.some((p) => US_STATES.has(p) || US_CITIES.has(p))) country = 'United States';
  else if (US_CITIES.has(cityKey) || ['new york', 'san francisco', 'los angeles', 'washington', 'minneapolis', 'raleigh'].includes(cityKey)) country = 'United States';
  else if (CITY_COUNTRY[cityKey]) country = CITY_COUNTRY[cityKey];
  else {
    for (const p of keys) if (CITY_COUNTRY[p]) { country = CITY_COUNTRY[p]; break; }
  }
  if (!city && country === UNKNOWN_COUNTRY && parts.length > 1) city = cityName(parts[1]);
  // One word the code does not know as a city or a country ("Hybrid", "EMEA",
  // "On the road") names no place.
  if (parts.length === 1 && country === UNKNOWN_COUNTRY) city = '';
  return { city, country };
}

// Locations repeat a great deal ("New York, NY"), so each distinct string is
// read once. The map is bounded so a huge file cannot grow it forever.
const placeByLocation = new Map();
function placeFor(location) {
  const key = String(location || '');
  let v = placeByLocation.get(key);
  if (v === undefined) {
    v = readPlace(key);
    if (placeByLocation.size > 20000) placeByLocation.clear();
    placeByLocation.set(key, v);
  }
  return v;
}

/**
 * Country for a contact from its location ("City, State, Country", "City,
 * Country", a LinkedIn metro such as "Greater Houston"); 'Unknown' when
 * absent, remote, or not recognised. Never guessed from a word it does not know.
 */
export function countryOf(contact) {
  if (!contact || typeof contact !== 'object') return UNKNOWN_COUNTRY;
  return placeFor(contact.location).country;
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
 * false for "Other" (not known) and anything else: only sectors are offered
 * as "in {sector}" shortcuts and in "Strongest in".
 */
export function isSector(label) {
  return label !== OTHER_INDUSTRY && SECTOR_LABELS.has(label);
}

// ------------------------------------------------------------ tags

/**
 * A tag is a short label that sorts people into piles ("prospect", "met
 * 2026", "decision maker"): at most four words and forty characters. A
 * longer value is a note ("met at SaaStr, follow up re: pilot") and is not
 * counted as a tag anywhere. X handles ("@name") are identifiers, not tags.
 */
const isTagValue = (k) => !!k && !k.startsWith('@') && k.length <= 40 && k.split(' ').length <= 4;

const tagsCache = new WeakMap();
/** The contact's tags, lower-cased and trimmed, without duplicates (see isTagValue). */
export function tagsOf(contact) {
  if (!contact || typeof contact !== 'object') return [];
  const raw = Array.isArray(contact.tags) ? contact.tags : [];
  const hit = tagsCache.get(contact);
  // The same array with the same length: tags are only ever added or replaced.
  if (hit && hit.raw === raw && hit.n === raw.length) return hit.out;
  const out = [];
  for (const t of raw) {
    const k = normTag(t);
    if (isTagValue(k) && !out.includes(k)) out.push(k);
  }
  tagsCache.set(contact, { raw, n: raw.length, out });
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
      if (!isTagValue(k)) continue;
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
 * notes do not. Returns { signal, filled, counts: [[tag, n]] largest first,
 * useful, spelling: Map, multi } where multi is the share of tagged people
 * with more than one tag.
 */
const tagProfiles = new WeakMap();
export function tagProfile(contacts) {
  const list = contacts || [];
  // The same array is read several times while one file is profiled; an
  // array that has grown since is read again.
  const hit = tagProfiles.get(list);
  if (hit && hit.n === list.length) return hit.out;
  const out = readTagProfile(list);
  tagProfiles.set(list, { n: list.length, out });
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

/**
 * The contact's city: the first part of the location, with LinkedIn's metro
 * names read as the city ("Greater Houston" -> Houston, "Bay Area" -> San
 * Francisco, "Dallas-Fort Worth Metroplex" -> Dallas, "Brooklyn, NY" -> New
 * York). '' when there is no location, or it names no city ("Remote",
 * "United States").
 */
export function cityOf(contact) {
  if (!contact || typeof contact !== 'object') return '';
  return placeFor(contact.location).city;
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
  if (groupBy === 'role' || groupBy === 'family') return classifyContact(contact).family;
  if (groupBy === 'industry') return industryOf(contact);
  if (groupBy === 'country' || groupBy === 'place') return countryOf(contact);
  if (groupBy === 'city') return cityOf(contact) || UNKNOWN_COUNTRY;
  if (groupBy === 'tag') return tagsOf(contact)[0] || NO_TAG;
  return null;
}

export const MAX_HUBS = 16;
/** By role shows at most this many families; the rest share "Other roles". */
export const MAX_FAMILY_GROUPS = 8;

/**
 * Largest first. Past MAX_HUBS the smaller groups share `overflow` ("Other
 * industries"); the people the reader could not place go in `unknown`
 * ("Industry not known"). Both are marked last and come last, the unknown
 * group at the very end; they are never mixed.
 */
function rankedBuckets(list, keyOf, { unknown, overflow, labelOf = (k) => k, hint = '' }) {
  const byKey = new Map();
  for (const c of list) {
    const k = keyOf(c);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(c);
  }
  const named = [...byKey.entries()].filter(([k]) => k !== unknown.key).sort((a, b) => b[1].length - a[1].length || String(a[0]).localeCompare(String(b[0])));
  const tail = byKey.get(unknown.key) || [];
  // Room for the two last groups within MAX_HUBS.
  const room = MAX_HUBS - (tail.length ? 1 : 0);
  const keep = named.length > room ? room - 1 : named.length;
  const out = named.slice(0, keep).map(([k, v]) => ({ key: k, label: labelOf(k), hint, lens: null, contacts: v }));
  const rest = named.slice(keep);
  if (rest.length) {
    out.push({
      key: overflow.key, label: overflow.label, hint: overflow.hint, lens: null, last: true, contacts: rest.flatMap(([, v]) => v),
      buckets: rest.map(([k, v]) => ({ key: k, label: labelOf(k), hint, lens: null, contacts: v })),
    });
  }
  if (tail.length) out.push({ key: unknown.key, label: unknown.label, hint: unknown.hint, lens: null, last: true, contacts: tail });
  return out;
}

const fmt = (n) => Number(n || 0).toLocaleString('en-US');

/**
 * The file's own role families as groups (ROUND2 R2): largest first, at
 * most eight, then one last group "Other roles" holding the families past
 * the eighth and any under 3% of these people, each as its own bucket. The
 * catch-alls ("Other senior leaders", "Other roles", "No title") only get a
 * place of their own when fewer than three other families do, and then come
 * after them, marked last.
 */
function familyBuckets(list) {
  const n = list.length;
  const byFamily = new Map();
  for (const c of list) {
    const k = classifyContact(c).family;
    if (!byFamily.has(k)) byFamily.set(k, []);
    byFamily.get(k).push(c);
  }
  const fams = [...byFamily.entries()]
    .map(([key, contacts]) => ({ fam: familyByKey(key) || familyByKey('others'), contacts }))
    .sort((a, b) => b.contacts.length - a.contacts.length || a.fam.key.localeCompare(b.fam.key));
  const bigEnough = (f) => f.contacts.length >= n * 0.03;
  let placed = fams.filter((f) => !f.fam.catchAll && bigEnough(f)).slice(0, MAX_FAMILY_GROUPS);
  if (placed.length < 3) {
    const catchAll = fams.filter((f) => f.fam.catchAll && bigEnough(f));
    placed = [...placed, ...catchAll].slice(0, MAX_FAMILY_GROUPS);
  }
  const inPlace = new Set(placed.map((f) => f.fam.key));
  const bucket = (f) => ({
    key: f.fam.key, label: f.fam.title, family: f.fam.key, hint: 'From job titles', lens: null, contacts: f.contacts,
    ...(f.fam.catchAll ? { last: true } : {}),
  });
  const out = placed.map(bucket);
  const folded = fams.filter((f) => !inPlace.has(f.fam.key));
  if (folded.length) {
    const contacts = folded.flatMap((f) => f.contacts);
    out.push({
      key: OTHER_ROLES, label: 'Other roles', last: true, lens: null, contacts,
      hint: folded.slice(0, 4).map((f) => `${f.fam.title} ${fmt(f.contacts.length)}`).join(' · ') + (folded.length > 4 ? ' · …' : ''),
      buckets: folded.map(bucket),
    });
  }
  return out;
}

/**
 * Buckets for a grouping: [{ key, label, hint, contacts, last?, buckets? }],
 * ordered for the map.
 *   'role' / 'family'  the file's role families (familyBuckets)
 *   'industry'         industries largest first; "Other industries", then
 *                      "Industry not known" last
 *   'country' / 'place' / 'city'  the country, or the city when the country
 *                      would not split these people (see placeLevel);
 *                      "Other places", then "Place not known" last
 *   'tag'              the people whose first tag it is (`tagged`: everyone
 *                      who carries it); "Other tags", then "No tag" last
 * A bucket that folds several groups ("Other roles", "Other industries",
 * "Other places") lists them in `buckets`.
 */
export function bucketsFor(contacts, groupBy) {
  const list = contacts || [];
  if (groupBy === 'role' || groupBy === 'family') return familyBuckets(list);
  if (groupBy === 'industry') {
    return rankedBuckets(list, industryOf, {
      unknown: { key: OTHER_INDUSTRY, label: INDUSTRY_NOT_KNOWN, hint: 'The company name does not say' },
      overflow: { key: OTHER_INDUSTRIES, label: 'Other industries', hint: 'Smaller industries' },
      hint: 'From company names',
    });
  }
  if (groupBy === 'country' || groupBy === 'place' || groupBy === 'city') {
    const city = groupBy === 'city' || placeLevel(list) === 'city';
    return rankedBuckets(list, city ? (c) => cityOf(c) || UNKNOWN_COUNTRY : countryOf, {
      unknown: { key: UNKNOWN_COUNTRY, label: PLACE_NOT_KNOWN, hint: 'No location, or one that names no place' },
      overflow: { key: OTHER_PLACES, label: 'Other places', hint: 'Smaller places' },
      hint: 'From the location field',
    });
  }
  if (groupBy === 'tag') {
    // The tag profile of this same list already holds the spellings when tags carry signal.
    const known = tagProfile(list);
    const spelling = known.signal ? known.spelling : tagSpellings(list);
    const carriers = new Map(known.counts);
    const out = rankedBuckets(list, (c) => tagsOf(c)[0] || NO_TAG, {
      unknown: { key: NO_TAG, label: NO_TAG, hint: 'No tag in the import' },
      overflow: { key: OTHER_TAGS, label: OTHER_TAGS, hint: 'Smaller tags' },
      labelOf: (k) => spelling.get(k) || k, hint: 'From the tags in the file',
    });
    // A tag the shortcuts or the read-out name gets a group of its own even
    // when everyone carrying it sits under another of their tags
    // ("customer; champion"): the group holds no one of its own and its
    // count is everyone with the tag, as on the shortcut.
    if (known.signal) {
      const has = new Set();
      for (const b of out) { has.add(b.key); for (const inner of b.buckets || []) has.add(inner.key); }
      const missing = known.useful.slice(0, 8).filter(([t]) => !has.has(t))
        .map(([t]) => ({ key: t, label: spelling.get(t) || t, hint: 'From the tags in the file', lens: null, contacts: [] }));
      if (missing.length) {
        const at = out.findIndex((b) => b.last);
        out.splice(at < 0 ? out.length : at, 0, ...missing);
      }
    }
    for (const b of out) if (!b.last) b.tagged = carriers.get(b.key) || b.contacts.length;
    return out;
  }
  return [{ key: null, label: '', hint: '', contacts: list }];
}

// ------------------------------------------------------------ which arrangements fit

/** True when the buckets split the people: two real groups of 5% or more each, and none over 90%. */
function splits(buckets, n) {
  if (!n) return false;
  const big = buckets.filter((b) => !b.last && b.contacts.length >= n * 0.05).length;
  const largest = Math.max(0, ...buckets.map((b) => b.contacts.length));
  return big >= 2 && largest <= n * 0.9;
}

/**
 * The arrangements that split these contacts, in GROUPINGS order:
 * [{ key, label }]. An arrangement that would put (nearly) everyone in one
 * group, or leave nobody in groups of a useful size, is left out: By role
 * needs two families of 5% or more and none over 90%, By industry the same
 * of industries that are known. By company is offered when most people
 * have a company, more than one company appears and no company holds over
 * 90%: companies are small, so the 5% rule would hide it on almost every file.
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
 * arrangement that does; null when none does (a file of names only is
 * shown ungrouped, not by a facet it does not have).
 */
export function defaultGrouping(contacts, useful = usefulGroupings(contacts)) {
  const keys = useful.map((g) => g.key);
  if (keys.includes('tag') && tagProfile(contacts).multi < 0.5) return 'tag';
  if (keys.includes('role')) return 'role';
  return keys[0] || null;
}
