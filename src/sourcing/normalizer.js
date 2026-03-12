const crypto = require('crypto');
const { buildFundingEnrichment, buildHiringEnrichment, buildInvestorEnrichment, buildWebsiteEnrichment } = require('./enrichment');
const { isValidCompanyName } = require('./signalSchema');

const STAGE_PATTERNS = [
  { stage: 'pre-seed', pattern: /\bpre[\s-]?seed\b/i },
  { stage: 'seed', pattern: /\bseed\b/i },
  { stage: 'series_a', pattern: /\bseries\s+a\b/i },
  { stage: 'series_b', pattern: /\bseries\s+b\b/i },
  { stage: 'series_c', pattern: /\bseries\s+c\b/i },
  { stage: 'growth', pattern: /\bgrowth\b|\bseries\s+d\b|\bseries\s+e\b/i },
];

const THESIS_RULES = [
  { tag: 'ai', pattern: /\b(ai|artificial intelligence|llm|machine learning)\b/i },
  { tag: 'developer_tools', pattern: /\b(api|sdk|developer|devtool|infrastructure)\b/i },
  { tag: 'fintech', pattern: /\b(fintech|payments|banking|lending|credit)\b/i },
  { tag: 'logistics', pattern: /\b(logistics|supply chain|warehouse|freight)\b/i },
  { tag: 'marketplaces', pattern: /\b(marketplace|buyers and sellers|two-sided)\b/i },
  { tag: 'healthcare', pattern: /\b(healthcare|clinical|medical|patient)\b/i },
  { tag: 'security', pattern: /\b(security|identity|fraud|cybersecurity)\b/i },
];

const TIER_WEIGHTS = {
  A: 1,
  B: 0.9,
  C: 0.8,
};

const INVENTORY_SOURCE_CATEGORIES = new Set([
  'venture_portfolio',
  'accelerator_portfolio',
  'startup_database',
  'university_accelerator',
  'accelerator_directory',
  'conference',
]);

const SOCIAL_HOST_PATTERNS = [
  /linkedin\.com$/i,
  /(^|\.)x\.com$/i,
  /twitter\.com$/i,
  /instagram\.com$/i,
  /youtube\.com$/i,
  /facebook\.com$/i,
];

const NON_STARTUP_DOMAINS = new Set([
  'huffingtonpost.com', 'huffpost.com', 'forbes.com', 'techcrunch.com',
  'businessinsider.com', 'reuters.com', 'bloomberg.com', 'ft.com',
  'wsj.com', 'nytimes.com', 'theguardian.com', 'economist.com',
  'wired.com', 'venturebeat.com', 'inc.com', 'fastcompany.com',
  'fortune.com', 'cnbc.com', 'cnn.com', 'bbc.com', 'bbc.co.uk',
  'medium.com', 'substack.com', 'substackcdn.com',
  'indeed.com', 'glassdoor.com', 'linkedin.com', 'ziprecruiter.com',
  'monster.com', 'careerbuilder.com', 'lever.co', 'greenhouse.io',
  'workable.com', 'jobs.lever.co', 'boards.greenhouse.io',
  'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
  'youtube.com', 'tiktok.com', 'reddit.com', 'pinterest.com',
  'scholar.google.com', 'arxiv.org', 'ssrn.com', 'researchgate.net',
  'github.com', 'gitlab.com', 'producthunt.com', 'angellist.com',
  'crunchbase.com', 'pitchbook.com', 'dealroom.co',
  'eventbrite.com', 'meetup.com', 'zoom.us', 'calendly.com',
]);

const REGION_MAP = {
  AU: 'AU',
  Australia: 'AU',
  AUSTRALIA: 'AU',
  NZ: 'AU/NZ',
  'New Zealand': 'AU/NZ',
  'AU/NZ': 'AU/NZ',
  EU: 'EU',
  Europe: 'EU',
  EUROPE: 'EU',
  EU_GLOBAL: 'EU',
  EU_US_GLOBAL: 'EU',
  IL: 'IL',
  Israel: 'IL',
  ISRAEL: 'IL',
  IL_US: 'IL',
  US_EU: 'US',
  US: 'US',
  'United States': 'US',
  US_GLOBAL: 'US',
  GLOBAL: 'GLOBAL',
  Global: 'GLOBAL',
};

const CANONICAL_TAGS = {
  supply_chain: 'Supply Chain',
  'supply chain': 'Supply Chain',
  logistics: 'Logistics',
  last_mile: 'Last Mile',
  'last mile': 'Last Mile',
  first_mile: 'First Mile',
  middle_mile: 'Middle Mile',
  freight: 'Freight',
  cold_chain: 'Cold Chain',
  'cold chain': 'Cold Chain',
  warehouse: 'Warehousing',
  warehousing: 'Warehousing',
  fulfillment: 'Fulfillment',
  inventory: 'Inventory',
  routing: 'Routing',
  fleet: 'Fleet Ops',
  cargo: 'Cargo',
  trade_management: 'Trade Mgmt',
  manufacturing: 'Manufacturing',
  industrial: 'Industrial',
  industrial_software: 'Industrial SaaS',
  factory_operations: 'Factory Ops',
  factory_robotics: 'Factory Robotics',
  robotics: 'Robotics',
  automation: 'Automation',
  industrial_iot: 'Industrial IoT',
  iot: 'Industrial IoT',
  digital_twin: 'Digital Twin',
  predictive_maintenance: 'Predictive Maint.',
  industrial_ai: 'Industrial AI',
  'industrial-ai': 'Industrial AI',
  deep_tech: 'Deep Tech',
  agtech: 'Agtech',
  food_supply: 'Food Supply',
  'food supply': 'Food Supply',
  food_safety: 'Food Safety',
  precision_agriculture: 'Precision Ag',
  agbio: 'Agbio',
  procurement: 'Procurement',
  trade_finance: 'Trade Finance',
  'trade finance': 'Trade Finance',
  b2b_payments: 'B2B Payments',
  'b2b payments': 'B2B Payments',
  b2b: 'B2B',
  b2b_ops: 'B2B Ops',
  fintech: 'Fintech',
  supply_demand_planning: 'Demand Planning',
  demand_forecasting: 'Demand Planning',
  retail: 'Retail Tech',
  retail_tech: 'Retail Tech',
  'retail tech': 'Retail Tech',
  marketplace: 'Marketplace',
  commerce: 'Commerce',
  d2c: 'D2C',
  ecommerce: 'Ecommerce',
  ai: 'AI/ML',
  ml: 'AI/ML',
  applied_ai: 'Applied AI',
  supply_chain_ai: 'Supply Chain AI',
  enterprise_saas: 'Enterprise SaaS',
  'enterprise saas': 'Enterprise SaaS',
  software: 'SaaS',
  saas: 'SaaS',
  developer_tools: 'Dev Tools',
  mobility: 'Mobility',
  defense: 'Defense Tech',
  energy: 'Energy',
  biotech: 'Biotech',
  hardware: 'Hardware',
  security: 'Security',
  healthcare: 'Healthcare',
  impact: 'Impact',
  sustainability: 'Sustainability',
  climate: 'Climate Tech',
};

const CANONICAL_TAG_VALUES = new Set(Object.values(CANONICAL_TAGS));
const UI_JUNK_PATTERN = /^(load more|see more|view all|show more|read more|learn more|find out more|explore|apply now|get started|sign up|log in|login|sign in|register|subscribe|contact us|about us|our team|meet the team|news insights|job board|careers|open roles|newsletter|follow us|privacy policy|terms|cookie|back to top|scroll|menu|navigation|footer|header|general funding|impact|growth|innovation|solutions|insights|report|update|announcement|press release|blog post|case study|webinar|event|demo day|pitch deck|filters here|supply chain integrations|world positive report|open lp|substack|linkedin icon|twitter x icon|facebook icon|instagram icon|youtube icon|campus|recent investments|university (library|news))$/i;
const SOCIAL_JUNK_PATTERN = /^(twitter|x\.com|linkedin|facebook|instagram|youtube|tiktok|reddit|github|substack|medium|notion|slack|zoom|discord|telegram|whatsapp)(\s+(icon|logo|link|page|profile|handle))?$/i;

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function canonicalizeUrl(value) {
  if (!value) {
    return '';
  }

  try {
    const parsed = new URL(value);
    parsed.hash = '';

    const blockedParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref'];
    for (const param of blockedParams) {
      parsed.searchParams.delete(param);
    }

    const pathname = parsed.pathname.endsWith('/') && parsed.pathname !== '/'
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname;

    parsed.pathname = pathname;
    return parsed.toString();
  } catch (error) {
    return value;
  }
}

function getHost(value) {
  if (!value) {
    return '';
  }

  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function rootDomain(value) {
  const host = getHost(value);
  if (!host) {
    return '';
  }

  const parts = host.split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

function normalizeCompanyName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\b(inc|incorporated|llc|ltd|corp|corporation|co)\b\.?/gi, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripVisitPrefix(value) {
  return String(value || '').replace(/^Visit\s+/i, '').trim();
}

function createSignalId(parts) {
  const digest = crypto.createHash('sha256');
  digest.update(parts.filter(Boolean).join('::'));
  return digest.digest('hex');
}

function inferCompanyName(item) {
  return normalizeCompanyName(stripVisitPrefix(item.company_name || item.title || item.name || 'Unknown Company'));
}

function toDisplayStage(value) {
  switch (String(value || '').toLowerCase()) {
    case 'stealth': return 'Stealth';
    case 'pre-seed': return 'Pre-Seed';
    case 'seed': return 'Seed';
    case 'series_a': return 'Series A';
    case 'series_b': return 'Series B';
    case 'series_c': return 'Series C';
    default: return 'Unknown';
  }
}

function inferStageGuess({ source, item }) {
  const content = `${item.title || ''} ${item.content || ''} ${item.snippet || ''}`.trim();

  for (const entry of STAGE_PATTERNS) {
    if (entry.pattern.test(content)) {
      return entry.stage;
    }
  }

  const stageBias = Array.isArray(source.stage_bias) ? source.stage_bias : [];
  return stageBias[0] || 'unknown';
}

function inferThesisTags({ source, item, query }) {
  const baseTags = Array.isArray(source.thesis_tags) ? source.thesis_tags : [];
  const content = `${item.title || ''} ${item.content || ''} ${item.snippet || ''} ${query || ''}`.trim();
  const inferredTags = THESIS_RULES
    .filter((entry) => entry.pattern.test(content))
    .map((entry) => entry.tag);

  return cleanThesisTags(Array.from(new Set([...baseTags, ...inferredTags])));
}

function computeConfidence({ source }) {
  const hasExplicitExtract = Boolean(source?.method?.extract);
  const inventorySource = INVENTORY_SOURCE_CATEGORIES.has(String(source?.category || '').toLowerCase());

  if (hasExplicitExtract) {
    return { confidence: 0.85, components: { confidence_mode: 'explicit_extract' } };
  }

  if (inventorySource) {
    return { confidence: 0.7, components: { confidence_mode: 'inventory_source' } };
  }

  return { confidence: 0.55, components: { confidence_mode: 'generic_dom_fallback' } };
}

function pickExternalCompanyWebsite({ item, itemUrl, sourceUrl }) {
  const candidate = canonicalizeUrl(item.company_website || item.domain || '');
  if (!candidate) {
    return null;
  }

  const candidateRoot = rootDomain(candidate);
  const sourceRoot = rootDomain(sourceUrl);
  const host = getHost(candidate);

  if (!candidateRoot || !host) {
    return null;
  }

  if (candidateRoot === sourceRoot) {
    return null;
  }

  if (SOCIAL_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    return null;
  }

  return candidate;
}

function companyDomainFromWebsite(companyWebsite) {
  const host = getHost(companyWebsite || '');
  return host || '';
}

function extractDomain(url) {
  if (!url) {
    return '';
  }

  try {
    const parsed = new URL(String(url).startsWith('http') ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function normalizeRegion(raw) {
  if (!raw) {
    return 'GLOBAL';
  }

  const value = String(raw).trim();
  return REGION_MAP[value] || value;
}

function cleanThesisTags(raw) {
  if (!raw) {
    return [];
  }

  let parts = Array.isArray(raw) ? raw : [];
  if (typeof raw === 'string') {
    parts = raw.split(/[|,;]+/).map((s) => s.trim()).filter(Boolean);
  }

  const seen = new Set();
  const result = [];
  for (const part of parts) {
    const trimmed = String(part).trim();
    if (CANONICAL_TAG_VALUES.has(trimmed) && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
      continue;
    }
    const key = trimmed.toLowerCase().replace(/[-\s]+/g, '_');
    const label = CANONICAL_TAGS[key] || CANONICAL_TAGS[trimmed.toLowerCase()] || null;
    if (label && !seen.has(label)) {
      seen.add(label);
      result.push(label);
    }
  }

  const refined = refineSaasTag(result);
  return refined.slice(0, 4);
}

function refineSaasTag(tags, description = '', sourceName = '') {
  const normalizedTags = Array.isArray(tags) ? tags.filter(Boolean) : [];
  const saasLike = /^(saas|enterprise saas|b2b saas|software|platform)$/i;
  const hasSaasOnly = normalizedTags.length > 0 && normalizedTags.every((tag) => saasLike.test(tag));

  if (!hasSaasOnly) {
    return normalizedTags.filter((tag) => !saasLike.test(tag));
  }

  const haystack = `${description || ''} ${sourceName || ''}`.toLowerCase();
  if (/supply.?chain|logistics|freight|warehouse|inventory|fulfillment|last.?mile|cold.?chain/i.test(haystack)) return ['Supply Chain'];
  if (/manufactur|factory|industrial|production|ops/i.test(haystack)) return ['Manufacturing'];
  if (/agri|farm|crop|food.?tech|agriculture/i.test(haystack)) return ['Agtech'];
  if (/fintech|payment|bank|finance|lending|insurance/i.test(haystack)) return ['Fintech'];
  if (/health|medic|clinical|pharma|biotech/i.test(haystack)) return ['Healthcare'];
  if (/energy|climate|carbon|sustainability|green/i.test(haystack)) return ['Climate Tech'];
  if (/robot|automat|ai|machine.?learn|deep.?learn/i.test(haystack)) return ['AI/ML'];
  if (/retail|commerce|d2c|consumer/i.test(haystack)) return ['Retail Tech'];
  if (/security|cyber|defense/i.test(haystack)) return ['Security'];
  if (/procure|spend|vendor|source|b2b/i.test(haystack)) return ['Procurement'];
  return ['B2B Software'];
}

function isJunkName(name) {
  name = stripVisitPrefix(name);
  if (!name || name.length < 2 || name.length > 80) return true;
  if (/^\+?[\d\s\-().]{7,}$/.test(name)) return true;
  if (/^[a-z0-9._%+-]+@/i.test(name)) return true;
  if (/^(info|admin|contact|hello|team|support|noreply|careers)([._-]?[a-z0-9_-]{3,})?$/i.test(name)) return true;
  if (/\b(icon|logo|image|img|svg|png|jpg|banner|thumbnail|avatar|badge)\b/i.test(name)) return true;
  if (/\b(opens external site|click here|see details|see domain|visit campus|directions)\b/i.test(name)) return true;
  if (name === name.toUpperCase() && /\s/.test(name) && name.length > 4 && !/^(AI|ML|B2B|IoT|API|SaaS|ERP|WMS|TMS|YC)$/.test(name)) return true;
  if (/[—:\-–]\s*$/.test(name)) return true;
  if (!/[a-zA-Z]{2,}/.test(name)) return true;
  if (/\b(launches?|raises?|acquires?|announces?|partners with|wins|selected|named)\b/i.test(name)) return true;
  if (/\(acquired by|acquired by\s|merger with/i.test(name)) return true;
  if (/\b(health center|medical center|student center|care center)\b/i.test(name)) return true;
  if (/^(visit campus|click here|see details|see domain|energy transition|security advisor|faculty advisors|flagship program|our accelerators|sell on etsy)$/i.test(String(name).trim())) return true;
  if (UI_JUNK_PATTERN.test(name.trim())) return true;
  if (SOCIAL_JUNK_PATTERN.test(name.trim())) return true;
  return false;
}

function isNonStartupDomain(domain) {
  if (!domain) {
    return false;
  }

  const clean = String(domain).toLowerCase().replace(/^www\./, '');
  if (NON_STARTUP_DOMAINS.has(clean)) {
    return true;
  }

  for (const blocked of NON_STARTUP_DOMAINS) {
    if (clean.endsWith(`.${blocked}`)) {
      return true;
    }
  }

  return false;
}

function deriveWebsiteFromItemUrl({ itemUrl, sourceUrl }) {
  const candidate = canonicalizeUrl(itemUrl || '');
  if (!candidate) {
    return '';
  }

  const candidateRoot = rootDomain(candidate);
  const sourceRoot = rootDomain(sourceUrl || '');
  const host = getHost(candidate);
  if (!candidateRoot || !host) {
    return '';
  }

  if (candidateRoot === sourceRoot) {
    return '';
  }

  if (SOCIAL_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    return '';
  }

  return candidate;
}

function sourceGroundedDescription({ source, thesisTags }) {
  const rawNotes = String(source.fetch_notes || source.notes || '').trim();
  return cleanDescription(rawNotes, source.name, thesisTags);
}

function buildDescription(sourceName, thesisTags) {
  const name = String(sourceName || 'portfolio')
    .replace(/\s*\(.*?\)/g, '')
    .trim() || 'portfolio';
  const tags = Array.isArray(thesisTags) && thesisTags.length > 0
    ? thesisTags.slice(0, 3).join(', ')
    : '';
  return tags
    ? `${name} portfolio company. Focus: ${tags}.`
    : `${name} portfolio company.`;
}

function cleanDescription(raw, sourceName, thesisTags) {
  const fallback = buildDescription(sourceName, thesisTags);
  if (!raw) {
    return fallback;
  }

  const value = String(raw).trim();
  if (!value) {
    return fallback;
  }

  if (/scrape|crawl|fetch|html|css selector|adapter|alumni\/news/i.test(value)) {
    return fallback;
  }

  if (/large portfolio;|sector tags:\s|multiple sectors;|filter for /i.test(value)) {
    return fallback;
  }

  const commaRatio = ((value.match(/,/g) || []).length) / Math.max(value.length, 1);
  if (commaRatio > 0.08) {
    return fallback;
  }

  if (/^([a-z][a-z\-]+(,\s*[a-z][a-z\-]+){4,})/i.test(value)) {
    return fallback;
  }

  if (/sector tags:\s/i.test(value)) {
    return fallback;
  }

  if (value.length <= 200) {
    return value;
  }

  const boundary = value.lastIndexOf('.', 200);
  const truncated = boundary > 0 ? value.slice(0, boundary + 1) : value.slice(0, 200);
  return truncated.trim() || fallback;
}

function normalizeSignalWeight(value) {
  const normalized = String(value || '').toLowerCase();
  if (['high', 'medium', 'low'].includes(normalized)) {
    return normalized;
  }
  return 'low';
}

function normalizeSignal({ source, item, query }) {
  const companyName = stripVisitPrefix(inferCompanyName(item));
  const itemUrl = canonicalizeUrl(item.url || item.link || '');
  const publishedAt = item.publishedAt || item.pubDate || new Date().toISOString();
  let thesisTags = cleanThesisTags(inferThesisTags({ source, item, query }));
  const sourceUrl = source.method?.url || '';
  const companyWebsite = pickExternalCompanyWebsite({ item, itemUrl, sourceUrl })
    || deriveWebsiteFromItemUrl({ itemUrl, sourceUrl });
  const companyDomain = companyDomainFromWebsite(companyWebsite) || extractDomain(companyWebsite);
  if (isNonStartupDomain(companyDomain)) {
    return null;
  }
  const stageGuess = inferStageGuess({ source, item });
  const enrichment = buildWebsiteEnrichment({
    companyWebsite: companyWebsite || '',
    itemUrl,
    sourceUrl,
  });
  const hiringEnrichment = buildHiringEnrichment({ item });
  const fundingEnrichment = buildFundingEnrichment({ item });
  const investorEnrichment = buildInvestorEnrichment({ item });
  const scoring = computeConfidence({
    source,
  });
  const description = sourceGroundedDescription({ source, thesisTags });
  thesisTags = refineSaasTag(thesisTags, description, source.name || '');
  const stage = toDisplayStage(stageGuess);
  const normalizedCompanyName = isValidCompanyName(companyName) && !isJunkName(companyName) ? companyName : '';

  return {
    signal_id: createSignalId([source.id, normalizedCompanyName, itemUrl, publishedAt]),
    company_name: normalizedCompanyName,
    company_website: companyWebsite,
    company_domain: companyDomain,
    description,
    stage,
    stage_guess: stageGuess,
    thesis_tags: thesisTags,
    region: normalizeRegion(source.region || ''),
    region_guess: normalizeRegion(source.region || 'GLOBAL'),
    signal_type: item.signal_type || 'mention',
    source_id: source.id,
    source_name: source.name,
    evidence_role: source.evidence_role || '',
    signal_weight: normalizeSignalWeight(source.signal_weight),
    source_url: sourceUrl,
    item_url: itemUrl,
    published_at: publishedAt,
    discovered_at: new Date().toISOString(),
    evidence: {
      title: item.title || '',
      excerpt: String(item.content || item.snippet || '').slice(0, 500),
      raw_query: query || '',
    },
    confidence: scoring.confidence,
    score_components: scoring.components,
    enrichment: {
      ...enrichment,
      ...fundingEnrichment,
      ...hiringEnrichment,
      ...investorEnrichment,
    },
  };
}

module.exports = {
  buildDescription,
  canonicalizeUrl,
  cleanDescription,
  createSignalId,
  extractDomain,
  inferStageGuess,
  inferThesisTags,
  isNonStartupDomain,
  isJunkName,
  normalizeCompanyName,
  cleanThesisTags,
  normalizeRegion,
  normalizeSignal,
};
