/**
 * Curated source index: searches the sources in sources/registry.json
 * (VC/accelerator portfolio pages, funding and startup news, market analysis
 * feeds) directly, with no search API key.
 *
 * Most diligence targets are private companies with no SEC filings, so the
 * curated registry is the primary evidence base: who invested (portfolio
 * pages), funding announcements and press (news feeds), and market context.
 *
 * Fetching ~780 sources per query is too slow, so items are kept in an
 * in-memory index (also snapshotted to the OS temp dir) and refreshed in the
 * background every few hours. A search waits briefly for a cold index, then
 * answers from whatever has loaded while the rest keeps warming.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import registry from '../../../sources/registry.json';
// Written by `npm run sourcing:health`: skips dead sources, applies verified URL repairs.
import registryHealth from '../../../sources/registry-health.json';

const { RssAdapter } = require('../../sourcing/adapters/rssAdapter');
const { HtmlListAdapter } = require('../../sourcing/adapters/htmlListAdapter');

const TTL_MS = 3 * 60 * 60 * 1000; // refresh every 3 hours
const FETCH_TIMEOUT_MS = 8000;
const CONCURRENCY = 24;
const RSS_ITEM_LIMIT = 40;
const PORTFOLIO_ITEM_LIMIT = 300;
const SNAPSHOT_FILE = path.join(os.tmpdir(), 'searchbar3-curated-index.json');
const USER_AGENT = 'Mozilla/5.0 (compatible; Searchbar3-Research/1.0)';

const STOPWORDS = new Set(('a an and are as at be by for from has have how in into is it its of on or that the this to ' +
  'was were what when where which who why will with about vs versus did does do company companies startup startups ' +
  'news latest recent funding raise raised round').split(' '));

// Words above are dropped from matching but "funding" etc. still boost
// funding_news sources through categoryHints below.
const CATEGORY_HINTS = [
  { pattern: /\b(fund|funding|raise[sd]?|round|series [a-z]|seed|valuation|investors?|backed|led by)\b/i, categories: ['funding_news', 'funding_ecosystem', 'venture_portfolio', 'investor_portfolio', 'vc_portfolio'] },
  { pattern: /\b(market|tam|landscape|competitors?|industry|trend)\b/i, categories: ['market_analysis'] },
  { pattern: /\b(portfolio|investor|vc|venture|accelerator|yc|y combinator)\b/i, categories: ['venture_portfolio', 'investor_portfolio', 'vc_portfolio', 'accelerator_portfolio', 'investors'] },
];

const FUNDING_TITLE = /\b(rais(es|ed|ing)|funding|series [a-e]|seed|round|valuation|backed|invest(s|ment|ed))\b/i;

const PORTFOLIO_CATEGORIES = new Set(['venture_portfolio', 'investor_portfolio', 'vc_portfolio', 'accelerator_portfolio', 'accelerator_directory', 'investors']);

const state = {
  items: [],
  builtAt: 0,
  building: null,
  stats: { sources: 0, ok: 0, failed: 0, items: 0, durationMs: 0, failures: [] },
};

function indexableSources() {
  const health = registryHealth?.sources || {};
  return registry
    .filter((s) => {
      const url = s.method?.url || '';
      if (url.includes('{{query}}')) return false;
      if (!['rss', 'html_list', 'js_rendered'].includes(s.adapter)) return false;
      const status = health[s.id]?.status;
      // Unknown status (source added after the last health check) is tried.
      return !status || status === 'ok' || status === 'repaired';
    })
    .map((s) => (health[s.id]?.status === 'repaired' ? { ...s, method: { ...s.method, url: health[s.id].url } } : s));
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos|#39|rsquo|lsquo|rdquo|ldquo|hellip|mdash|ndash);/g, (m, e) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", rsquo: "'", lsquo: "'",
      rdquo: '"', ldquo: '"', hellip: '...', mdash: '-', ndash: '-',
    }[e] || m))
    .replace(/\s+/g, ' ')
    .trim();
}

function toItem(source, raw) {
  const isPortfolio = PORTFOLIO_CATEGORIES.has(source.category) || source.adapter !== 'rss';
  const title = stripHtml(raw.company_name || raw.title).slice(0, 300);
  if (!title || !raw.url) return null;
  const published = Date.parse(raw.publishedAt);
  return {
    title,
    url: raw.url,
    content: stripHtml(raw.content).slice(0, 600),
    publishedAt: isPortfolio || Number.isNaN(published) ? null : new Date(published).toISOString(),
    kind: isPortfolio ? 'portfolio' : 'article',
    companyWebsite: raw.company_website || null,
    sourceId: source.id,
    sourceName: source.name,
    category: source.category,
    region: source.region,
    tier: source.cadence?.tier || null,
  };
}

async function fetchSource(source) {
  // Raise per-source limits for indexing (registry limits target daily runs).
  const isRss = source.adapter === 'rss';
  const tuned = {
    ...source,
    method: {
      ...source.method,
      extract: { ...(source.method.extract || {}), limit: isRss ? RSS_ITEM_LIMIT : PORTFOLIO_ITEM_LIMIT },
    },
  };
  const Adapter = isRss ? RssAdapter : HtmlListAdapter;
  const adapter = new Adapter(tuned, { timeoutMs: FETCH_TIMEOUT_MS, userAgent: USER_AGENT });
  const rawItems = await adapter.run({ query: '' });
  return rawItems.map((raw) => toItem(source, raw)).filter(Boolean);
}

async function runPool(tasks, concurrency, onResult) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      try {
        onResult(task, await task.run(), null);
      } catch (error) {
        onResult(task, null, error);
      }
    }
  });
  await Promise.all(workers);
}

function loadSnapshot() {
  try {
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    if (Array.isArray(snap.items) && snap.builtAt && Date.now() - snap.builtAt < TTL_MS) {
      state.items = snap.items;
      state.builtAt = snap.builtAt;
      state.stats = snap.stats || state.stats;
      return true;
    }
  } catch {
    // no snapshot yet
  }
  return false;
}

function saveSnapshot() {
  try {
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({ items: state.items, builtAt: state.builtAt, stats: state.stats }));
  } catch {
    // read-only or full temp dir: the in-memory index still works
  }
}

function buildIndex() {
  if (state.building) return state.building;
  const started = Date.now();
  const sources = indexableSources();
  const fresh = [];
  const failures = [];
  let ok = 0;

  state.building = runPool(
    sources.map((source) => ({ source, run: () => fetchSource(source) })),
    CONCURRENCY,
    (task, items, error) => {
      if (error) {
        failures.push({ id: task.source.id, name: task.source.name, error: String(error.message || error).slice(0, 120) });
        return;
      }
      ok += 1;
      fresh.push(...items);
      // First build: make items searchable as they arrive.
      if (!state.builtAt) state.items = fresh.slice();
    }
  ).then(() => {
    const seen = new Set();
    state.items = fresh.filter((item) => {
      const key = `${item.sourceId}::${item.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    state.builtAt = Date.now();
    state.stats = { sources: sources.length, ok, failed: failures.length, items: state.items.length, durationMs: Date.now() - started, failures };
    saveSnapshot();
  }).finally(() => {
    state.building = null;
  });

  return state.building;
}

/** Start (or refresh) the index without waiting. Safe to call often. */
export function warmCuratedIndex() {
  if (!state.builtAt) loadSnapshot();
  if (!state.builtAt || Date.now() - state.builtAt > TTL_MS) buildIndex();
  return getCuratedIndexStatus();
}

export function getCuratedIndexStatus() {
  return {
    ready: Boolean(state.builtAt),
    building: Boolean(state.building),
    builtAt: state.builtAt ? new Date(state.builtAt).toISOString() : null,
    itemsAvailable: state.items.length,
    registrySources: registry.length,
    healthCheckedAt: registryHealth?.checkedAt || null,
    healthCounts: registryHealth?.counts || null,
    indexableSources: indexableSources().length,
    ...state.stats,
  };
}

function tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9.+&'-]*/g) || [];
}

function scoreItem(item, terms, phrase, hintedCategories, properNouns, fundingIntent) {
  // A capitalized query word ("Ramp") is treated as a name: it must appear
  // with that capitalization, so "ramp up" in an article does not match.
  for (const noun of properNouns) {
    const re = new RegExp(`(^|[^A-Za-z0-9])${noun.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9])`);
    if (!re.test(item.title) && !re.test(item.content)) return 0;
  }
  const title = item.title.toLowerCase();
  const body = `${title} ${item.content.toLowerCase()} ${item.sourceName.toLowerCase()}`;
  let matched = 0;
  let score = 0;
  for (const term of terms) {
    const re = new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`);
    if (re.test(title)) { matched += 1; score += 3; } else if (re.test(body)) { matched += 1; score += 1; }
  }
  if (matched === 0) return 0;
  // Short queries (a company name) need every term; longer ones most terms.
  const needed = terms.length <= 2 ? terms.length : Math.ceil(terms.length * 0.6);
  if (matched < needed) return 0;
  if (phrase && title.includes(phrase)) score += 5;
  else if (phrase && body.includes(phrase)) score += 2;
  if (hintedCategories.has(item.category)) score += 2;
  if (fundingIntent && FUNDING_TITLE.test(item.title)) score += 4;
  if (item.tier === 'A') score += 0.5;
  if (item.publishedAt) {
    const ageDays = (Date.now() - Date.parse(item.publishedAt)) / 86400000;
    score += ageDays < 30 ? 2 : ageDays < 180 ? 1 : 0;
  }
  return score;
}

function toResult(item, score) {
  const isPortfolio = item.kind === 'portfolio';
  const date = item.publishedAt ? item.publishedAt.slice(0, 10) : null;
  return {
    title: isPortfolio ? `${item.title} (portfolio: ${item.sourceName.replace(/\s+Portfolio$/i, '')})` : item.title,
    url: item.url,
    content: isPortfolio
      ? `${item.title} is listed on ${item.sourceName}${item.companyWebsite ? ` (website: ${item.companyWebsite})` : ''}. ${item.content !== item.title ? item.content : ''}`.trim()
      : item.content,
    snippet: item.content,
    source: 'curated',
    sourceName: item.sourceName,
    sourceCategory: item.category,
    publishedAt: item.publishedAt,
    date,
    type: isPortfolio ? 'portfolio_listing' : 'curated_article',
    verified: true,
    relevance: Math.min(0.99, 0.6 + score / 40),
    metadata: { curated: true, sourceId: item.sourceId, category: item.category, region: item.region, tier: item.tier },
  };
}

/**
 * Search the curated index.
 * @param {string} query
 * @param {{ limit?: number, waitMs?: number }} options waitMs: how long a cold index may delay this search
 */
export async function searchCuratedSources(query, { limit = 15, waitMs = 12000 } = {}) {
  warmCuratedIndex();
  if (!state.builtAt && state.building) {
    await Promise.race([state.building, new Promise((r) => setTimeout(r, waitMs))]);
  }

  const lowered = String(query || '').toLowerCase().trim();
  const allTerms = tokenize(lowered);
  const terms = allTerms.filter((t) => !STOPWORDS.has(t));
  if (terms.length === 0) return [];
  const phrase = terms.length > 1 ? terms.join(' ') : null;
  const properNouns = (String(query || '').match(/[A-Za-z0-9][A-Za-z0-9.+&'-]*/g) || [])
    .filter((w) => /^[A-Z]/.test(w) && w.length > 1 && !STOPWORDS.has(w.toLowerCase()));
  const fundingIntent = CATEGORY_HINTS[0].pattern.test(lowered);
  const hintedCategories = new Set(CATEGORY_HINTS.filter((h) => h.pattern.test(lowered)).flatMap((h) => h.categories));

  const scored = [];
  for (const item of state.items) {
    const score = scoreItem(item, terms, phrase, hintedCategories, properNouns, fundingIntent);
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);

  // Keep the list varied: at most 3 results per source.
  const perSource = new Map();
  const seenStories = new Set();
  const results = [];
  for (const { item, score } of scored) {
    // The same story often appears in several feeds of one publisher.
    const storyKey = item.url.replace(/[?#].*$/, '').replace(/\/$/, '') + '|' + item.title.toLowerCase();
    const titleKey = item.kind === 'article' ? item.title.toLowerCase() : storyKey;
    if (seenStories.has(storyKey) || seenStories.has(titleKey)) continue;
    seenStories.add(storyKey);
    seenStories.add(titleKey);
    const count = perSource.get(item.sourceId) || 0;
    if (count >= 3) continue;
    perSource.set(item.sourceId, count + 1);
    results.push(toResult(item, score));
    if (results.length >= limit) break;
  }
  return results;
}
