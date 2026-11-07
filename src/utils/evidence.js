/**
 * Shared, purely extractive helpers for turning search results into cited
 * evidence. Used by the no-LLM digest (fallbackSynthesizer) and the Evidence
 * tab. Nothing here writes new claims; it only selects and labels text that
 * the sources themselves contain.
 */

const FUNDING_RE = /\b(rais(e|es|ed|ing)|funding|series [a-e]|seed|pre-seed|round|valuation|valued|investors?|led by|backed)\b/i;
const FACT_RE = /(\$|€|£)\s?\d|\d+(\.\d+)?\s?(%|percent|[mbk]\b|million|billion)|\b(arr|revenue|margin|burn|runway|customers|employees|headcount|valuation)\b/i;

function cleanText(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatDate(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
}

function resultDate(result) {
  return formatDate(result?.publishedAt || result?.date || result?.timestamp);
}

function sourceLabel(result) {
  if (result?.source === 'file') return `uploaded file ${String(result.title || '').replace(/^File Source:\s*/, '')}`.trim();
  if (result?.sourceName) return String(result.sourceName).replace(/\s+(Feed|RSS)$/i, '');
  try {
    return new URL(result.url || result.link).hostname.replace(/^www\./, '');
  } catch {
    return result?.source || 'Source';
  }
}

/** Human-readable evidence type, so readers can weigh a source. */
function sourceType(result) {
  if (result?.type === 'portfolio_listing') return 'Investor portfolio';
  if (result?.source === 'curated') return 'Curated news / analysis';
  if (result?.source === 'file') return 'Uploaded document';
  if (result?.source === 'custom') return 'Your URL';
  if (result?.source === 'hackernews') return 'Hacker News';
  if (['fmp', 'sec', 'edgar'].includes(result?.source)) return 'Public filing / market data';
  if (result?.source === 'web') return 'Web';
  return result?.source ? String(result.source) : 'Web';
}

function sentencesOf(result) {
  return cleanText(result?.snippet || result?.content || result?.description)
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.length >= 20 && s.length <= 400);
}

/**
 * Sentences matching `pattern`, each tagged with the result it came from.
 * @returns {Array<{ sentence, index, result }>}
 */
function extractMatching(results, pattern, limit = 8) {
  const out = [];
  const seen = new Set();
  (results || []).forEach((result, index) => {
    for (const sentence of sentencesOf(result)) {
      const key = sentence.toLowerCase();
      if (pattern.test(sentence) && !seen.has(key)) {
        seen.add(key);
        out.push({ sentence, index, result });
      }
    }
  });
  return out.slice(0, limit);
}

module.exports = {
  FUNDING_RE,
  FACT_RE,
  cleanText,
  formatDate,
  resultDate,
  sourceLabel,
  sourceType,
  sentencesOf,
  extractMatching,
};
