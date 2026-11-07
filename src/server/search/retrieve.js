/**
 * Retrieval: run every selected source with a query rewritten for that
 * source, in parallel, with timeouts. Returns raw results (no LLM call) and
 * per-source status so the UI can show which sources were unavailable.
 */
import axios from 'axios';
import { webQuery, entityRegex, mentionMatches, INTENTS, GENERIC_WORDS } from './queryPlan';

const SITE_SOURCES = ['linkedin', 'twitter', 'reddit', 'substack', 'medium', 'crunchbase', 'pitchbook', 'carta'];
const TIMEOUT_MS = 20000;

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** "2 days ago", "5 hours ago", "Nov 3, 2026" -> ISO date, or null */
export function parseResultDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  const rel = s.match(/^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/i);
  if (rel) {
    const unit = { minute: 60e3, hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, year: 365 * 86400e3 }[rel[2].toLowerCase()];
    return new Date(Date.now() - Number(rel[1]) * unit).toISOString();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

export function webSearchConfigured() {
  return Boolean(process.env.SERPER_API_KEY || process.env.TAVILY_API_KEY);
}

/**
 * One web query via Serper (primary) or Tavily (fallback).
 * @param {string} q
 * @param {{ news?: boolean, withinDays?: number, num?: number }} options
 */
export async function searchWeb(q, { news = false, withinDays = 0, num = 10 } = {}) {
  const serper = process.env.SERPER_API_KEY;
  const tavily = process.env.TAVILY_API_KEY;
  if (!serper && !tavily) throw new Error('No SERPER_API_KEY or TAVILY_API_KEY configured');
  if (serper) {
    try {
      const tbs = withinDays ? (withinDays <= 7 ? 'qdr:w' : withinDays <= 31 ? 'qdr:m' : withinDays <= 366 ? 'qdr:y' : null) : null;
      const { data } = await axios.post(`https://google.serper.dev/${news ? 'news' : 'search'}`, { q, num, gl: 'us', hl: 'en', ...(tbs ? { tbs } : {}) }, {
        headers: { 'X-API-KEY': serper, 'Content-Type': 'application/json' }, timeout: 12000,
      });
      const items = news ? data?.news || [] : data?.organic || [];
      const out = items.map((it) => ({
        title: it.title, url: it.link, content: it.snippet || '', snippet: it.snippet || '',
        source: 'web', sourceName: it.source || hostOf(it.link), publishedAt: parseResultDate(it.date),
        date: parseResultDate(it.date)?.slice(0, 10) || null, type: news ? 'news' : 'web',
      }));
      if (out.length > 0 || !tavily) return out;
    } catch (error) {
      if (!tavily) throw error;
    }
  }
  const { data } = await axios.post('https://api.tavily.com/search', {
    api_key: tavily, query: q, max_results: num, search_depth: 'basic',
    topic: news ? 'news' : 'general', ...(withinDays ? { days: withinDays } : {}),
  }, { timeout: 15000 });
  return (data?.results || []).map((it) => ({
    title: it.title, url: it.url, content: it.content || '', snippet: it.content || '',
    source: 'web', sourceName: hostOf(it.url), publishedAt: parseResultDate(it.published_date),
    date: parseResultDate(it.published_date)?.slice(0, 10) || null, type: news ? 'news' : 'web',
  }));
}

/** Web search for a query plan: organic results, plus news for recency/funding/legal. */
async function webSearch(plan) {
  const q = webQuery(plan);
  const wantNews = plan.recency || plan.intents.includes('funding') || plan.intents.includes('legal');
  const calls = [searchWeb(q)];
  if (wantNews) calls.push(searchWeb(q, { news: true, withinDays: plan.recency ? 365 : 0 }));
  const settled = await Promise.allSettled(calls);
  if (settled.every((x) => x.status === 'rejected')) throw settled[0].reason;
  return settled.flatMap((x) => (x.status === 'fulfilled' ? x.value : []));
}

async function curatedSearch(plan) {
  const curated = await import('../../utils/sources/curatedIndex');
  const regex = entityRegex(plan.entityTokens);
  const intentRes = plan.intents.map((i) => INTENTS[i]);
  const tasks = [];
  // The full phrase, plus the words the user capitalized ("Harvey legal AI" -> "Harvey")
  const capped = plan.entityTokens.filter((t) => /^\p{Lu}/u.test(t) && !GENERIC_WORDS.has(t.toLowerCase()));
  const variants = [plan.entityTokens, capped.length && capped.length < plan.entityTokens.length ? capped : null].filter((v) => v && v.length);
  for (const tokens of variants) {
    const re = entityRegex(tokens);
    const isMention = (text) => mentionMatches(text, new RegExp(re.source, re.flags)).length > 0;
    tasks.push(curated.searchCuratedForEntity(isMention, { intentRes, recency: plan.recency, limit: 20 }));
  }
  // Topic queries ("seed round ai agents") also use the keyword search
  if (!regex || plan.isGenericCandidate) tasks.push(curated.searchCuratedSources(plan.query, { limit: 15 }));
  const settled = await Promise.allSettled(tasks);
  return settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
}

async function hackerNewsSearch(plan) {
  const { searchHackerNews } = await import('../../utils/sources/hackernewsAlgolia');
  const subject = plan.entityCandidate || plan.query;
  const queries = [subject];
  if (plan.entityTokens.length > 1) queries.push(plan.entityTokens.join('')); // "open ai" -> "openai"
  const settled = await Promise.allSettled(queries.map((q) => searchHackerNews(q, { limit: 15 })));
  return settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : [])).map((r) => ({ ...r, sourceName: 'Hacker News', date: r.timestamp?.slice(0, 10), publishedAt: r.timestamp }));
}

async function integrationSearch(sources, query, options = {}) {
  const { performSearchDetailed } = await import('../../utils/sourceIntegration');
  const detailed = await performSearchDetailed(query, sources, { timeoutMs: 18000, ...options });
  return detailed;
}

/**
 * @param {Object} plan from understandQuery
 * @param {string[]} sources normalized source keys
 * @param {{ customUrls?: string[], files?: Object[] }} options
 * @returns {Promise<{ results: Object[], statuses: Array<{source, status, count, error}> }>}
 */
export async function retrieve(plan, sources, { customUrls = [], files = [] } = {}) {
  const jobs = [];
  const add = (name, fn) => jobs.push({ name, run: () => withTimeout(fn(), TIMEOUT_MS, name) });

  if (sources.includes('curated')) add('curated', () => curatedSearch(plan));
  if (sources.includes('web')) add('web', () => webSearch(plan));
  // Hacker News adds community coverage for tech companies; it is always
  // searched for entity queries because it needs no key.
  if (sources.includes('web') || sources.includes('curated')) add('hackernews', () => hackerNewsSearch(plan));
  const sites = sources.filter((s) => SITE_SOURCES.includes(s));
  for (const site of sites) {
    add(site, async () => (await integrationSearch([site], webQuery(plan))).results || []);
  }
  if (sources.includes('verified')) {
    add('verified', async () => (await integrationSearch(['sec', 'fmp'], plan.entityCandidate || plan.query)).results || []);
  }
  if (customUrls.length) add('custom', async () => (await integrationSearch(['custom'], plan.query, { customUrls })).results || []);
  if (files.length) add('file', async () => (await integrationSearch(['file'], plan.query, { files })).results || []);

  const settled = await Promise.allSettled(jobs.map((j) => j.run()));
  const results = [];
  const statuses = [];
  settled.forEach((s, i) => {
    const name = jobs[i].name;
    if (s.status === 'fulfilled') {
      const found = (s.value || []).map((r) => ({ ...r, url: r.url || r.link, retrievedBy: name }));
      results.push(...found);
      statuses.push({ source: name, status: found.length ? 'ok' : 'empty', count: found.length, error: null });
    } else {
      statuses.push({ source: name, status: 'error', count: 0, error: String(s.reason?.message || s.reason) });
    }
  });
  return { results: results.filter((r) => r.url && r.title), statuses };
}
