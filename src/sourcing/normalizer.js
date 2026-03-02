const crypto = require('crypto');

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
    .replace(/[^\w\s-]/g, '')
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

function normalizeSignal({ source, item, query }) {
  const companyName = inferCompanyName(item);
  const itemUrl = canonicalizeUrl(item.url || item.link || '');
  const publishedAt = item.publishedAt || item.pubDate || new Date().toISOString();
  const thesisTags = Array.isArray(source.thesis_tags) ? source.thesis_tags : [];
  const stageBias = Array.isArray(source.stage_bias) ? source.stage_bias : [];

  return {
    signal_id: createSignalId([source.id, companyName, itemUrl, publishedAt]),
    company_name: companyName,
    company_website: canonicalizeUrl(item.company_website || item.domain || itemUrl),
    stage_guess: stageBias[0] || 'unknown',
    thesis_tags: thesisTags,
    region_guess: source.region || 'unknown',
    signal_type: item.signal_type || 'mention',
    source_id: source.id,
    source_name: source.name,
    source_url: source.method?.url || '',
    item_url: itemUrl,
    published_at: publishedAt,
    discovered_at: new Date().toISOString(),
    evidence: {
      title: item.title || '',
      excerpt: String(item.content || item.snippet || '').slice(0, 500),
      raw_query: query || '',
    },
    confidence: typeof item.confidence === 'number' ? item.confidence : 0.5,
  };
}

module.exports = {
  canonicalizeUrl,
  createSignalId,
  normalizeCompanyName,
  normalizeSignal,
};
