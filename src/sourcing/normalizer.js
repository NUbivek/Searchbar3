const crypto = require('crypto');
const { buildFundingEnrichment, buildHiringEnrichment, buildInvestorEnrichment, buildWebsiteEnrichment } = require('./enrichment');
const { isValidCompanyName } = require('./signalSchema');
const FilterLog = require('./filterLog');
const sectorExpansion = require('../../sources/sector_expansion.json');

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

const NORMALIZER_HOST_BLOCKLIST = [
  /\.gov$/i,
  /\.edu$/i,
  /\.mil$/i,
  /linuxfoundation\.org$/i,
  /supercomputing\.org$/i,
  /defense\.gov$/i,
  /energy\.gov$/i,
  /utoronto\.ca$/i,
  /ubc\.ca$/i,
  /ucalgary\.ca$/i,
];

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

const SECTOR_MAP = {
  'Industrial AI': 'Industrial Tech',
  'Industrial SaaS': 'Industrial Tech',
  'Industrial IoT': 'Industrial Tech',
  'Industrial Software': 'Industrial Tech',
  Industrials: 'Industrial Tech',
  'Industry 4.0': 'Industrial Tech',
  'Manufacturing Tech': 'Industrial Tech',
  'Manufacturing Software': 'Industrial Tech',
  'Smart Manufacturing': 'Industrial Tech',
  'Factory Automation': 'Industrial Tech',
  'Applied AI': 'AI/ML',
  'Artificial Intelligence': 'AI/ML',
  'Machine Learning': 'AI/ML',
  'Deep Learning': 'AI/ML',
  'Generative AI': 'AI/ML',
  GenAI: 'AI/ML',
  'AI Infrastructure': 'AI/ML',
  'Supply Chain Tech': 'Supply Chain',
  'Supply Chain Software': 'Supply Chain',
  'Supply Chain AI': 'Supply Chain',
  'Supply Chain Finance': 'Supply Chain',
  'Supply Chain Management': 'Supply Chain',
  'Logistics Tech': 'Logistics',
  'Logistics Software': 'Logistics',
  'Logistics AI': 'Logistics',
  'Last Mile': 'Logistics',
  'Last Mile Delivery': 'Logistics',
  'Fleet Management': 'Logistics',
  'Freight Tech': 'Logistics',
  Freight: 'Logistics',
  'Cold Chain': 'Logistics',
  Warehousing: 'Logistics',
  'Warehouse Tech': 'Logistics',
  'Warehouse Management': 'Logistics',
  Sourcing: 'Procurement',
  'Strategic Sourcing': 'Procurement',
  'Spend Management': 'Procurement',
  'Vendor Management': 'Procurement',
  Purchasing: 'Procurement',
  Agriculture: 'Agtech',
  'Agri Tech': 'Agtech',
  'Food Tech': 'Agtech',
  Foodtech: 'Agtech',
  'Food & Agriculture': 'Agtech',
  Climate: 'Climate Tech',
  GreenTech: 'Climate Tech',
  'Green Tech': 'Climate Tech',
  'Clean Tech': 'Climate Tech',
  Cleantech: 'Climate Tech',
  'Energy Tech': 'Climate Tech',
  'Renewable Energy': 'Climate Tech',
  'Sustainability Tech': 'Climate Tech',
  SaaS: 'B2B Software',
  'Enterprise SaaS': 'B2B Software',
  'B2B SaaS': 'B2B Software',
  'Enterprise Software': 'B2B Software',
  Software: 'B2B Software',
  Platform: 'B2B Software',
  'Financial Technology': 'Fintech',
  'Trade Finance': 'Fintech',
  Payments: 'Fintech',
  'Banking Tech': 'Fintech',
  InsurTech: 'Fintech',
  Automation: 'Robotics',
  'Industrial Robotics': 'Robotics',
  'Digital Health': 'Healthcare IT',
  'Health Tech': 'Healthcare IT',
  MedTech: 'Healthcare IT',
  'Med Tech': 'Healthcare IT',
  'Construction Tech': 'Construction Tech',
  ConTech: 'Construction Tech',
  PropTech: 'Construction Tech',
  Commerce: 'Retail Tech',
  'E-Commerce': 'Retail Tech',
  eCommerce: 'Retail Tech',
  D2C: 'Retail Tech',
  DTC: 'Retail Tech',
  Retail_tech: 'Retail Tech',
  Marketplace: 'Retail Tech',
};

function normalizeSectorText(value) {
  return String(value || '').toLowerCase().trim();
}

function classifySector(row = {}) {
  const thesisSectors = Array.isArray(sectorExpansion.thesis_sectors)
    ? sectorExpansion.thesis_sectors
    : [];
  const expandedSectors = Array.isArray(sectorExpansion.expanded_sectors)
    ? sectorExpansion.expanded_sectors
    : [];
  const textParts = [
    row.description,
    row.evidence_excerpt,
    row.company_name,
    row.industry,
    row.category,
    ...(Array.isArray(row.thesis_tags) ? row.thesis_tags : []),
  ].filter(Boolean);
  const rowText = textParts.join(' ').toLowerCase();

  for (const tag of thesisSectors) {
    const normalizedTag = normalizeSectorText(tag);
    if (!normalizedTag) continue;
    if (rowText.includes(normalizedTag) || rowText.includes(normalizedTag.replace(/-/g, ' '))) {
      return {
        sector: 'thesis',
        sector_name: 'Thesis-aligned',
        thesis_match: tag,
      };
    }
  }

  const industry = normalizeSectorText(row.industry || row.category);
  for (const sector of expandedSectors) {
    const matchKeywords = Array.isArray(sector.match_keywords) ? sector.match_keywords : [];
    const matchIndustries = Array.isArray(sector.match_industries) ? sector.match_industries : [];
    if (matchKeywords.some((kw) => rowText.includes(normalizeSectorText(kw)))) {
      return { sector: sector.id, sector_name: sector.name };
    }
    if (industry && matchIndustries.some((value) => normalizeSectorText(value) === industry)) {
      return { sector: sector.id, sector_name: sector.name };
    }
  }

  const fallbackSector = sectorExpansion.classification_rules?.fallback_sector || 'EXP-TIC';
  const fallbackName = expandedSectors.find((sector) => sector.id === fallbackSector)?.name || 'Consumer, Media & Other';
  return { sector: fallbackSector, sector_name: fallbackName };
}

const CANONICAL_TAG_VALUES = new Set(Object.values(CANONICAL_TAGS));
const UI_JUNK_PATTERN = /^(load more|see more|view all|show more|read more|learn more|find out more|explore|apply now|get started|sign up|log in|login|sign in|register|subscribe|contact us|about us|our team|meet the team|news insights|job board|careers|open roles|newsletter|follow us|privacy policy|terms|cookie|back to top|scroll|menu|navigation|footer|header|general funding|impact|growth|innovation|solutions|insights|report|update|announcement|press release|blog post|case study|webinar|event|demo day|pitch deck|filters here|supply chain integrations|world positive report|open lp|substack|linkedin icon|twitter x icon|facebook icon|instagram icon|youtube icon|campus|recent investments|university (library|news))$/i;
const SOCIAL_JUNK_PATTERN = /^(twitter|x\.com|linkedin|facebook|instagram|youtube|tiktok|reddit|github|substack|medium|notion|slack|zoom|discord|telegram|whatsapp)(\s+(icon|logo|link|page|profile|handle))?$/i;
const NORMALIZER_EXACT_JUNK = new Set([
  'American Dynamism',
  'Bio Health',
  'Consumer',
  'Enterprise',
  'Infrastructure',
  'Cultural Leadership Fund',
  'Perennial',
  'Speedrun',
  'News Content',
  'Bridge the Gap to Space',
  'Decarbonise the Planet',
  'Enable the Next Technology Leap',
  'Feed 10b People',
  'Reach Humanity Scale Healthcare',
  'Supercharge Industrial Productivity',
  'For Researchers',
  'Spin-out Series',
  'Researcher Office Hour',
  'Our Advantage',
  'Venture Science',
  'Atmosphere',
  'Pitch',
  'KubeCon',
  'NeurIPS',
  'Supercomputing',
  'Microsoft Ignite',
  'AWS Re Invent',
  'Venture Capital NVentures',
]);

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

function stripNamePrefixes(name) {
  if (!name) return name;
  const PREFIX_PATTERNS = [
    /^visit\s+/i,
    /^view\s+/i,
    /^explore\s+/i,
    /^meet\s+/i,
    /^see\s+/i,
    /^go\s+to\s+/i,
    /^open\s+/i,
    /^launch\s+/i,
    /^discover\s+/i,
    /^check\s+out\s+/i,
    /^learn\s+(more\s+)?about\s+/i,
    /^read\s+(more\s+)?about\s+/i,
    /^more\s+about\s+/i,
    /^find\s+out\s+(more\s+)?about\s+/i,
    /^investing\s+in\s+/i,
    /^backed\s+by\s+/i,
    /^portfolio[:\s]+/i,
    /^company[:\s]+/i,
    /^startup[:\s]+/i,
    /^founded\s+by\s+/i,
    /^created\s+by\s+/i,
    /^built\s+by\s+/i,
    /^from\s+/i,
    /^introducing\s+/i,
    /^announcing\s+/i,
    /^meet\s+our\s+(portfolio\s+)?company\s+/i,
  ];
  let result = String(name).trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of PREFIX_PATTERNS) {
      const next = result.replace(pattern, '').trim();
      if (next !== result && next.length >= 2) {
        result = next;
        changed = true;
        break;
      }
    }
  }
  return result;
}

function createSignalId(parts) {
  const digest = crypto.createHash('sha256');
  digest.update(parts.filter(Boolean).join('::'));
  return digest.digest('hex');
}

function inferCompanyName(item) {
  return normalizeCompanyName(stripNamePrefixes(item.company_name || item.title || item.name || 'Unknown Company'));
}

function toDisplayStage(value) {
  switch (String(value || '').toLowerCase()) {
    case 'unknown': return 'Unknown';
    case 'stealth': return 'Stealth';
    case 'preseed':
    case 'pre-seed': return 'Pre-Seed';
    case 'seed': return 'Seed';
    case 'series a':
    case 'series-a':
    case 'series_a': return 'Series A';
    case 'series b':
    case 'series-b':
    case 'series_b': return 'Series B';
    case 'series c':
    case 'series-c':
    case 'series_c': return 'Series C';
    case 'series d':
    case 'series-d':
    case 'series_d':
    case 'series d+':
    case 'series-d+':
    case 'series_d+': return 'Series D+';
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
  const inventorySource = INVENTORY_SOURCE_CATEGORIES.has(String(source?.category || '').toLowerCase());
  const baseTags = inventorySource ? [] : (Array.isArray(source.thesis_tags) ? source.thesis_tags : []);
  const content = inventorySource
    ? `${item.title || ''} ${item.content || ''} ${item.snippet || ''}`.trim()
    : `${item.title || ''} ${item.content || ''} ${item.snippet || ''} ${query || ''}`.trim();
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
  return refined
    .map((tag) => SECTOR_MAP[tag] || tag)
    .filter(Boolean)
    .filter((tag, index, arr) => arr.indexOf(tag) === index)
    .slice(0, 4);
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
  name = stripNamePrefixes(name);
  if (NORMALIZER_EXACT_JUNK.has(String(name).trim())) return true;
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
  if (/^(reach|enable|build|power|drive|fuel|accelerate)\s+/i.test(name)) return true;
  if (/\b(edition|season|volume|episode|part \d)\b/i.test(name)) return true;
  if (/^[A-Z][a-z]+\s+(the|a|an|our)\s+.{10,}/i.test(name)) return true;
  if (UI_JUNK_PATTERN.test(name.trim())) return true;
  if (SOCIAL_JUNK_PATTERN.test(name.trim())) return true;
  return false;
}

function isNonStartupDomain(domain) {
  if (!domain) {
    return false;
  }

  const clean = String(domain).toLowerCase().replace(/^www\./, '');
  if (NORMALIZER_HOST_BLOCKLIST.some((pattern) => pattern.test(clean))) {
    return true;
  }
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

function looksLikeBadItemDescription(value = '') {
  const text = String(value || '').trim();
  if (!text) return true;
  if (/portfolio company focused on supply chain, logistics, agtech/i.test(text)) return true;
  if (/obituary|funeral home|cremation services/i.test(text)) return true;
  if (/rally\.tv|pluto tv|csrwire|latamlist/i.test(text)) return true;
  return false;
}

function bestItemDescription({ source, item, thesisTags }) {
  const candidates = [item.content, item.snippet, source.fetch_notes, source.notes];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const cleaned = cleanDescription(candidate, source.name, thesisTags);
    if (cleaned && !looksLikeBadItemDescription(cleaned)) return cleaned;
  }
  return cleanDescription('', source.name, thesisTags);
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

function buildNormalizedSignal({ source, item, query }) {
  const companyName = stripNamePrefixes(inferCompanyName(item));
  const itemUrl = canonicalizeUrl(item.url || item.link || '');
  const publishedAt = item.publishedAt || item.pubDate || new Date().toISOString();
  let thesisTags = cleanThesisTags(inferThesisTags({ source, item, query }));
  if (typeof item.thesis_tags === 'string') {
    thesisTags = cleanThesisTags([...(thesisTags || []), ...item.thesis_tags.split(/[,|;]/).map((tag) => tag.trim()).filter(Boolean)]);
  } else if (Array.isArray(item.thesis_tags) && item.thesis_tags.length > 0) {
    thesisTags = cleanThesisTags([...(thesisTags || []), ...item.thesis_tags]);
  }
  const sourceUrl = source.method?.url || '';
  const companyWebsite = pickExternalCompanyWebsite({ item, itemUrl, sourceUrl })
    || deriveWebsiteFromItemUrl({ itemUrl, sourceUrl });
  const companyDomain = companyDomainFromWebsite(companyWebsite) || extractDomain(companyWebsite);
  if (isNonStartupDomain(companyDomain)) {
    return {
      signal: null,
      dropReason: 'host_allowlist',
      droppedName: companyName || item.title || item.name || '',
    };
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
  const description = bestItemDescription({ source, item, thesisTags });
  thesisTags = refineSaasTag(thesisTags, description, source.name || '');
  const stage = toDisplayStage(stageGuess);
  const normalizedCompanyName = companyName;
  if (!isValidCompanyName(companyName) || isJunkName(companyName)) {
    return {
      signal: null,
      dropReason: 'blocked_names',
      droppedName: companyName || item.title || item.name || '',
    };
  }
  const classification = classifySector({
    company_name: normalizedCompanyName,
    description,
    evidence_excerpt: String(item.snippet || item.content || ''),
    thesis_tags: thesisTags,
    industry: item.industry,
    category: item.category,
  });

  return {
    signal: {
      signal_id: createSignalId([source.id, normalizedCompanyName, itemUrl, publishedAt]),
      company_name: normalizedCompanyName,
      company_website: companyWebsite,
      company_domain: companyDomain,
      description,
      sector_class: classification.sector,
      sector_name: classification.sector_name || 'Thesis-aligned',
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
    },
    dropReason: null,
  };
}

function normalizeSignal({ source, item, query }) {
  return buildNormalizedSignal({ source, item, query }).signal;
}

function normalizeSignals({ source, items, query }) {
  const log = new FilterLog();
  const validItems = Array.isArray(items) ? items.filter((item) => item && typeof item === 'object') : [];
  const results = validItems.map((item) => buildNormalizedSignal({ source, item, query }));

  const hostDropped = results.filter((entry) => entry.dropReason === 'host_allowlist');
  log.stage('host_allowlist', results.length, results.length - hostDropped.length, hostDropped.map((entry) => entry.droppedName).filter(Boolean));

  const afterHost = results.filter((entry) => entry.dropReason !== 'host_allowlist');
  const blockedNames = afterHost.filter((entry) => entry.dropReason === 'blocked_names');
  log.stage('blocked_names', afterHost.length, afterHost.length - blockedNames.length, blockedNames.map((entry) => entry.droppedName).filter(Boolean));

  const survivors = afterHost.filter((entry) => !entry.dropReason).map((entry) => entry.signal).filter(Boolean);
  log.stage('sector_classification', survivors.length, survivors.length, []);
  log.report();

  return survivors;
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
  normalizeSignals,
  classifySector,
  normalizeSignal,
};
