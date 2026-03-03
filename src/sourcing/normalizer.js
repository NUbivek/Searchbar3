const crypto = require('crypto');
const { buildHiringEnrichment, buildWebsiteEnrichment } = require('./enrichment');

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

function computeConfidence({ source, item, query, companyWebsite }) {
  const baseConfidence = typeof item.confidence === 'number' ? item.confidence : 0.5;
  const tierWeight = TIER_WEIGHTS[source.cadence?.tier] || 0.75;
  const titleAndContent = `${item.title || ''} ${item.content || ''} ${item.snippet || ''}`.toLowerCase();
  const queryTerms = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const matchedTerms = queryTerms.filter((term) => term.length > 2 && titleAndContent.includes(term));
  const queryBoost = queryTerms.length > 0
    ? matchedTerms.length / queryTerms.length
    : 0;
  const websiteBoost = companyWebsite ? 1 : 0;

  const weightedScore = (
    baseConfidence * 0.6 +
    tierWeight * 0.2 +
    queryBoost * 0.1 +
    websiteBoost * 0.1
  );

  return {
    confidence: Number(clamp(weightedScore).toFixed(3)),
    components: {
      base_confidence: Number(baseConfidence.toFixed(3)),
      source_tier_weight: Number(tierWeight.toFixed(3)),
      query_match_ratio: Number(queryBoost.toFixed(3)),
      website_present: Boolean(companyWebsite),
    },
  };
}

function normalizeSignal({ source, item, query }) {
  const companyName = inferCompanyName(item);
  const itemUrl = canonicalizeUrl(item.url || item.link || '');
  const publishedAt = item.publishedAt || item.pubDate || new Date().toISOString();
  const thesisTags = inferThesisTags({ source, item, query });
  const companyWebsite = canonicalizeUrl(item.company_website || item.domain || itemUrl);
  const stageGuess = inferStageGuess({ source, item });
  const sourceUrl = source.method?.url || '';
  const enrichment = buildWebsiteEnrichment({
    companyWebsite,
    itemUrl,
    sourceUrl,
  });
  const hiringEnrichment = buildHiringEnrichment({ item });
  const scoring = computeConfidence({
    source,
    item,
    query,
    companyWebsite,
  });

  return {
    signal_id: createSignalId([source.id, companyName, itemUrl, publishedAt]),
    company_name: companyName,
    company_website: companyWebsite,
    stage_guess: stageGuess,
    thesis_tags: thesisTags,
    region_guess: source.region || 'unknown',
    signal_type: item.signal_type || 'mention',
    source_id: source.id,
    source_name: source.name,
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
      ...hiringEnrichment,
    },
  };
}

module.exports = {
  canonicalizeUrl,
  createSignalId,
  inferStageGuess,
  inferThesisTags,
  normalizeCompanyName,
  normalizeSignal,
};
