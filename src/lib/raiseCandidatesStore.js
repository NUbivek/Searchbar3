import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { scoreRaiseLikelihood } from './raiseScoring';

const SOURCING_ROOT = path.resolve(process.cwd(), '..', 'sourcing101');
const STARTUP_WATCH_ROOT = path.join(SOURCING_ROOT, 'startup_watch');
const OUTPUT_DIR = path.join(STARTUP_WATCH_ROOT, 'output');
const DEFAULT_CSV_PATH = path.join(OUTPUT_DIR, 'latest.csv');
const THESIS_ALLOWLIST_PATH = path.join(process.cwd(), 'sources', 'thesis_v2_allowlist.json');
const LOCAL_SIGNAL_JSONL_FALLBACKS = [
  path.join(process.cwd(), 'data', 'signals.jsonl'),
  path.join(process.cwd(), 'reports', 'post_patch_fresh_run_2026-03-10', 'signals.jsonl'),
  path.join(process.cwd(), 'reports', 'rerun-baseline-2026-03-10', 'signals.jsonl'),
];
const LOCAL_SIGNAL_FALLBACKS = [
  path.join(process.cwd(), 'data', 'crm_export.csv'),
  path.join(process.cwd(), 'reports', 'post_patch_fresh_run_2026-03-10', 'crm_export.csv'),
  path.join(process.cwd(), 'reports', 'rerun-baseline-2026-03-10', 'crm_export.csv'),
];

function parseMoney(value) {
  if (!value) return 0;
  const cleaned = String(value).replace(/[$,\s]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

const COUNTRY_HINTS = [
  ['united states', 'United States'], ['usa', 'United States'], ['u.s.', 'United States'], ['new york', 'United States'], ['san francisco', 'United States'], ['austin', 'United States'], ['seattle', 'United States'],
  ['canada', 'Canada'], ['toronto', 'Canada'], ['vancouver', 'Canada'],
  ['united kingdom', 'United Kingdom'], ['uk', 'United Kingdom'], ['london', 'United Kingdom'],
  ['germany', 'Germany'], ['berlin', 'Germany'], ['munich', 'Germany'],
  ['france', 'France'], ['paris', 'France'],
  ['netherlands', 'Netherlands'], ['amsterdam', 'Netherlands'], ['the hague', 'Netherlands'],
  ['spain', 'Spain'], ['madrid', 'Spain'], ['barcelona', 'Spain'],
  ['italy', 'Italy'], ['milan', 'Italy'], ['rome', 'Italy'],
  ['portugal', 'Portugal'], ['lisbon', 'Portugal'],
  ['sweden', 'Sweden'], ['stockholm', 'Sweden'],
  ['norway', 'Norway'], ['oslo', 'Norway'],
  ['denmark', 'Denmark'], ['copenhagen', 'Denmark'],
  ['finland', 'Finland'], ['helsinki', 'Finland'],
  ['switzerland', 'Switzerland'], ['zurich', 'Switzerland'], ['geneva', 'Switzerland'],
  ['ireland', 'Ireland'], ['dublin', 'Ireland'],
  ['poland', 'Poland'], ['warsaw', 'Poland'],
  ['czech republic', 'Czech Republic'], ['prague', 'Czech Republic'],
  ['austria', 'Austria'], ['vienna', 'Austria'],
  ['estonia', 'Estonia'], ['tallinn', 'Estonia'],
  ['latvia', 'Latvia'], ['riga', 'Latvia'],
  ['lithuania', 'Lithuania'], ['vilnius', 'Lithuania'],
  ['india', 'India'], ['bangalore', 'India'], ['bengaluru', 'India'], ['mumbai', 'India'], ['delhi', 'India'],
  ['pakistan', 'Pakistan'], ['lahore', 'Pakistan'], ['karachi', 'Pakistan'],
  ['bangladesh', 'Bangladesh'], ['dhaka', 'Bangladesh'],
  ['singapore', 'Singapore'],
  ['indonesia', 'Indonesia'], ['jakarta', 'Indonesia'],
  ['malaysia', 'Malaysia'], ['kuala lumpur', 'Malaysia'],
  ['thailand', 'Thailand'], ['bangkok', 'Thailand'],
  ['vietnam', 'Vietnam'], ['ho chi minh', 'Vietnam'], ['hanoi', 'Vietnam'],
  ['philippines', 'Philippines'], ['manila', 'Philippines'],
  ['japan', 'Japan'], ['tokyo', 'Japan'],
  ['south korea', 'South Korea'], ['seoul', 'South Korea'],
  ['china', 'China'], ['beijing', 'China'], ['shanghai', 'China'], ['shenzhen', 'China'],
  ['taiwan', 'Taiwan'], ['taipei', 'Taiwan'],
  ['hong kong', 'Hong Kong'],
  ['uae', 'United Arab Emirates'], ['united arab emirates', 'United Arab Emirates'], ['dubai', 'United Arab Emirates'], ['abu dhabi', 'United Arab Emirates'],
  ['saudi', 'Saudi Arabia'], ['riyadh', 'Saudi Arabia'], ['jeddah', 'Saudi Arabia'],
  ['qatar', 'Qatar'], ['doha', 'Qatar'],
  ['kuwait', 'Kuwait'],
  ['egypt', 'Egypt'], ['egyptian', 'Egypt'], ['cairo', 'Egypt'],
  ['nigeria', 'Nigeria'], ['nigerian', 'Nigeria'], ['lagos', 'Nigeria'],
  ['kenya', 'Kenya'], ['nairobi', 'Kenya'],
  ['south africa', 'South Africa'], ['cape town', 'South Africa'], ['johannesburg', 'South Africa'],
  ['brazil', 'Brazil'], ['sao paulo', 'Brazil'], ['são paulo', 'Brazil'],
  ['mexico', 'Mexico'], ['mexico city', 'Mexico'],
  ['argentina', 'Argentina'], ['buenos aires', 'Argentina'],
  ['chile', 'Chile'], ['santiago', 'Chile'],
  ['australia', 'Australia'], ['sydney', 'Australia'], ['melbourne', 'Australia'],
  ['new zealand', 'New Zealand'], ['auckland', 'New Zealand']
];

function inferCountryFromText(...values) {
  const raw = values.filter(Boolean).join(' | ');
  if (/\bUS\b|\bUSA\b/i.test(raw)) return 'United States';
  if (/\bUK\b/i.test(raw)) return 'United Kingdom';
  if (/\bIL\b/i.test(raw)) return 'Israel';
  if (/\bAU\b/i.test(raw)) return 'Australia';
  if (/\bNZ\b/i.test(raw)) return 'New Zealand';
  if (/\bSG\b/i.test(raw)) return 'Singapore';
  const text = raw.toLowerCase();

  const basedMap = [
    ['dubai', 'United Arab Emirates'], ['abu dhabi', 'United Arab Emirates'], ['riyadh', 'Saudi Arabia'],
    ['jeddah', 'Saudi Arabia'], ['cairo', 'Egypt'], ['lagos', 'Nigeria'], ['nairobi', 'Kenya'],
    ['cape town', 'South Africa'], ['johannesburg', 'South Africa'], ['sao paulo', 'Brazil'],
    ['mexico city', 'Mexico'], ['singapore', 'Singapore'], ['london', 'United Kingdom'],
    ['berlin', 'Germany'], ['paris', 'France'], ['amsterdam', 'Netherlands'], ['madrid', 'Spain'],
    ['mumbai', 'India'], ['bangalore', 'India'], ['bengaluru', 'India'],
    ['new york', 'United States'], ['san francisco', 'United States'], ['los angeles', 'United States'],
    ['boston', 'United States'], ['chicago', 'United States'], ['austin', 'United States'], ['seattle', 'United States'],
    ['miami', 'United States'], ['denver', 'United States'], ['atlanta', 'United States']
  ];
  for (const [city, country] of basedMap) {
    if (text.includes(`${city}-based`) || text.includes(`${city} based`) || text.includes(`hq in ${city}`)) return country;
  }

  if (/\b(hq in|headquartered in|based in)\s+[^|.]{0,50},\s*(ca|ny|tx|wa|ma|il|fl|co|ga|nc|va|dc)\b/.test(text)) {
    return 'United States';
  }

  for (const [needle, country] of COUNTRY_HINTS) {
    if (text.includes(needle)) return country;
  }
  return null;
}

function inferCountryFromUrl(url = '') {
  const host = getHost(url);
  if (!host) return null;
  if (host.endsWith('.uk')) return 'United Kingdom';
  if (host.endsWith('.de')) return 'Germany';
  if (host.endsWith('.fr')) return 'France';
  if (host.endsWith('.nl')) return 'Netherlands';
  if (host.endsWith('.es')) return 'Spain';
  if (host.endsWith('.it')) return 'Italy';
  if (host.endsWith('.pt')) return 'Portugal';
  if (host.endsWith('.se')) return 'Sweden';
  if (host.endsWith('.no')) return 'Norway';
  if (host.endsWith('.dk')) return 'Denmark';
  if (host.endsWith('.fi')) return 'Finland';
  if (host.endsWith('.ch')) return 'Switzerland';
  if (host.endsWith('.ie')) return 'Ireland';
  if (host.endsWith('.pl')) return 'Poland';
  if (host.endsWith('.in')) return 'India';
  if (host.endsWith('.sg')) return 'Singapore';
  if (host.endsWith('.ae')) return 'United Arab Emirates';
  if (host.endsWith('.sa')) return 'Saudi Arabia';
  if (host.endsWith('.za')) return 'South Africa';
  if (host.endsWith('.ng')) return 'Nigeria';
  if (host.endsWith('.au')) return 'Australia';
  if (host.endsWith('.nz')) return 'New Zealand';
  return null;
}

function inferCountryFromProgramHost(url = '') {
  const host = getHost(url);
  if (!host) return null;

  const usProgramHosts = [
    'skydeck.berkeley.edu',
    'comotion.uw.edu',
    'entrepreneurship.mit.edu'
  ];

  if (usProgramHosts.some((h) => host === h || host.endsWith(`.${h}`))) return 'United States';
  return null;
}

function inferCountry({ hq, description, startupName, startupUrl, sourceUrl, sourceRegion, sourceCategory }) {
  const fromText = inferCountryFromText(hq, description, startupName);
  if (fromText) return fromText;
  const fromStartupUrl = inferCountryFromUrl(startupUrl);
  if (fromStartupUrl) return fromStartupUrl;
  const fromProgramHost = inferCountryFromProgramHost(sourceUrl) || inferCountryFromProgramHost(startupUrl);
  if (fromProgramHost) return fromProgramHost;
  const normalizedSourceRegion = String(sourceRegion || '').toUpperCase();
  const startupSourceCategory = String(sourceCategory || '').toLowerCase();
  if (
    ['US', 'US_GLOBAL', 'US_EU', 'EU_US', 'EU_US_GLOBAL', 'IL_US'].includes(normalizedSourceRegion)
    && STARTUP_INVENTORY_DIRECTORY_CATEGORIES.has(startupSourceCategory)
  ) {
    return 'United States';
  }
  return 'Unknown';
}

function cleanText(v) {
  if (!v) return '';
  return String(v)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[{}\[\]|`~^*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatSectorLabel(sector = '') {
  const raw = String(sector || '').trim();
  if (!raw) return '';
  return raw
    .split('|')
    .map((part) => cleanText(part).replace(/_/g, ' ').trim())
    .filter(Boolean)
    .join(', ');
}

function sourceCategoryLabel(sourceCategory = '') {
  switch (String(sourceCategory || '').toLowerCase()) {
    case 'venture_portfolio': return 'portfolio';
    case 'accelerator_portfolio': return 'accelerator portfolio';
    case 'startup_database': return 'startup database';
    case 'university_accelerator': return 'university startup program';
    case 'accelerator_directory': return 'accelerator directory';
    default: return 'source listing';
  }
}

function summarizeDescription(raw = '', startupName = '', sector = '', sourceName = '', signalType = '', sourceCategory = '') {
  const text = cleanText(raw)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\b(function|const|let|var|return|class|import|export)\b/g, ' ')
    .replace(/\b(field--name-|field__item|div class|span class|href=|class=|id=)\b/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const noisy = /(field--|class=|div\s|span\s|__item|\{|\}|;|=)/i.test(text);
  const thin = !text
    || text.length < 25
    || normalizeToken(text) === normalizeToken(startupName)
    || /^visit/i.test(text)
    || /^https?:/i.test(text);
  const chunks = text
    .split(/[.!?]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 35 && !/[{};=<>]/.test(s));

  let best = chunks[0] || '';
  if (!best || noisy || thin) {
    const parts = [];
    if (signalType === 'directory_listing' && sourceName) {
      parts.push(`Listed in ${sourceName} ${sourceCategoryLabel(sourceCategory)}.`);
    } else if (sourceName) {
      parts.push(`Mentioned by ${sourceName}.`);
    }
    const sectorLabel = formatSectorLabel(sector);
    if (sectorLabel) {
      parts.push(`Sector tags: ${sectorLabel}.`);
    }
    if (parts.length) return parts.join(' ');
    return cleanText(raw) || startupName || 'No summary available.';
  }

  best = best.slice(0, 180).replace(/\s+/g, ' ').trim();
  return best;
}

function summarizeSource(sourceKey = '', sourceUrl = '') {
  try {
    if (sourceUrl) {
      const u = new URL(sourceUrl.startsWith('http') ? sourceUrl : `https://${sourceUrl}`);
      const host = u.hostname.replace(/^www\./, '');
      return `Source: ${host}`;
    }
  } catch {}
  const source = cleanText(sourceKey) || 'unknown';
  return `Source: ${source}`;
}

function summarizeStage(stage = '') {
  const s = cleanText(stage) || 'Unknown';
  return `Current stage: ${s}.`;
}

function forecastFromScore(score = 0) {
  const s = Number(score) || 0;
  if (s >= 85) return { label: 'Very likely in ≤6 months', probability: '80-90%' };
  if (s >= 70) return { label: 'Likely in ≤6 months', probability: '65-79%' };
  if (s >= 60) return { label: 'Possible in ≤6 months', probability: '55-64%' };
  if (s >= 45) return { label: 'Watchlist (not likely yet)', probability: '40-54%' };
  return { label: 'Unlikely in ≤6 months', probability: '<40%' };
}

function looksLikeNewsHeadline(name = '') {
  const n = String(name).toLowerCase();
  return [
    ' raises ', ' raised ', ' receives ', ' received ', ' announces', ' announced', ' secures ', ' funding', ' investment',
    ' closes ', ' closed ', ' series ',
    ' report', ' reports', ' calls time', ' according to', 'press release', 'roundup',
    'startup lessons', 'winners of', 'expands into', 'investment led by', 'shuts down', 'reviewed',
    'demo day', 'accelerator', 'program', 'award', 'search', 'reporting', 'frontpage', 'grant'
  ].some((k) => n.includes(k));
}

function looksLikePersonOrSentence(name = '') {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length > 5) return true;
  if (/[,:;!?]/.test(name)) return true;
  return false;
}

function looksLikePersonName(name = '') {
  const cleaned = cleanText(name);
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;

  const hasCompanyToken = /(inc|llc|ltd|corp|company|technologies|tech|labs|systems|ai|bio|ventures|analytics|software)/i.test(cleaned);
  if (hasCompanyToken) return false;

  const initialsPattern = /^[A-Z][a-z]+\s+[A-Z]\.?\s+[A-Z][a-z]+$/;
  if (initialsPattern.test(cleaned)) return true;

  const titleCaseWords = words.filter((w) => /^[A-Z][a-z'\-]+$/.test(w)).length;
  return titleCaseWords === words.length;
}

function looksLikeUiLabel(name = '') {
  const n = cleanText(name).toLowerCase();
  if (!n) return true;
  if (n.length <= 2) return true;

  const exact = new Set([
    'skip to main content', 'view details', 'our network', 'legal', 'partnerships', 'media and pr kit',
    'founders', 'experts', 'mentors', 'strategy', 'lp portal', 'our team', 'disclaimer', 'companies',
    'portfolio', 'about', 'contact', 'support', 'privacy', 'terms', 'jobs', 'directory', 'collaborators',
    'our challenge areas', 'valuation', 'de i policy', 'de&i policy', 'methodology section', 'gser 2025', 'series d',
    'climate', 'traction', 'regions', 'fintech', 'security resiliency', 'security and resiliency', 'healthcare and life sciences',
    'corporate partners', 'entrepreneurs in residence', 'antler insights', 'diy mtc', 'mit sloan e i certificate', 'courseorama',
    'bridge to mc', 'corporate innovation', 'mit delta v', 'hubs', 'mit fuse', 'founder stories', 'financials', 'all startups',
    'healthcare', 'accessibility', 'back', 'eirs', 'next', 'quicklinks', 'courses', 'follow',
    'investors', 'advisors', 'students', 'media', 'virtual intern fair', 'berkeley skydeck', 'give to skydeck', 'team & ambassadors', 'begin berkeley',
    'skip to content', 'asia pacific', 'corporate solutions', 'adventures in claude', 'side business to startup',
    'vibe marketplace by greta', 'i’ve moved onchain', "i've moved onchain", 'directories', 'calendar', 'crypto',
    'massachusetts institute of technology'
  ]);
  if (exact.has(n)) return true;

  const countryWord = new Set([
    'australia','india','israel','canada','france','germany','netherlands','sweden','norway','indonesia','japan','korea','singapore','vietnam','malaysia',
    'denmark','finland','brazil','kenya','nigeria','portugal','spain','italy','switzerland','austria'
  ]);
  if (countryWord.has(n)) return true;

  if (/^(home|team|blog|news|press|careers|events|programs|community|resources|europe|americas|asia|africa)$/.test(n)) return true;
  if (/^(our|the)\s+(team|network|community|partners)$/.test(n)) return true;
  if (/\b(skip to|view rationale|read more|learn more|subscribe|discussion|watch now|overview|challenge(s)?|corporate|solutions?|marketplace)\b/.test(n)) return true;
  if (/\b(on facebook|research park)\b/.test(n)) return true;
  if (/^(myuw|home|about us|our story|our work)$/.test(n)) return true;
  if (/\b(by|from)\s+[a-z]+$/.test(n) && n.split(/\s+/).length >= 3) return true;
  if (/\b(and|systems|sciences|policy|certificate|resiliency)\b/.test(n) && n.split(/\s+/).length >= 2) return true;
  if (/\b(work with|become an|partner with|cohort start|start dates|this form|by design|all startups|apply now|learn more)\b/.test(n)) return true;
  if (/\bbecomes?\b.+\b(unicorn|series|funding)\b/.test(n)) return true;
  if (n.includes('email protected')) return true;
  return false;
}

function isCompanyLikeName(name = '') {
  const cleaned = cleanText(name);
  if (!cleaned) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length > 5) return false;
  if (/(newsletter|podcast|episode|review|report|analysis|news|article|press|our team|disclaimer|privacy|terms|contact|about us|careers|jobs)/i.test(cleaned)) return false;
  if (/^(industry|manufacturing|logistics|supply chain|agtech|startup|startups|portfolio|companies|company|team|our team|disclaimer)$/i.test(cleaned)) return false;
  if (/^(investors|advisors|students|media|courses|quicklinks|follow)$/i.test(cleaned)) return false;
  return /^[-A-Za-z0-9&+.'’\s]+$/.test(cleaned);
}

function looksLikeSourceBrandName(name = '', sourceUrl = '', startupUrl = '') {
  const n = cleanText(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!n) return false;

  const hosts = [getHost(sourceUrl), getHost(startupUrl)].filter(Boolean);
  for (const h of hosts) {
    const brand = h.split('.').slice(0, -1).join(' ').replace(/[^a-z0-9]+/g, ' ').trim();
    if (!brand) continue;
    if (n === brand) return true;
    if (brand.includes(n) || n.includes(brand)) {
      if (n.length <= brand.length + 3) return true;
    }
  }
  return false;
}

function isLikelyCompanyUrl(v = '') {
  if (!v) return false;
  try {
    const u = new URL(v.startsWith('http') ? v : `https://${v}`);
    const host = u.hostname.toLowerCase();
    const pathName = (u.pathname || '').toLowerCase();
    if (!host || host.split('.').length < 2) return false;
    if (host.endsWith('.edu') || host.includes('.edu.')) return false;

    const blockedHosts = [
      'techcrunch.com', 'tech.eu', 'geekwire.com', 'startupbeat.com', 'uktechnews.info', 'techgistafrica.com',
      'medium.com', 'substack.com', 'reddit.com', 'news.ycombinator.com', 'x.com', 'twitter.com',
      'cleanenergywire.org',
      // Program/source hosts are not startup company domains.
      'entrepreneurship.mit.edu', 'masschallenge.org', 'alchemistaccelerator.com', '500.co', 'comotion.uw.edu', 'antler.co'
    ];
    if (blockedHosts.some((d) => host.endsWith(d))) return false;

    const articleLikePath = /\/(news|article|articles|press|blog|posts|story|stories|insights|reports?|contact|contacts|about|author|authors)\b/.test(pathName);
    const datedPath = /\/20\d{2}\/(0[1-9]|1[0-2])\//.test(pathName);
    const sluggyPath = pathName.split('/').filter(Boolean).some((p) => p.split('-').length >= 6);
    if (articleLikePath || datedPath || sluggyPath) return false;

    return true;
  } catch {
    return false;
  }
}

function rootDomain(url = '') {
  const host = getHost(url);
  if (!host) return '';
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  return parts.slice(-2).join('.');
}

function isAllowedSource(sourceKey = '') {
  const s = String(sourceKey || '').toLowerCase();
  return [
    'techcrunch', 'crunchbase', 'pitchbook', 'hackernews', 'yc', 'ycombinator',
    'linkedin', 'reddit', 'twitter', 'x.com', 'substack', 'medium', 'web'
  ].some((k) => s.includes(k));
}

function isMapHost(host = '') {
  return ['google.com', 'goo.gl', 'maps.app'].some((d) => host === d || host.endsWith(`.${d}`));
}

function looksLikeAddressOrGeoLabel(name = '') {
  const n = cleanText(name);
  if (!n) return false;
  if (/^(united states|canada|united kingdom|germany|france|israel|australia|singapore|india)$/i.test(n)) return true;
  if (/\b(jerusalem|new york|tel aviv|san francisco|austin|seattle)\b/i.test(n) && /\b(street|st\.|ave|avenue|road|rd\.|blvd|boulevard)\b/i.test(n)) return true;
  if (/^\d+\s+\w+/.test(n)) return true;
  if (/\b( israel| united states| new york| jerusalem)\b/i.test(n) && n.split(/\s+/).length >= 3) return true;
  return false;
}

function isHardBlockedDirectoryLabel(name = '') {
  const n = cleanText(name);
  return (
    /^(user agreement|photos|medium|foundation|our perspective|investment focus|meet our speakers|meet the companies|alumni association|partner portal|locations|copyright|about s?p global|accessibility statement|faqs|ca notice of collection|general partner login|portfolio companies|visitcaladan|data explorer|accessibility at the sdcc|start payment plan|retailer expert network)$/i.test(n)
    || /^(https|http)/i.test(n)
    || /https/i.test(n)
    || /\b(linkedin-in|ga verder naar de inhoud|404)\b/i.test(n)
    || /^built in (san francisco|seattle|austin|chicago|new york|los angeles)$/i.test(n)
    || looksLikeAddressOrGeoLabel(n)
  );
}

function getHost(value = '') {
  try {
    const u = new URL(String(value).startsWith('http') ? value : `https://${value}`);
    return (u.hostname || '').toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function loadThesisAllowlist() {
  try {
    if (!fs.existsSync(THESIS_ALLOWLIST_PATH)) {
      return { allowedHosts: [], blockedHosts: [], blockedNamePatterns: [] };
    }
    const raw = JSON.parse(fs.readFileSync(THESIS_ALLOWLIST_PATH, 'utf8'));
    return {
      allowedHosts: raw.allowedHosts || [],
      blockedHosts: raw.blockedHosts || [],
      blockedNamePatterns: (raw.blockedNamePatterns || []).map((s) => String(s).toLowerCase()),
    };
  } catch {
    return { allowedHosts: [], blockedHosts: [], blockedNamePatterns: [] };
  }
}

const THESIS_ALLOWLIST = loadThesisAllowlist();

function hostMatchesList(host = '', list = []) {
  if (!host) return false;
  return list.some((d) => host === d || host.endsWith(`.${d}`));
}

function isAggregatorHost(host = '') {
  if (!host) return true;
  return [
    'producthunt.com', 'w3.org', 'medium.com', 'substack.com', 'reddit.com',
    'news.ycombinator.com', 'x.com', 'twitter.com', 'linkedin.com', 'github.com',
    'facebook.com', 'fb.com', 'instagram.com', 'tiktok.com',
    'comotion.uw.edu', 'venturefounders.com'
  ].some((d) => host === d || host.endsWith(`.${d}`));
}

function isNonCompanyContentHost(host = '') {
  if (!host) return false;
  return [
    'wikipedia.org', 'youtube.com', 'youtu.be', 'forentrepreneurs.com', 'kubicki.org',
    'arcticstartup.com', 'ventureburn.com', 'betalist.com', 'feld.com', 'finsmes.com', 'siliconangle.com',
    'thecondia.com', 'venturecapitaljournal.com', 'techcrunch.com', 'thenextweb.com', 'agtechnavigator.com', 'cofounders.nyc'
  ].some((d) => host === d || host.endsWith(`.${d}`));
}

function isTrustedNameOnlySourceHost(host = '') {
  if (!host) return false;
  return [
    'alchemistaccelerator.com',
    'masschallenge.org',
    '500.co',
    'antler.co',
    'skydeck.berkeley.edu'
  ].some((d) => host === d || host.endsWith(`.${d}`));
}

function isInvestorOrProgramHost(host = '') {
  if (!host) return false;
  return [
    '500.co',
    'alchemistaccelerator.com',
    'antler.co',
    'cleanenergyventures.com',
    'comotion.uw.edu',
    'engineventures.com',
    'entrepreneurship.mit.edu',
    'extantia.com',
    'hax.co',
    'khoslaventures.com',
    'lererhippeau.com',
    'masschallenge.org',
    'rre.com',
    'skydeck.berkeley.edu',
    'sosv.com',
    'techstars.com',
    'techstars.org',
    'theengineventures.com',
    'tlv.partners',
    'worldfund.vc',
  ].some((d) => host === d || host.endsWith(`.${d}`));
}

function hasWeirdTextArtifacts(value = '') {
  const text = String(value || '');
  if (!text) return false;
  if (/[\uFFFD]/.test(text)) return true;
  if (/(\bundefined\b|\bnull\b|\[object Object\]|<script|\{\{|\}\}|\\x[0-9a-f]{2})/i.test(text)) return true;
  const stripped = text.replace(/[\x20-\x7E\n\r\t]/g, '');
  if (stripped.length > 0 && (stripped.length / Math.max(1, text.length)) > 0.18) return true;
  return false;
}

function startupNameMatchesUrl(row) {
  const host = getHost(row.startup_url || '');
  if (!host) return true;
  if (isTrustedNameOnlySourceHost(host)) return true;
  const base = host.split('.').slice(-2, -1)[0] || host.split('.')[0] || '';
  const hostToken = normalizeToken(base).replace(/\s+/g, '');
  const nameToken = normalizeToken(row.startup_name || '').replace(/\s+/g, '');
  if (!hostToken || !nameToken) return false;
  if (hostToken.length < 4) return false;
  if (nameToken.length < 4) return true;
  return nameToken.includes(hostToken) || hostToken.includes(nameToken.slice(0, Math.min(nameToken.length, 8)));
}

function looksLikeArticleUrl(url = '') {
  if (!url) return false;
  try {
    const u = new URL(String(url).startsWith('http') ? String(url) : `https://${String(url)}`);
    const p = (u.pathname || '').toLowerCase();
    if (!p || p === '/' || p === '/home' || p === '/about') return false;
    if (/(\/news\/|\/blog\/|\/article\/|\/post\/|\/stories\/|\/events\/|\/press\/|\/category\/|\/tag\/|\/podcast\/)/.test(p)) return true;
    if (p.includes('_')) return true;
    const parts = p.split('/').filter(Boolean);
    if (parts.length >= 2) return true;
    const slug = parts[0] || '';
    if (slug.split('-').length >= 4) return true;
    return false;
  } catch {
    return false;
  }
}

function passesCoreQuality(row) {
  const name = cleanText(row.startup_name || '');
  if (!name) return false;
  const sourceHost = getHost(row.source_url || '');
  const trustedStructuredHost = isTrustedNameOnlySourceHost(sourceHost) || sourceHost === 'skydeck.berkeley.edu';
  const nLower = name.toLowerCase();

  if (THESIS_ALLOWLIST.blockedNamePatterns.some((p) => nLower.includes(p))) return false;
  if (looksLikeNewsHeadline(name)) return false;
  if (looksLikePersonOrSentence(name)) return false;
  if (!trustedStructuredHost && looksLikePersonName(name)) return false;
  if (looksLikeUiLabel(name)) return false;
  if (/https?:\/\//i.test(name)) return false;
  if (name.length > 60) return false;
  if (!isCompanyLikeName(name)) return false;
  if (/^\d/.test(name)) return false;
  if (/^[A-Z\s&.-]+$/.test(name)) {
    const compact = name.replace(/[^A-Z]/g, '');
    if (compact.length >= 4) return false;
  }
  if (/^[A-Z\s&]+$/.test(name) && name.split(/\s+/).length <= 3) return false;
  if (name.split(/\s+/).length > 4) return false;
  if (/(forgotten|inventions|reviewed|case for|problem|lessons|trials and tribulations|festival|video|presentations|podcast|episode|guide|tutorial|letters?)/i.test(name)) return false;
  if (/^(shell|microsoft|google|amazon|apple|meta|tesla|netflix|masschallenge|alchemist|techstars|antler)$/i.test(name)) return false;
  if (/\b(university|institute of technology|college|school of|department of)\b/i.test(name)) return false;
  if (looksLikeSourceBrandName(name, row.source_url, row.startup_url)) return false;

  const description = cleanText(row.description || row.raw_signal_text || '');
  if (hasWeirdTextArtifacts(name) || hasWeirdTextArtifacts(description)) return false;
  if (description && description.length < 20) return false;

  const startupHost = getHost(row.startup_url || '');
  if (isNonCompanyContentHost(startupHost)) return false;

  return true;
}

function monthsSince(dateLike) {
  if (!dateLike) return 18;
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return 18;
  return Math.max(1, Math.round((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30)));
}

const REGISTRY_PATH = path.join(process.cwd(), 'sources', 'registry.json');
const SOURCE_RECONCILIATION_PATH = path.join(process.cwd(), 'sources', 'source_reconciliation.json');
let REGISTRY_CACHE = null;
let SOURCE_RECONCILIATION_CACHE = null;
const STARTUP_INVENTORY_DIRECTORY_CATEGORIES = new Set([
  'venture_portfolio',
  'accelerator_portfolio',
  'startup_database',
  'university_accelerator',
  'accelerator_directory',
]);

function normalizeToken(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function getSourceReconciliationMap() {
  if (SOURCE_RECONCILIATION_CACHE) return SOURCE_RECONCILIATION_CACHE;
  const out = {};
  if (!fs.existsSync(SOURCE_RECONCILIATION_PATH)) {
    SOURCE_RECONCILIATION_CACHE = out;
    return out;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(SOURCE_RECONCILIATION_PATH, 'utf8'));
    for (const [k, v] of Object.entries(raw || {})) {
      const nk = normalizeToken(k);
      if (!nk || !v) continue;
      out[nk] = String(v).trim().toLowerCase();
    }
  } catch {}
  SOURCE_RECONCILIATION_CACHE = out;
  return out;
}

function getRegistryIndex() {
  if (REGISTRY_CACHE) return REGISTRY_CACHE;

  const out = {
    byId: new Map(),
    byName: new Map(),
    byHost: new Map(),
  };

  if (!fs.existsSync(REGISTRY_PATH)) {
    REGISTRY_CACHE = out;
    return out;
  }

  try {
    const entries = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const id = cleanText(entry.id);
      const name = cleanText(entry.name);
      const tier = cleanText(entry?.cadence?.tier) || 'Unknown';
      const methodUrl = cleanText(entry?.method?.url);
      const adapter = cleanText(entry?.adapter);

      const normalized = {
        id: id || null,
        name: name || id || 'Unknown source',
        tier,
        methodUrl,
        adapter,
        category: cleanText(entry.category) || null,
        region: cleanText(entry.region) || null,
      };

      if (id) out.byId.set(id.toLowerCase(), normalized);
      if (name) out.byName.set(normalizeToken(name), normalized);
      if (adapter) out.byName.set(normalizeToken(adapter), normalized);

      const host = getHost(methodUrl);
      if (host) out.byHost.set(host, normalized);
    }
  } catch {
    // Keep empty cache on parse/read errors.
  }

  REGISTRY_CACHE = out;
  return out;
}

function normalizeTier(value = '') {
  const v = cleanText(value).toUpperCase();
  if (v === 'A' || v === 'B' || v === 'C') return v;
  if (v === 'TIER-1' || v === 'TIER 1') return 'A';
  if (v === 'TIER-2' || v === 'TIER 2') return 'B';
  if (v === 'TIER-3' || v === 'TIER 3') return 'C';
  return null;
}

const OUTPUT_SOURCE_ALIASES = {
  fivehundred_global: '500 global',
  berkeley_skydeck: 'uc berkeley skydeck',
  skydeck_portfolio_js: 'uc berkeley skydeck',
  uw_comotion: 'uw comotion',
  agfunder_news: 'agfunder news rss',
  producthunt: 'product hunt feed',
  freightwaves: 'freighttech 25',
  irishtechnews: 'silicon republic startups feed',
  hackernews: 'hacker news algolia',
  alchemist: 'alchemist accelerator',
  antler: 'antler portfolio',
  s2g_companies: 's2g ventures portfolio',
};

function resolveRegistrySource(sourceName = '', sourceUrl = '', sourceIdRaw = '', investorTierRaw = '') {
  const registry = getRegistryIndex();
  const sourceId = cleanText(sourceIdRaw).toLowerCase();
  const sourceNorm = normalizeToken(sourceName);
  const aliasNorm = normalizeToken(OUTPUT_SOURCE_ALIASES[sourceNorm] || '');
  const sourceHost = getHost(sourceUrl || '');
  const reconciliation = getSourceReconciliationMap();
  const reconciledId = reconciliation[sourceNorm] || reconciliation[aliasNorm] || '';

  let match = null;
  if (sourceId) match = registry.byId.get(sourceId) || null;
  if (!match && reconciledId) match = registry.byId.get(reconciledId) || null;
  if (!match && sourceNorm) match = registry.byName.get(sourceNorm) || null;
  if (!match && aliasNorm) match = registry.byName.get(aliasNorm) || null;
  if (!match && sourceHost) match = registry.byHost.get(sourceHost) || null;

  const fallbackTier = normalizeTier(investorTierRaw);

  if (match) {
    return {
      source_id: match.id,
      source_name: match.name,
      source_tier: normalizeTier(match.tier) || 'Unknown',
      source_category: match.category || null,
      source_region: match.region || null,
      source_registry_match: true,
    };
  }

  return {
    source_id: cleanText(sourceIdRaw) || null,
    source_name: cleanText(sourceName) || 'Unknown source',
    source_tier: fallbackTier || 'Unknown',
    source_category: null,
    source_region: null,
    source_registry_match: false,
  };
}

function hasAcceleratorSignal(text = '') {
  const t = String(text).toLowerCase();
  return /(y combinator|techstars|sosv|500 global|accelerator|incubator|demo day|graduated)/.test(t);
}

function walkCsvFiles(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkCsvFiles(p, acc);
    else if (name.toLowerCase().endsWith('.csv')) acc.push(p);
  }
  return acc;
}

function listSourceCsvFiles() {
  const explicit = process.env.SOURCE_SIGNALS_CSV;
  if (explicit) {
    return explicit.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const outputDir = path.join(STARTUP_WATCH_ROOT, 'output');
  const files = fs.existsSync(outputDir)
    ? fs.readdirSync(outputDir)
      .filter((name) => name.toLowerCase().endsWith('.csv'))
      .map((name) => path.join(outputDir, name))
      .filter((p) => fs.existsSync(p))
    : [];

  if (!files.length) {
    const jsonlFallbacks = LOCAL_SIGNAL_JSONL_FALLBACKS.filter((p) => fs.existsSync(p));
    if (jsonlFallbacks.length) return jsonlFallbacks;
    if (fs.existsSync(DEFAULT_CSV_PATH)) return [DEFAULT_CSV_PATH];
    return LOCAL_SIGNAL_FALLBACKS.filter((p) => fs.existsSync(p));
  }

  const mode = String(process.env.SOURCE_SIGNALS_MODE || 'all').toLowerCase();
  if (mode === 'latest') {
    let newest = files[0];
    let newestMtime = fs.statSync(newest).mtimeMs;
    for (const file of files.slice(1)) {
      const mtime = fs.statSync(file).mtimeMs;
      if (mtime > newestMtime) {
        newest = file;
        newestMtime = mtime;
      }
    }
    return [newest];
  }

  return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function pick(r, keys) {
  for (const k of keys) {
    if (r[k] != null && String(r[k]).trim() !== '') return String(r[k]).trim();
  }
  return '';
}

function normalizeStartupName(name = '') {
  const cleaned = cleanText(name);
  const m = cleaned.match(/^(.+?)\s+(raises|raised|receives|received|secures|secured|announces|announced|wins|shuts\s+down)\b/i);
  let candidate = m ? m[1] : cleaned;

  candidate = candidate
    .replace(/^the\s+/i, '')
    .replace(/^[A-Za-z]+[’']s\s+/i, '')
    .replace(/^(saudi’s|dubai’s|egypt’s|india’s|africa’s|finland’s)\s+/i, '')
    .replace(/^(renewable energy provider|fintech startup|startup|company|platform)\s+/i, '')
    .replace(/^(seattle|boston|new york|san francisco|austin|london|berlin|paris|toronto)\s+startup\s+/i, '')
    .trim();

  const domainLike = candidate.match(/^www\.([a-z0-9-]+)\.(ai|io|com|co|net|org)$/i) || candidate.match(/^([a-z0-9-]+)\.(ai|io|com|co|net|org)$/i);
  if (domainLike) {
    return domainLike[1];
  }

  return candidate;
}

function sanitizeDirectoryLabel(value = '') {
  const cleaned = cleanText(value);
  if (!cleaned) return '';

  const founderOnly = cleaned.match(/\b(?:co-)?founder\s+(.+)$/i);
  let normalized = founderOnly ? founderOnly[1] : cleaned;

  normalized = normalized
    .replace(/^(visit|meet|discover|explore|check)\s+/i, '')
    .replace(/\s+logo$/i, '')
    .trim();

  if (/^[a-z0-9-]+(com|io|ai|co|net|org)$/i.test(normalized) && !/\./.test(normalized)) {
    normalized = normalized.replace(/(com|io|ai|co|net|org)$/i, '').trim();
  }

  return normalized;
}

function normalizeDirectorySignalName(name = '', evidenceTitle = '') {
  const cleaned = sanitizeDirectoryLabel(name);
  const title = sanitizeDirectoryLabel(evidenceTitle);

  if (!cleaned) return '';
  if (!title) return cleaned;

  if (
    /^(visit|meet|discover|explore|check)\b/i.test(cleaned)
    || /^(visit|meet|discover|explore|check)([A-Z].+)/i.test(cleaned)
    || /\b(logo|founder|podcast)\b/i.test(cleaned)
    || /^https?\b/i.test(cleaned)
  ) {
    if (isCompanyLikeName(title) && !looksLikeUiLabel(title) && !isHardBlockedDirectoryLabel(title)) {
      return title;
    }
  }

  return cleaned;
}

function loadRealSourceRows() {
  const files = listSourceCsvFiles();
  if (!files.length) throw new Error(`No real source CSV files found in ${SOURCING_ROOT}`);

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 12);

  const out = [];
  const usedFiles = [];
  for (const csvPath of files) {
    if (!fs.existsSync(csvPath)) continue;
    let parsed = [];
    try {
      const content = fs.readFileSync(csvPath, 'utf8');
      if (csvPath.toLowerCase().endsWith('.jsonl')) {
        parsed = content
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const obj = JSON.parse(line);
            return {
              company_name: obj.company_name,
              company_website: obj.company_website,
              company_domain: obj.company_domain || '',
              description: obj.description || obj.evidence?.excerpt || obj.evidence?.title || '',
              evidence_title: obj.evidence?.title || '',
              stage: obj.stage,
              stage_guess: obj.stage_guess,
              region: obj.region,
              region_guess: obj.region_guess,
              source_name: obj.source_name,
              source_id: obj.source_id,
              source_url: obj.source_url,
              evidence_role: obj.evidence_role || '',
              signal_weight: obj.signal_weight || 'low',
              item_url: obj.item_url,
              published_at: obj.published_at,
              confidence: obj.confidence,
              thesis_tags: Array.isArray(obj.thesis_tags) ? obj.thesis_tags.join('|') : obj.thesis_tags,
              funding_amount_guess: obj.enrichment?.funding_amount_guess || null,
              funding_signal: obj.enrichment?.funding_signal || '',
              investor_signal: obj.enrichment?.investor_signal || '',
              hiring_signal: obj.enrichment?.hiring_signal || '',
              has_distinct_company_website: obj.enrichment?.has_distinct_company_website ? 'true' : 'false',
              company_root_domain: obj.enrichment?.company_root_domain || rootDomain(obj.company_website || ''),
              item_root_domain: obj.enrichment?.item_root_domain || rootDomain(obj.item_url || ''),
              signal_type: obj.signal_type || '',
              last_round_date: obj.published_at || null,
            };
          });
      } else {
        parsed = parse(content, { columns: true, skip_empty_lines: true, relax_column_count: true, bom: true });
      }
    } catch {
      continue;
    }

    // skip tiny/invalid csvs
    if (!parsed.length) continue;
    usedFiles.push(csvPath);

    for (const r of parsed) {
      let startupName = normalizeStartupName(pick(r, ['company', 'Company', 'company_name', 'Company Name', 'name', 'startup_name']));
      if (!startupName) continue;

      const capturedRaw = pick(r, ['date_captured', 'captured_at', 'date', 'created_at', 'published_at', 'run_date']);
      const capturedDate = capturedRaw ? new Date(capturedRaw) : fs.statSync(csvPath).mtime;
      if (capturedDate < cutoff) continue;

      let startupUrl = cleanText(pick(r, ['website', 'company_url', 'company_website', 'linkedin_url', 'domain']));
      const description = cleanText(pick(r, ['description', 'signal_text', 'summary', 'blurb', 'evidence_excerpt', 'evidence_title']));
      let stage = cleanText(pick(r, ['stage_inferred', 'stage', 'round_stage'])) || 'Unknown';
      if (stage === 'Unknown') stage = cleanText(pick(r, ['stage_guess'])) || 'Unknown';
      if (/series\s*a/i.test(stage) || /series\s*a/i.test(description)) stage = 'Series A';
      else if (/series\s*b/i.test(stage) || /series\s*b/i.test(description)) stage = 'Series B';
      else if (/series\s*c/i.test(stage) || /series\s*c/i.test(description)) stage = 'Series C';
      else if (/pre[-\s]?seed/i.test(stage) || /pre[-\s]?seed/i.test(description)) stage = 'Pre-Seed';
      else if (/seed/i.test(stage) || /seed/i.test(description)) stage = 'Seed';
      else if (/stealth/i.test(stage)) stage = 'Stealth';
      const hqRaw = cleanText(pick(r, ['hq', 'country', 'hq_country', 'location', 'region_guess'])) || '';
      const source = cleanText(pick(r, ['source_name', 'source', 'source_key', 'dataset'])) || path.basename(csvPath);
      const sourceIdRaw = cleanText(pick(r, ['source_id', 'sourceId', 'source_registry_id'])) || null;
      const sourceUrl = cleanText(pick(r, ['source_url', 'url_source', 'article_url', 'item_url'])) || null;

      const signalType = cleanText(pick(r, ['signal_type'])) || 'mention';
      const evidenceTitle = cleanText(pick(r, ['evidence_title', 'title']));
      if (signalType === 'directory_listing') {
        startupName = normalizeDirectorySignalName(startupName, evidenceTitle);
        if (!startupName) continue;
      }
      const fundingSignal = cleanText(pick(r, ['funding_signal'])) || 'none';
      const investorSignal = cleanText(pick(r, ['investor_signal'])) || 'none';
      const hiringSignal = cleanText(pick(r, ['hiring_signal'])) || 'none';
      const distinctWebsite = String(pick(r, ['has_distinct_company_website'])).toLowerCase() === 'true';

      const startupHost = getHost(startupUrl);
      if (startupHost && isAggregatorHost(startupHost)) startupUrl = '';

      if (!startupUrl && sourceUrl && signalType !== 'directory_listing') {
        const sourceHost = getHost(sourceUrl);
        if (!isAggregatorHost(sourceHost) && isLikelyCompanyUrl(sourceUrl)) {
          startupUrl = sourceUrl;
        }
      }

      if (signalType === 'directory_listing') {
        const sourceHost = getHost(sourceUrl);
        const currentHost = getHost(startupUrl);
        const sameSourceHost = currentHost && sourceHost && currentHost === sourceHost;
        const sameRootHost = currentHost && sourceHost && rootDomain(`https://${currentHost}`) === rootDomain(`https://${sourceHost}`);
        const clearlyExternalCompanySite = currentHost && sourceHost && currentHost !== sourceHost && !sameRootHost;
        if (
          !currentHost
          || sameSourceHost
          || sameRootHost
          || isAggregatorHost(currentHost)
          || isInvestorOrProgramHost(currentHost)
          || (!distinctWebsite && !clearlyExternalCompanySite)
        ) {
          startupUrl = '';
        }
      }
      const funding = parseMoney(pick(r, ['funding_amount', 'funding_usd', 'funding_amount_guess', 'amount_raised', 'last_round_amount']));
      const lastRound = pick(r, ['last_round_date', 'round_date']) || null;
      const headcount = pick(r, ['headcount', 'employees', 'team_size']) || null;
      const sectorRaw = pick(r, ['categories', 'category_tags', 'sector', 'category', 'industry', 'thesis_tags']);
      const sector = String(sectorRaw || '').replace(/[\[\]"]+/g, '').split(',')[0]?.trim() || 'General';
      const sourceMeta = resolveRegistrySource(source, sourceUrl, sourceIdRaw, pick(r, ['investor_tier', 'investorTier', 'tier']));
      const hq = inferCountry({
        hq: hqRaw,
        description,
        startupName,
        startupUrl,
        sourceUrl,
        sourceRegion: sourceMeta.source_region,
        sourceCategory: sourceMeta.source_category,
      });

      const normalized = {
        startup_name: startupName,
        startup_url: startupUrl || null,
        company_domain: cleanText(pick(r, ['company_domain'])) || rootDomain(startupUrl || ''),
        description: description || null,
        stage,
        hq_country: hq,
        region: cleanText(pick(r, ['region', 'region_guess'])) || sourceMeta.source_region || '',
        source_key: source,
        source_id_raw: sourceIdRaw,
        source_url: sourceUrl,
        source_region: sourceMeta.source_region,
        source_category: sourceMeta.source_category,
        funding_usd: funding,
        last_round_date: lastRound,
        headcount,
        sector,
        confidence: 0.6,
        evidence_role: cleanText(pick(r, ['evidence_role'])) || '',
        signal_weight: cleanText(pick(r, ['signal_weight'])).toLowerCase() || 'low',
        investor_tier_raw: pick(r, ['investor_tier', 'investorTier', 'tier']),
        raw_signal_text: cleanText(pick(r, ['signal_text', 'description', 'summary'])),
        evidence_title: evidenceTitle || null,
        item_url: cleanText(pick(r, ['item_url', 'article_url'])) || null,
        date_captured: capturedRaw || capturedDate.toISOString(),
        signal_type: signalType,
        funding_signal: fundingSignal,
        investor_signal: investorSignal,
        hiring_signal: hiringSignal,
        has_distinct_company_website: distinctWebsite,
        _from_file: path.basename(csvPath),
      };

      if (csvPath.toLowerCase().endsWith('.jsonl')) {
        const strongMention = distinctWebsite || fundingSignal === 'present' || investorSignal === 'present' || (hiringSignal && hiringSignal !== 'none');
        if (signalType !== 'directory_listing' && !strongMention) continue;
      }

      if (!passesCoreQuality(normalized) && normalized.signal_type !== 'directory_listing') continue;
      out.push(normalized);
    }
  }

  return {
    rows: out,
    csvPath: usedFiles.join(','),
    mtime: new Date(Math.max(...usedFiles.map((p) => fs.statSync(p).mtimeMs))).toISOString(),
    filesCount: usedFiles.length,
  };
}

function toCandidate(row, idx) {
  const monthsSinceLastRound = monthsSince(row.last_round_date);
  const acceleratorRecent = hasAcceleratorSignal(row.raw_signal_text) || hasAcceleratorSignal(row.description);
  const momentumScore = Math.min(18, Math.max(4, row.description ? 12 : 7));
  const sourceMeta = resolveRegistrySource(row.source_key, row.source_url, row.source_id_raw, row.investor_tier_raw);

  const scored = scoreRaiseLikelihood({
    monthsSinceLastRound,
    momentumScore,
    acceleratorRecent,
    sourceTier: sourceMeta.source_tier,
    negativeSignal: false,
    confidence: row.confidence,
  });
  const forecast = forecastFromScore(scored.raise_likelihood_score);

  const dataQualityScore = Math.max(0, Math.min(100,
    (row.startup_url ? 30 : 0)
    + (row.description ? 20 : 0)
    + (row.hq_country && row.hq_country !== 'Unknown' ? 15 : 0)
    + (row.sector && row.sector !== 'General' ? 15 : 0)
    + (row.stage && row.stage !== 'Unknown' ? 10 : 0)
    + (row.source_url ? 10 : 0)
  ));

  const candidate = {
    id: idx + 1,
    startup_name: row.startup_name,
    startup_url: row.startup_url,
    description: row.description,
    description_summary: summarizeDescription(
      row.description,
      row.startup_name,
      row.sector,
      sourceMeta.source_name || row.source_key,
      row.signal_type || '',
      sourceMeta.source_category || row.source_category || ''
    ),
    source_summary: summarizeSource(sourceMeta.source_name || row.source_key, row.source_url),
    stage_summary: summarizeStage(row.stage),
    sector: row.sector,
    stage: row.stage,
    hq_country: row.hq_country,
    region: row.region || row.source_region || '',
    source_key: row.source_key,
    source_id: sourceMeta.source_id,
    source_name: sourceMeta.source_name,
    source_tier: sourceMeta.source_tier,
    source_category: sourceMeta.source_category,
    source_region: sourceMeta.source_region,
    source_registry_match: sourceMeta.source_registry_match,
    source_url: row.source_url,
    source_host: getHost(row.source_url || row.startup_url || ''),
    item_url: row.item_url || null,
    signal_type: row.signal_type || '',
    has_distinct_company_website: Boolean(row.has_distinct_company_website),
    funding_usd: row.funding_usd,
    last_round_date: row.last_round_date,
    months_since_last_round: monthsSinceLastRound,
    confidence: row.confidence,
    evidence_role: row.evidence_role || '',
    signal_weight: row.signal_weight || 'low',
    data_quality_score: dataQualityScore,
    last_signal_at: row.date_captured || new Date().toISOString(),
    accelerator_status: acceleratorRecent ? 'signal-detected' : null,
    accelerator_program: acceleratorRecent ? 'inferred-from-source' : null,
    forecast_6m_label: forecast.label,
    forecast_6m_probability: forecast.probability,
    ...scored,
  };

  const validation = validateCandidateRow(candidate);
  return {
    ...candidate,
    entity_class: validation.classType,
    entity_class_confidence: validation.classConfidence,
    entity_clean: validation.clean,
    validation_reasons: validation.reasons,
    validation_ok: validation.ok,
  };
}

export async function refreshLocalIngestion() {
  const { rows, csvPath, mtime, filesCount } = loadRealSourceRows();
  return {
    ingested: rows.length,
    retainedEvents: rows.length,
    sourceCsv: csvPath,
    sourceMtime: mtime,
    filesCount,
    mode: 'real_source_file',
  };
}

function classifyCandidateRow(row) {
  const name = cleanText(row.startup_name || '').toLowerCase();
  const summary = cleanText(row.description_summary || row.description || '').toLowerCase();
  const startupHost = getHost(row.startup_url || '');
  const sourceHost = getHost(row.source_url || '');
  const signalType = String(row.signal_type || '');
  const distinctWebsite = Boolean(row.has_distinct_company_website);

  if (!name) return { type: 'noise', confidence: 1, reasons: ['missing_startup_name'] };
  if (signalType === 'directory_listing') {
    if (row.source_category && !STARTUP_INVENTORY_DIRECTORY_CATEGORIES.has(String(row.source_category))) {
      return { type: 'noise', confidence: 0.94, reasons: ['directory_source_category_excluded'] };
    }
    if (
      looksLikeUiLabel(name)
      || isHardBlockedDirectoryLabel(name)
    ) {
      return { type: 'noise', confidence: 0.95, reasons: ['directory_label_looks_non_company'] };
    }
    if (isMapHost(startupHost)) return { type: 'noise', confidence: 0.96, reasons: ['directory_map_link'] };
    if (/^built in /i.test(name)) return { type: 'noise', confidence: 0.96, reasons: ['directory_source_brand_city_page'] };
    if (/\b(logo|podcast|fellowship|initiative)\b/i.test(name)) return { type: 'noise', confidence: 0.92, reasons: ['directory_branding_or_media_label'] };
    if (/\b(vc|ventures|capital|partners|partner)\b/i.test(name)) return { type: 'noise', confidence: 0.93, reasons: ['directory_investor_name'] };
    if (isInvestorOrProgramHost(startupHost)) return { type: 'noise', confidence: 0.95, reasons: ['directory_investor_or_program_host'] };
    if (isNonCompanyContentHost(startupHost)) return { type: 'noise', confidence: 0.9, reasons: ['directory_non_company_host'] };
    if (!startupHost) return { type: 'company_unverified', confidence: 0.45, reasons: ['directory_missing_host'] };
    if (isAggregatorHost(startupHost)) return { type: 'noise', confidence: 0.85, reasons: ['directory_aggregator_host'] };
    if (looksLikeArticleUrl(row.startup_url || '')) return { type: 'noise', confidence: 0.88, reasons: ['directory_article_like_url'] };
    if (!isCompanyLikeName(name)) return { type: 'noise', confidence: 0.8, reasons: ['directory_name_not_company_like'] };
    if (!startupNameMatchesUrl(row)) return { type: 'noise', confidence: 0.86, reasons: ['directory_name_url_mismatch'] };
    return { type: 'company_verified', confidence: 0.82, reasons: ['directory_listing_with_company_site'] };
  }
  if (!distinctWebsite && startupHost && sourceHost && startupHost === sourceHost) {
    return { type: 'article', confidence: 0.9, reasons: ['same_domain_mention_without_distinct_company_site'] };
  }
  if (looksLikeAddressOrGeoLabel(name)) {
    return { type: 'noise', confidence: 0.95, reasons: ['name_looks_like_geo_or_address'] };
  }
  if (looksLikeUiLabel(name) || looksLikeNewsHeadline(name) || looksLikePersonOrSentence(name)) {
    return { type: 'noise', confidence: 0.95, reasons: ['name_looks_non_company'] };
  }
  if (!isCompanyLikeName(name)) return { type: 'noise', confidence: 0.9, reasons: ['name_not_company_like'] };
  if (isNonCompanyContentHost(startupHost)) return { type: 'article', confidence: 0.9, reasons: ['non_company_host'] };
  if (isInvestorOrProgramHost(startupHost)) return { type: 'noise', confidence: 0.9, reasons: ['investor_or_program_host'] };
  if (looksLikeArticleUrl(row.startup_url || '')) return { type: 'article', confidence: 0.9, reasons: ['article_like_startup_url'] };
  if (/(discussion|opinion|newsletter|podcast|episode|guide|tutorial)/.test(name)) {
    return { type: 'article', confidence: 0.85, reasons: ['title_like_content'] };
  }
  if (summary && /(skip to|read more|subscribe|cookie policy|press release)/.test(summary)) {
    return { type: 'noise', confidence: 0.8, reasons: ['summary_navigation_artifact'] };
  }
  if (!startupHost && (sourceHost.endsWith('.edu') || /(comotion\.uw\.edu|entrepreneurship\.mit\.edu|alchemistaccelerator\.com|masschallenge\.org|500\.co|antler\.co)/.test(sourceHost))) {
    return { type: 'noise', confidence: 0.88, reasons: ['missing_company_domain_on_program_source'] };
  }
  if (/^(libraries?|calendar|directories?|resources?|about|contact|team|thesis|alumni|benefits|minister|view all( view all)?)$/i.test(name)) {
    return { type: 'noise', confidence: 0.9, reasons: ['generic_navigation_label'] };
  }
  if (/\b(corporates?\s*&\s*investors?|investors?\s*&\s*corporates?|thrive alumni|view all)\b/i.test(name)) {
    return { type: 'noise', confidence: 0.9, reasons: ['generic_audience_label'] };
  }
  if (/\binitiative\b/i.test(name)) {
    return { type: 'noise', confidence: 0.9, reasons: ['initiative_label'] };
  }
  if (/\b(i['’]?m\s+obsessed\s+with|tech\s+i['’]?m\s+obsessed\s+with)\b/i.test(name)) {
    return { type: 'article', confidence: 0.9, reasons: ['editorial_title'] };
  }

  const verificationSignals = [
    Boolean(row.startup_url),
    Boolean(startupHost && !isAggregatorHost(startupHost)),
    Boolean(row.source_registry_match),
    Boolean(row.source_tier && row.source_tier !== 'Unknown'),
    Boolean(startupNameMatchesUrl(row)),
  ].filter(Boolean).length;

  if (verificationSignals >= 4) return { type: 'company_verified', confidence: 0.9, reasons: ['strong_cross_field_consistency'] };
  if (verificationSignals >= 2) return { type: 'company_probable', confidence: 0.75, reasons: ['partial_cross_field_consistency'] };
  return { type: 'company_unverified', confidence: 0.55, reasons: ['weak_cross_field_consistency'] };
}

function validateCandidateRow(row) {
  const cls = classifyCandidateRow(row);
  const clean = !hasWeirdTextArtifacts(row.startup_name || '') && !hasWeirdTextArtifacts(row.description_summary || row.description || '');
  return {
    ok: cls.type.startsWith('company_') && clean,
    classType: cls.type,
    classConfidence: cls.confidence,
    clean,
    reasons: cls.reasons,
  };
}

function diversifyBySourceHost(rows, maxPerHost = 25) {
  const buckets = new Map();
  for (const r of rows) {
    const h = r.source_host || 'unknown';
    if (!buckets.has(h)) buckets.set(h, []);
    const bucket = buckets.get(h);
    if (bucket.length < maxPerHost) bucket.push(r);
  }

  const hosts = [...buckets.keys()].sort((a, b) => buckets.get(b).length - buckets.get(a).length);
  const out = [];
  let added = true;
  while (added) {
    added = false;
    for (const h of hosts) {
      const bucket = buckets.get(h);
      if (bucket && bucket.length) {
        out.push(bucket.shift());
        added = true;
      }
    }
  }
  return out;
}

export async function getRaiseCandidates(filters = {}) {
  const {
    likelyOnly = true,
    minScore = 60,
    stage,
    country,
    region,
    sector,
    thesisTag,
    minFunding,
    maxFunding,
    q,
    sourceTier,
    sourceId,
    sourceName,
    signalWeight,
    evidenceRole,
    page = 1,
    pageSize = 50,
    maxPerSource = 120,
    qualityScore = 30,
  } = filters;

  const { rows: sourceRows, csvPath, mtime, filesCount } = loadRealSourceRows();
  let rows = sourceRows.map((r, i) => toCandidate(r, i));
  const debugCounts = {
    initial: rows.length,
  };

  const registryStats = (() => {
    const registry = getRegistryIndex();
    const matchedRows = rows.filter((r) => r.source_registry_match).length;
    const unknownTierRows = rows.filter((r) => r.source_tier === 'Unknown').length;
    const uniqueSourceIds = new Set(rows.map((r) => r.source_id).filter(Boolean));
    const unmatchedSourceLabels = Array.from(new Set(rows.filter((r) => !r.source_registry_match).map((r) => r.source_key).filter(Boolean))).slice(0, 100);
    const classCounts = rows.reduce((acc, r) => {
      const k = r.entity_class || 'unknown';
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    return {
      registry_total_sources: registry.byId.size,
      rows_registry_matched: matchedRows,
      rows_registry_unmatched: rows.length - matchedRows,
      rows_unknown_tier: unknownTierRows,
      unique_registry_sources_seen: uniqueSourceIds.size,
      unmatched_source_labels_sample: unmatchedSourceLabels,
      entity_class_counts: classCounts,
    };
  })();

  const qScore = Math.max(0, Math.min(100, Number(qualityScore ?? 0)));

  // Always enforce structural validity (company-class rows only).
  rows = rows.filter((r) => r.validation_ok);
  debugCounts.afterValidation = rows.length;

  // Broad-recall views should retain structurally valid directory companies even when only
  // an internal listing/detail page was captured. Higher-quality views tighten this later.
  debugCounts.afterDirectoryUrl = rows.length;

  // Tie output to canonical mapped sources for normal/high quality views.
  if (qScore >= 30) {
    rows = rows
      .filter((r) => r.source_registry_match);
  }
  debugCounts.afterRegistryMatch = rows.length;

  if (likelyOnly) rows = rows.filter((r) => r.likely_raising_6m);
  debugCounts.afterLikelyOnly = rows.length;
  if (minScore) rows = rows.filter((r) => r.raise_likelihood_score >= minScore);
  debugCounts.afterMinScore = rows.length;

  // Quality policy bundles (scalable):
  // Q0-Q39: broad recall, still structurally valid + clean
  // Q40-Q79: probable/verified companies + data quality threshold
  // Q80-Q100: verified-only with strict cross-field consistency
  if (qScore >= 80) {
    const strictDataThreshold = Math.max(55, qScore - 20);
    rows = rows
      .filter((r) => r.source_registry_match)
      .filter((r) => r.entity_class === 'company_verified')
      .filter((r) => (r.entity_class_confidence || 0) >= 0.85)
      .filter((r) => (r.data_quality_score || 0) >= strictDataThreshold)
      .filter((r) => Boolean(r.startup_url))
      .filter((r) => !looksLikeArticleUrl(r.startup_url || ''))
      .filter((r) => startupNameMatchesUrl(r));
  } else if (qScore >= 40) {
    rows = rows
      .filter((r) => ['company_probable', 'company_verified'].includes(r.entity_class))
      .filter((r) => (r.data_quality_score || 0) >= qScore);
    if (qScore >= 60) {
      rows = rows
        .filter((r) => Boolean(r.startup_url))
        .filter((r) => !looksLikeArticleUrl(r.startup_url || ''))
        .filter((r) => startupNameMatchesUrl(r));
    }
  } else {
    rows = rows.filter((r) => (r.data_quality_score || 0) >= qScore);
  }
  debugCounts.afterQualityScore = rows.length;

  const facetRows = rows.slice();

  if (stage) rows = rows.filter((r) => r.stage === stage);
  debugCounts.afterStage = rows.length;
  if (country) rows = rows.filter((r) => r.hq_country === country);
  debugCounts.afterCountry = rows.length;
  if (region) rows = rows.filter((r) => (r.region || r.source_region || '') === region);
  debugCounts.afterRegion = rows.length;
  if (sector) rows = rows.filter((r) => r.sector === sector);
  debugCounts.afterSector = rows.length;
  if (thesisTag) {
    const tag = String(thesisTag).toLowerCase();
    rows = rows.filter((r) => String(r.sector || '').toLowerCase().split('|').some((part) => part.trim() === tag));
  }
  debugCounts.afterThesisTag = rows.length;
  if (sourceTier) rows = rows.filter((r) => r.source_tier === sourceTier);
  debugCounts.afterSourceTier = rows.length;
  if (sourceId) rows = rows.filter((r) => (r.source_id || '') === sourceId);
  debugCounts.afterSourceId = rows.length;
  if (sourceName) rows = rows.filter((r) => (r.source_name || '') === sourceName);
  debugCounts.afterSourceName = rows.length;
  if (signalWeight) rows = rows.filter((r) => (r.signal_weight || '') === signalWeight);
  debugCounts.afterSignalWeight = rows.length;
  if (evidenceRole) rows = rows.filter((r) => (r.evidence_role || '') === evidenceRole);
  debugCounts.afterEvidenceRole = rows.length;
  if (minFunding != null) rows = rows.filter((r) => r.funding_usd >= minFunding);
  debugCounts.afterMinFunding = rows.length;
  if (maxFunding != null) rows = rows.filter((r) => r.funding_usd <= maxFunding);
  debugCounts.afterMaxFunding = rows.length;
  if (q) {
    const term = String(q).toLowerCase();
    rows = rows.filter((r) => [r.startup_name, r.startup_url, r.description, r.sector, r.source_key, r.source_name, r.source_id].join(' ').toLowerCase().includes(term));
  }
  debugCounts.afterQuery = rows.length;

  const deduped = new Map();
  for (const r of rows) {
    const nameKey = String(r.startup_name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const hostKey = getHost(r.startup_url || '');
    const key = hostKey ? `host:${hostKey}` : `name:${nameKey}`;
    const prev = deduped.get(key);
    if (!prev) deduped.set(key, r);
    else {
      const prevScore = Number(prev.raise_likelihood_score || 0) + Number(prev.data_quality_score || 0);
      const currScore = Number(r.raise_likelihood_score || 0) + Number(r.data_quality_score || 0);
      if (currScore > prevScore) deduped.set(key, r);
    }
  }
  rows = Array.from(deduped.values());
  debugCounts.afterDedupe = rows.length;

  rows.sort((a, b) => {
    if (b.raise_likelihood_score !== a.raise_likelihood_score) return b.raise_likelihood_score - a.raise_likelihood_score;
    return new Date(b.last_signal_at).getTime() - new Date(a.last_signal_at).getTime();
  });

  const facets = {
    stages: Array.from(new Set(facetRows.map((r) => r.stage).filter(Boolean))).sort(),
    countries: Array.from(new Set(facetRows.map((r) => r.hq_country).filter(Boolean))).sort(),
    sectors: Array.from(new Set(facetRows.map((r) => r.sector).filter(Boolean))).sort(),
    sourceTiers: Array.from(new Set(facetRows.map((r) => r.source_tier).filter(Boolean))).sort(),
    sources: Array.from(new Set(facetRows.map((r) => r.source_name).filter(Boolean))).sort(),
  };

  // Scale diversity cap with quality slider so low quality can surface full volume.
  const baseMaxPerSource = Math.max(5, Number(maxPerSource) || 25);
  const adaptiveCap = qScore <= 10
    ? 10000
    : qScore <= 30
      ? Math.max(baseMaxPerSource, 400)
      : qScore <= 60
        ? Math.max(baseMaxPerSource, 220)
        : qScore <= 80
          ? Math.max(baseMaxPerSource, 140)
          : Math.max(30, Math.min(baseMaxPerSource, 90));

  rows = diversifyBySourceHost(rows, adaptiveCap);
  debugCounts.afterDiversify = rows.length;

  const total = rows.length;
  const start = (Math.max(1, page) - 1) * pageSize;
  const paged = rows.slice(start, start + pageSize);

  return {
    rows: paged,
    total,
    page,
    pageSize,
    facets,
    mode: 'real_source_file',
    stats: {
      source_rows: sourceRows.length,
      csv_path: csvPath,
      csv_files_count: filesCount,
      csv_mtime: mtime,
      debug_counts: debugCounts,
      ...registryStats,
    },
  };
}

export const __test = {
  classifyCandidateRow,
  inferCountry,
  inferCountryFromText,
  normalizeDirectorySignalName,
  summarizeDescription,
};
