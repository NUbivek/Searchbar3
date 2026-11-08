/**
 * Shared, purely extractive helpers for turning search results into cited
 * evidence. Used by the no-LLM digest (fallbackSynthesizer) and the Evidence
 * tab. Nothing here writes new claims; it only selects and labels text that
 * the sources themselves contain.
 */

const FUNDING_RE = /\b(rais(e|es|ed|ing)|funding|series [a-e]|seed|pre-seed|round|valuation|valued|investors?|led by|backed)\b/i;
const FACT_RE = /(\$|€|£)\s?\d|\d+(\.\d+)?\s?(%|percent|[mbk]\b|million|billion)|\b(arr|revenue|margin|burn|runway|customers|employees|headcount|valuation)\b/i;

// RSS footers such as "The post X appeared first on Y." or "Continue reading",
// and their French ("L’article X est apparu en premier sur Y."), German
// ("Der Beitrag X erschien zuerst auf Y.") and Spanish ("La entrada X se
// publicó primero en Y.") equivalents. A footer cut off by a feed's length
// limit ("... L’article Kabilio lève 10M€ est apparu en premier su") is
// removed too.
const FEED_BOILERPLATE = new RegExp([
  'The post .{3,300}? appeared first on [^.]{2,80}\\.?',
  "(?:L['’]article|Cet article) .{3,300}? est apparu en premier sur [^.]{2,80}\\.?",
  'Der Beitrag .{3,300}? erschien zuerst auf [^.]{2,80}\\.?',
  'La entrada .{3,300}? se publicó primero en [^.]{2,80}\\.?',
  "(?:The post|L['’]article|Cet article|Der Beitrag|La entrada) (?:(?!\\. )[^]){3,300}$",
  'Continue reading\\b.*$',
  'Read more\\b.*$',
  '\\[…\\]',
  '\\[\\.\\.\\.\\]',
  '\\[&#8230;\\]',
].join('|'), 'gi');

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
/** Web snippets sometimes arrive HTML-escaped ("&#x2F;", "&amp;"); show real characters. */
function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function cleanText(value) {
  return decodeEntities(String(value || '').replace(/<[^>]+>/g, ' ')).replace(FEED_BOILERPLATE, ' ').replace(/\s+/g, ' ').trim();
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
  decodeEntities,
  FUNDING_RE,
  FACT_RE,
  FEED_BOILERPLATE,
  cleanText,
  formatDate,
  resultDate,
  sourceLabel,
  sourceType,
  sentencesOf,
  extractMatching,
};
