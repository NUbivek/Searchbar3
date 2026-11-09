/**
 * How the Network Map groups contacts into hubs: by role (see roles.js),
 * by industry (sector vocabulary over title, company and tags) or by
 * country (parsed from the location field). Deterministic, no model.
 */
import { classifyContact, ROLE_GROUPS } from './roles';
import { KEYWORD_GROUPS } from './sectors';

export const GROUPINGS = [
  { key: 'role', label: 'By role' },
  { key: 'company', label: 'By company' },
  { key: 'industry', label: 'By industry' },
  { key: 'country', label: 'By country' },
];

const INDUSTRY_LABEL = {
  fintech: 'Fintech', healthcare: 'Healthcare', ai: 'AI', crypto: 'Crypto', saas: 'Software', climate: 'Climate & energy',
  education: 'Education', security: 'Security', gaming: 'Gaming', ecommerce: 'Commerce', biotech: 'Biotech', 'real estate': 'Real estate',
  media: 'Media', 'venture capital': 'Venture capital',
};
export const OTHER_INDUSTRY = 'Other';
export const UNKNOWN_COUNTRY = 'Unknown';

const wordRes = new Map();
const wordRe = (term) => {
  let re = wordRes.get(term);
  if (!re) { re = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i'); wordRes.set(term, re); }
  return re;
};

const industryCache = new WeakMap();
/** Industry label for a contact from its title, company and tags; 'Other' when nothing matches. */
export function industryOf(contact) {
  if (!contact || typeof contact !== 'object') return OTHER_INDUSTRY;
  const hit = industryCache.get(contact);
  if (hit) return hit;
  const text = `${contact.position || ''} ${contact.company || ''} ${(contact.tags || []).join(' ')}`.replace(/\bOpenAI\b/gi, 'open ai').replace(/\b(\w+)AI\b/g, '$1 ai');
  let out = OTHER_INDUSTRY;
  for (const g of KEYWORD_GROUPS) {
    // "venture capital" terms ("partners", "fund") are too generic for an industry grouping.
    if (g.label === 'venture capital') continue;
    if (g.terms.some((t) => wordRe(t).test(text))) { out = INDUSTRY_LABEL[g.label] || g.label; break; }
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

/** Country for a contact from its location ("City, State, Country" or "City, Country"); 'Unknown' when absent. */
export function countryOf(contact) {
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

/** Hub key for a contact under a grouping; null for 'company' (no hubs). */
export function groupKeyFor(contact, groupBy) {
  if (groupBy === 'role') return classifyContact(contact).group;
  if (groupBy === 'industry') return industryOf(contact);
  if (groupBy === 'country') return countryOf(contact);
  return null;
}

const MAX_HUBS = 12;

/**
 * Buckets for a grouping: [{ key, label, hint, lens?, contacts }], ordered
 * for the map. Role groups keep their fixed order; industries and countries
 * are largest first with the long tail folded into 'Other' / 'Unknown'.
 */
export function bucketsFor(contacts, groupBy) {
  const list = contacts || [];
  if (groupBy === 'role') {
    return ROLE_GROUPS.map((rg) => ({ ...rg, contacts: list.filter((c) => classifyContact(c).group === rg.key) })).filter((b) => b.contacts.length);
  }
  if (groupBy !== 'industry' && groupBy !== 'country') return [{ key: null, label: '', hint: '', contacts: list }];
  const tailKey = groupBy === 'industry' ? OTHER_INDUSTRY : UNKNOWN_COUNTRY;
  const byKey = new Map();
  for (const c of list) {
    const k = groupKeyFor(c, groupBy);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(c);
  }
  const named = [...byKey.entries()].filter(([k]) => k !== tailKey).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const kept = named.slice(0, MAX_HUBS - 1);
  const tail = [...(byKey.get(tailKey) || []), ...named.slice(MAX_HUBS - 1).flatMap(([, v]) => v)];
  const hint = groupBy === 'industry' ? 'From titles, company names and tags' : 'From the location field';
  const out = kept.map(([k, v]) => ({ key: k, label: k, hint, lens: null, contacts: v }));
  if (tail.length) out.push({ key: tailKey, label: tailKey, hint: groupBy === 'industry' ? 'No sector word in the title or company' : 'No location in the import (LinkedIn exports have none)', lens: null, contacts: tail });
  return out;
}
