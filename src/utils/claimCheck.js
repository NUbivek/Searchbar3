/**
 * Claim checking across sources (no AI model needed).
 *
 * Extracts funding and valuation figures from each source's text, groups
 * them by claim (e.g. "Series D amount", "valuation"), and reports whether
 * independent sources agree:
 *   corroborated  - 2+ different sites report the same figure (within 5%)
 *   single-source - only one site reports it
 *   conflict      - sites report different figures for the same claim
 * Every claim keeps the quoted sentence and the 1-based source numbers.
 */

const CURRENCY = { '$': 'USD', 'US$': 'USD', '€': 'EUR', '£': 'GBP', 'USD': 'USD', 'EUR': 'EUR', 'GBP': 'GBP' };
const SCALE = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12 };

const MONEY_RE = /(US\$|\$|€|£|USD|EUR|GBP)\s?(\d+(?:[.,]\d+)?)\s?(k|m|mm|mn|b|bn|t|thousand|million|billion|trillion)\b/gi;
const ROUND_RE = /\b(pre-seed|seed|series [a-h]|growth round|bridge round)\b/i;
const VALUATION_RE = /\b(valuation|valued at|values (?:it|the company)|post-money|pre-money)\b/i;
const FUNDING_RE = /\b(rais(?:e|es|ed|ing)|funding|round|investment|secures?|closes?)\b/i;

function sentencesOf(text) {
  return String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).filter((s) => s.length > 15);
}

function parseMoney(match) {
  const currency = CURRENCY[match[1].toUpperCase()] || CURRENCY[match[1]] || 'USD';
  const amount = parseFloat(match[2].replace(',', '.')) * (SCALE[match[3].toLowerCase()] || 1);
  return { currency, amount };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return String(url || '');
  }
}

export function formatAmount({ amount, currency }) {
  const symbol = { USD: '$', EUR: '€', GBP: '£' }[currency] || `${currency} `;
  if (amount >= 1e9) return `${symbol}${+(amount / 1e9).toFixed(2)}B`;
  if (amount >= 1e6) return `${symbol}${+(amount / 1e6).toFixed(1)}M`;
  if (amount >= 1e3) return `${symbol}${+(amount / 1e3).toFixed(0)}K`;
  return `${symbol}${amount}`;
}

/** Extract figure claims from one result. */
export function extractClaims(result, sourceNumber) {
  const claims = [];
  const text = `${result.title || ''}. ${result.content || result.snippet || ''}`;
  for (const sentence of sentencesOf(text)) {
    const monies = [...sentence.matchAll(MONEY_RE)];
    if (monies.length === 0) continue;
    const round = (sentence.match(ROUND_RE) || [])[1];
    const isValuation = VALUATION_RE.test(sentence);
    const isFunding = FUNDING_RE.test(sentence);
    monies.forEach((m) => {
      const money = parseMoney(m);
      // Money right after "valuation of"/"valued at" is the valuation;
      // otherwise the first amount in a funding sentence is the raise.
      const before = sentence.slice(Math.max(0, m.index - 40), m.index);
      const kind = VALUATION_RE.test(before) || (isValuation && !isFunding) ? 'valuation' : isFunding ? 'raise' : null;
      if (!kind) return;
      claims.push({
        key: kind === 'valuation' ? 'valuation' : `raise:${(round || 'unspecified').toLowerCase()}`,
        label: kind === 'valuation' ? 'Valuation' : `${round ? round.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Funding'} amount`,
        ...money,
        quote: sentence.trim(),
        source: sourceNumber,
        site: hostOf(result.url || result.link),
      });
    });
  }
  return claims;
}

/**
 * @param {Array} results search results in display order (source n = index+1)
 * @returns {{ claims: Array, summary: { corroborated, singleSource, conflicts } }}
 */
export function checkClaims(results = []) {
  const all = results.flatMap((r, i) => extractClaims(r, i + 1));
  // A raise with no round named ("Mistral raises €3B") that matches the
  // amount of a named round ("€3 billion in a Series D") is the same claim.
  const named = all.filter((c) => c.key.startsWith('raise:') && c.key !== 'raise:unspecified');
  for (const c of all) {
    if (c.key !== 'raise:unspecified') continue;
    const match = named.find((n) => n.currency === c.currency && Math.abs(n.amount - c.amount) / Math.max(n.amount, c.amount) <= 0.05);
    if (match) { c.key = match.key; c.label = match.label; }
  }
  const groups = new Map();
  for (const c of all) {
    // Different currencies are different claims (no FX guessing)
    const key = `${c.key}|${c.currency}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  const claims = [];
  for (const items of groups.values()) {
    // Cluster figures that agree within 5%
    const clusters = [];
    for (const c of items) {
      const hit = clusters.find((cl) => Math.abs(cl.amount - c.amount) / Math.max(cl.amount, c.amount) <= 0.05);
      if (hit) hit.items.push(c);
      else clusters.push({ amount: c.amount, items: [c] });
    }
    clusters.sort((a, b) => new Set(b.items.map((i) => i.site)).size - new Set(a.items.map((i) => i.site)).size);
    const top = clusters[0];
    const sites = new Set(top.items.map((i) => i.site));
    const status = clusters.length > 1 ? 'conflict' : sites.size >= 2 ? 'corroborated' : 'single-source';
    claims.push({
      label: items[0].label,
      value: formatAmount({ amount: top.amount, currency: items[0].currency }),
      status,
      sources: [...new Set(top.items.map((i) => i.source))],
      quote: top.items[0].quote,
      alternatives: clusters.slice(1).map((cl) => ({
        value: formatAmount({ amount: cl.amount, currency: items[0].currency }),
        sources: [...new Set(cl.items.map((i) => i.source))],
        quote: cl.items[0].quote,
      })),
    });
  }

  // Attach readable references (title + link) for each cited source number
  const ref = (n) => {
    const r = results[n - 1] || {};
    return { n, title: r.title || hostOf(r.url || r.link), url: r.url || r.link || null, site: hostOf(r.url || r.link) };
  };
  for (const claim of claims) {
    claim.sourceRefs = claim.sources.map(ref);
    claim.alternatives.forEach((alt) => { alt.sourceRefs = alt.sources.map(ref); });
  }

  const order = { conflict: 0, corroborated: 1, 'single-source': 2 };
  claims.sort((a, b) => order[a.status] - order[b.status]);
  return {
    claims,
    summary: {
      corroborated: claims.filter((c) => c.status === 'corroborated').length,
      singleSource: claims.filter((c) => c.status === 'single-source').length,
      conflicts: claims.filter((c) => c.status === 'conflict').length,
    },
  };
}
