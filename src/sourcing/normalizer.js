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

function createSignalId(parts) {
  const digest = crypto.createHash('sha256');
  digest.update(parts.filter(Boolean).join('::'));
  return digest.digest('hex');
}

function inferCompanyName(item) {
  return normalizeCompanyName(item.company_name || item.title || item.name || 'Unknown Company');
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

  return Array.from(new Set([...baseTags, ...inferredTags]));
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
  if (
    rawNotes
    && rawNotes.length >= 20
    && !/adapter_original:|disabled pending|aliased to html_list/i.test(rawNotes)
  ) {
    return rawNotes.slice(0, 300);
  }

  const tags = thesisTags.length > 0 ? thesisTags.join(', ') : 'none';
  return `${source.name} portfolio company. Sector tags: ${tags}.`.slice(0, 300);
}

function normalizeSignalWeight(value) {
  const normalized = String(value || '').toLowerCase();
  if (['high', 'medium', 'low'].includes(normalized)) {
    return normalized;
  }
  return 'low';
}

function normalizeSignal({ source, item, query }) {
  const companyName = inferCompanyName(item);
  const itemUrl = canonicalizeUrl(item.url || item.link || '');
  const publishedAt = item.publishedAt || item.pubDate || new Date().toISOString();
  const thesisTags = inferThesisTags({ source, item, query });
  const sourceUrl = source.method?.url || '';
  const companyWebsite = pickExternalCompanyWebsite({ item, itemUrl, sourceUrl })
    || deriveWebsiteFromItemUrl({ itemUrl, sourceUrl });
  const companyDomain = companyDomainFromWebsite(companyWebsite) || extractDomain(companyWebsite);
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
  const stage = toDisplayStage(stageGuess);
  const normalizedCompanyName = isValidCompanyName(companyName) ? companyName : '';

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
  canonicalizeUrl,
  createSignalId,
  extractDomain,
  inferStageGuess,
  inferThesisTags,
  normalizeCompanyName,
  normalizeRegion,
  normalizeSignal,
};
