/**
 * Keyless web and news search for the deep background check.
 *
 * The check asks the open web many small questions ("name" lawsuit, "name"
 * "co-founder", ...). No single keyless engine can carry that load, so the
 * questions are spread over several, each used the way it tolerates:
 *
 *   web   DuckDuckGo (HTML page)       real results with snippets, site: and date limits; it
 *                                      challenges an automated client after a handful of
 *                                      queries, so it gets a small allowance (6 per 10 min)
 *         Brave Search (HTML page)     off unless FOUNDER_SEARCH_BRAVE_HTML=1: it answers,
 *                                      but its robots.txt disallows /search
 *         Wikipedia search             always answers, with snippets; only covers Wikipedia
 *   news  Google News (RSS feed)       fast, up to 100 headlines, after:/before: date windows
 *                                      back to the 2000s; headlines only, no snippets. On unless
 *                                      FOUNDER_SEARCH_GOOGLE_NEWS=0. Note for the owner: the feed
 *                                      is published for programs to read, but news.google.com's
 *                                      robots.txt does not list /rss/search among the allowed
 *                                      paths. It is kept on because each request is a lookup a
 *                                      user started, at a modest pace (one a second, at most 60
 *                                      per 10 min); set the switch to 0 to turn it off.
 *         Bing News (RSS feed)         headline plus a sentence; recent coverage only, and
 *                                      it sometimes answers with an empty feed
 *         GDELT (DOC 2.0 article list) worldwide news since 2017, headlines only; slow
 *                                      (10 to 25 s) and limited to one request per 5 s, so it
 *                                      is only asked when no other news engine answered
 *
 * A web question that no web engine could take falls through to the news
 * feeds (a press article is still an answer to "name" lawsuit) and to
 * Wikipedia, unless it is restricted to a site. Questions about who someone
 * is (prefer: 'reference') try Wikipedia before the news feeds.
 *
 * The caller can pass accept(result): results it rejects (a headline that
 * does not name the person) are dropped, and an engine left with nothing
 * counts as having found nothing, so the next engine is asked.
 *
 * Every engine is asked as what we are (the shared client in ../http, no
 * browser disguise). When an engine says stop (HTTP 429/403, a challenge or
 * "unusual traffic" page) it is left alone for 10 minutes, doubling up to 2
 * hours, and the next engine is used. Such a pause is written to the shared
 * database (source_cache, key 'engine-rest:<id>'), and every instance reads
 * those pauses at most every 2 minutes, so a fresh server instance does not
 * ask an engine that just told another instance to stop. Short rests (five
 * minutes after plain failures) and request spacing stay per instance.
 *
 * The backup search service (search/retrieve.js searchWeb: Serper, and
 * Tavily when Serper finds nothing) is the last resort, only when the caller
 * allows it and FOUNDER_SEARCH_METERED is not 0. Note for the owner: the
 * site's ordinary search already uses this service on every query, and these
 * calls draw on the same allowance. It is used at most METERED_PER_HOUR times
 * per clock hour across all server instances (counted in source_cache, key
 * 'search-metered:<hour>'); without the hosted database, or when the count cannot be
 * read in time, the limit is per server instance (a sliding hour). One use
 * can be two calls to the service when Serper finds nothing and Tavily is
 * also configured.
 *
 * Settled and left out (checked live, 2026-11-14): Mojeek (403 "automated
 * queries"), Startpage (proof-of-work challenge), public SearXNG instances
 * (bot checks / 429), Stract (search endpoint gone, 404), Marginalia (shared
 * public allowance exhausted, 429), Yep and Qwant (blocked), Bing web RSS
 * (ignores quoted phrases: '"Elizabeth Holmes" lawsuit' returns Elizabeth
 * II), DuckDuckGo lite (same service and same challenge as the HTML page),
 * Internet Archive full-text and TV captions (the site's own search service,
 * not a published interface; captions are lower-case so names do not match).
 * Google News links are forwarding links; turning them into the article
 * address needs a second request per link, so they are kept as they are and
 * the publisher's host is returned beside them.
 */
import { load } from 'cheerio';
import { getText, getJson } from '../http';
import { isBlockedUrl } from '../guardrails';
import { searchWeb, webSearchConfigured } from '../../search/retrieve';
import { query as dbQuery, persistenceMode } from '../../db';

export const MAX_ENGINES_PER_CALL = 3;
export const METERED_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;
const ENGINE_REST_PREFIX = 'engine-rest:';
const METERED_PREFIX = 'search-metered:';
const SHARED_RELOAD_MS = 2 * 60 * 1000; // how often the pauses other instances shared are read
const SHARED_WAIT_MS = 1500; // how long a search waits for the shared database before going on without it
const COOLDOWN_MS = 10 * 60 * 1000;
const COOLDOWN_MAX_MS = 2 * HOUR_MS;
const SOFT_FAILURES = 3; // consecutive plain failures (timeouts, bad replies) before a short rest
const SOFT_REST_MS = 5 * 60 * 1000;
const QUEUE_FIRST_MS = 12000; // how long a call may wait its turn on the best engine for it
const QUEUE_NEXT_MS = 6000; // ... and on a fallback engine
const DAY_MS = 86400000;

/** An engine told us to stop (rate limit, challenge page). Puts it in cooldown. */
export class EngineBlocked extends Error {
  constructor(message) {
    super(message);
    this.name = 'EngineBlocked';
    this.blocked = true;
  }
}

/* ------------------------------------------------------------------ helpers */

const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const hostOf = (url) => { try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const isoDay = (value) => {
  if (!value) return null;
  const t = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
};
const urlKey = (url) => String(url || '').replace(/^https?:\/\/(www\.)?/i, '').replace(/#.*$/, '').replace(/[?&](utm_[a-z]+|oc|ref|fbclid|gclid)=[^&]*/gi, '').replace(/[?&]$/, '').replace(/\/$/, '').toLowerCase();

/** "5 days ago" / "March 18, 2023" -> ISO day, or null. */
function looseDay(text, now = Date.now()) {
  const s = tidy(text).replace(/\s*[-–—]\s*$/, '');
  const rel = s.match(/^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/i);
  if (rel) {
    const unit = { minute: 60000, hour: 3600000, day: DAY_MS, week: 7 * DAY_MS, month: 30 * DAY_MS, year: 365 * DAY_MS }[rel[2].toLowerCase()];
    return isoDay(now - Number(rel[1]) * unit);
  }
  if (!/\d{4}/.test(s)) return null;
  // a bare date ("March 18, 2023") is read as UTC, so the day does not shift with the server's time zone
  return isoDay(/\d:\d\d|GMT|UTC|Z$/i.test(s) ? s : `${s} UTC`) || isoDay(s);
}

/** The site: restrictions of a query: [{ host, path }]. "-site:" exclusions are not restrictions. */
export function siteFilters(query) {
  const out = [];
  for (const m of String(query || '').matchAll(/(?<![\w-])site:([^\s()]+)/gi)) {
    const raw = m[1].replace(/^https?:\/\//i, '').replace(/^www\./i, '');
    const slash = raw.indexOf('/');
    const host = (slash < 0 ? raw : raw.slice(0, slash)).toLowerCase();
    const path = slash < 0 ? '' : raw.slice(slash).replace(/\/$/, '');
    if (host) out.push({ host, path });
  }
  return out;
}

function onSite(result, sites) {
  const urlHost = hostOf(result.url);
  const host = result.host || urlHost;
  return sites.some((s) => {
    if (!(host === s.host || host.endsWith(`.${s.host}`))) return false;
    if (!s.path || host !== urlHost) return true;
    try { return new URL(result.url).pathname.toLowerCase().startsWith(s.path.toLowerCase()); } catch { return false; }
  });
}

/** Engines that only take a host after site: (DuckDuckGo answers 403 to site:linkedin.com/in). The path is checked on the results instead. */
const hostOnlySites = (query) => String(query).replace(/(?<![\w-])(site:)(?:https?:\/\/)?([^\s()/]+)\/[^\s()]*/gi, '$1$2');
const withoutParens = (query) => tidy(String(query).replace(/[()]/g, ' '));

const REGION = {
  fr: { gnews: 'hl=fr&gl=FR&ceid=FR:fr', ddg: 'fr-fr', wiki: 'fr' },
  de: { gnews: 'hl=de&gl=DE&ceid=DE:de', ddg: 'de-de', wiki: 'de' },
  es: { gnews: 'hl=es&gl=ES&ceid=ES:es', ddg: 'es-es', wiki: 'es' },
};

/* ------------------------------------------------------------------ parsers */

/** Google News RSS: headlines with the publisher, the article date, and a news.google.com link that forwards to the article. */
export function parseGoogleNews(xml) {
  const body = String(xml || '');
  if (!/<rss[\s>]/i.test(body)) throw new EngineBlocked('Google News answered with a page instead of a feed');
  const $ = load(body, { xmlMode: true });
  const out = [];
  $('item').each((i, el) => {
    const item = $(el);
    const source = item.children('source');
    out.push({
      title: tidy(item.children('title').text()),
      snippet: '', // the feed carries the headline only
      url: tidy(item.children('link').text()),
      date: isoDay(item.children('pubDate').text()),
      publisher: tidy(source.text()) || null,
      host: hostOf(source.attr('url')) || null,
    });
  });
  return out;
}

function unwrapBing(link) {
  try {
    const u = new URL(link);
    if (/(^|\.)bing\.com$/i.test(u.hostname) && /apiclick/i.test(u.pathname)) return u.searchParams.get('url') || link;
  } catch { /* not a URL */ }
  return link;
}

/** Bing News RSS: headline, a one-sentence description, date, publisher; the link wraps the article URL. */
export function parseBingNews(xml) {
  const body = String(xml || '');
  if (!/<rss[\s>]/i.test(body)) throw new EngineBlocked('Bing News answered with a page instead of a feed');
  const $ = load(body, { xmlMode: true });
  const out = [];
  $('item').each((i, el) => {
    const item = $(el);
    const publisher = item.children().filter((j, c) => /^news:source$/i.test(c.tagName || c.name || '')).first().text();
    out.push({
      title: tidy(item.children('title').text()),
      snippet: tidy(item.children('description').text()),
      url: unwrapBing(tidy(item.children('link').text())),
      date: isoDay(item.children('pubDate').text()),
      publisher: tidy(publisher) || null,
    });
  });
  return out;
}

/** GDELT DOC 2.0 article list (JSON). Errors and rate-limit notices come back as plain text. */
export function parseGdelt(text) {
  const body = String(text || '').trim();
  if (/limit requests to one every/i.test(body)) throw new EngineBlocked('GDELT asked for slower requests');
  let data;
  try { data = JSON.parse(body); } catch { throw new Error(`GDELT: ${tidy(body).slice(0, 120) || 'empty reply'}`); }
  return (Array.isArray(data?.articles) ? data.articles : []).map((a) => {
    const d = String(a.seendate || '').match(/^(\d{4})(\d{2})(\d{2})/);
    return {
      title: tidy(a.title).replace(/\s+([,:;.!?])/g, '$1'), // GDELT pads punctuation with spaces
      snippet: '',
      url: String(a.url || ''),
      date: d ? `${d[1]}-${d[2]}-${d[3]}` : null,
      publisher: a.domain || null,
    };
  });
}

const DDG_CHALLENGE = /anomaly-modal|challenge-form|bots use DuckDuckGo|anomaly\.js/i;

/** DuckDuckGo's HTML results page. Throws EngineBlocked on its "bots use DuckDuckGo too" challenge. */
export function parseDuckDuckGo(html) {
  const body = String(html || '');
  if (DDG_CHALLENGE.test(body)) throw new EngineBlocked('DuckDuckGo asked for a human check');
  const $ = load(body);
  const out = [];
  $('.result').each((i, el) => {
    const row = $(el);
    if (row.hasClass('result--ad')) return;
    const a = row.find('a.result__a').first();
    const href = a.attr('href') || '';
    let url = href.startsWith('//') ? `https:${href}` : href;
    try {
      const u = new URL(url);
      if (/duckduckgo\.com$/i.test(u.hostname)) {
        if (u.pathname.startsWith('/y.js')) return; // sponsored
        url = u.searchParams.get('uddg') || '';
      }
    } catch { url = ''; }
    if (!url) return;
    out.push({ title: tidy(a.text()), snippet: tidy(row.find('.result__snippet').first().text()), url, date: null });
  });
  if (!out.length && !/class="[^"]*\b(no-results|results)\b/i.test(body) && !/DuckDuckGo/i.test(body)) throw new Error('DuckDuckGo: the page was not a results page');
  return out;
}

/** Brave Search's HTML results page (server-rendered result blocks). */
export function parseBrave(html, now = Date.now()) {
  const body = String(html || '');
  const $ = load(body);
  const out = [];
  $('div.snippet[data-type="web"]').each((i, el) => {
    const row = $(el);
    const url = row.find('a[href^="http"]').first().attr('href') || '';
    const titleEl = row.find('.search-snippet-title, .title').first();
    const content = row.find('.generic-snippet .content').first().clone();
    const lead = content.find('span.t-secondary').first();
    const date = lead.length ? looseDay(lead.text(), now) : null;
    lead.remove();
    if (url) out.push({ title: tidy(titleEl.attr('title') || titleEl.text()), snippet: tidy(content.text()), url, date });
  });
  // A results page (even an empty one) is titled "<query> - Brave Search"; anything else is a challenge or an error page.
  if (!out.length && !/-\s*Brave Search\s*<\/title>/i.test(body)) throw new EngineBlocked('Brave Search answered with a check page instead of results');
  return out;
}

/** MediaWiki search (action=query&list=search, formatversion=2). */
export function parseWikipedia(data, lang = 'en') {
  const hits = data?.query?.search;
  if (!Array.isArray(hits)) {
    if (data?.error) throw new Error(`Wikipedia: ${tidy(data.error.info || data.error.code).slice(0, 120)}`);
    return [];
  }
  return hits.map((h) => ({
    title: `${h.title} - Wikipedia`,
    snippet: tidy(String(h.snippet || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')),
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(h.title).replace(/ /g, '_'))}`,
    date: null, // the timestamp is the last edit, not the date of anything the article says
  }));
}

/* ------------------------------------------------------------------ engines */

const dateWindow = ({ withinDays, after, before }, now = Date.now()) => {
  if (after || before) return { after: after || '1990-01-01', before: before || isoDay(now + DAY_MS) };
  if (withinDays > 0) return { after: isoDay(now - withinDays * DAY_MS), before: isoDay(now + DAY_MS) };
  return null;
};

/** GDELT rejects a query that contains a bare word shorter than three letters: drop those, and the OR left dangling. */
export function withoutShortWords(query) {
  const kept = (String(query).match(/"[^"]*"|[()]|[^\s()"]+/g) || []).filter((tok) => tok.startsWith('"') || /^[()]$/.test(tok) || /^(OR|AND)$/.test(tok) || tok.replace(/[^\p{L}\p{N}]/gu, '').length >= 3);
  return tidy(kept.join(' ')
    .replace(/\b(OR|AND)(\s+(OR|AND))+\b/g, '$1')
    .replace(/\(\s*(OR|AND)\b/g, '(')
    .replace(/\b(OR|AND)\s*\)/g, ')')
    .replace(/\(\s*\)/g, '')
    .replace(/\(\s+/g, '(').replace(/\s+\)/g, ')'));
}

const TEN_MINUTES = 10 * 60 * 1000;

/**
 * Each engine, best first: id, label, kind, how it is paced, and search().
 *   gapMs       minimum time between two requests from this server instance
 *   budget      at most `max` requests per `perMs`; `reserve` of them are kept for searches
 *               restricted to a site, which no other engine can take
 *   sites       can it restrict a search to a site? ('news': only for a news search)
 *   covers()    false when it cannot serve the requested date window (skipped, not tried)
 *   enabled()   false when it is switched off on this deployment
 *   lastResort  only asked when no engine before it answered
 */
export const ENGINES = [
  {
    id: 'ddg', label: 'DuckDuckGo', kind: 'web', gapMs: 4000, budget: { max: 6, perMs: TEN_MINUTES, reserve: 2 }, sites: true,
    async search(query, { withinDays, after, before, deadline, lang } = {}) {
      // It takes "a OR b" without parentheses, and only a host after site: (site:linkedin.com/in answers 403).
      const params = new URLSearchParams({ q: withoutParens(hostOnlySites(query)) });
      const w = dateWindow({ withinDays, after, before });
      if (after || before) params.set('df', `${w.after}..${w.before}`);
      else if (withinDays > 0) params.set('df', withinDays <= 1 ? 'd' : withinDays <= 7 ? 'w' : withinDays <= 31 ? 'm' : withinDays <= 366 ? 'y' : `${w.after}..${w.before}`);
      if (REGION[lang]) params.set('kl', REGION[lang].ddg);
      return parseDuckDuckGo(await getText(`https://html.duckduckgo.com/html/?${params}`, { deadline, timeoutMs: 9000, retries: 0, accept: 'text/html' }));
    },
  },
  {
    id: 'brave', label: 'Brave Search', kind: 'web', gapMs: 4000, budget: { max: 10, perMs: TEN_MINUTES, reserve: 2 }, sites: true,
    // Off by default: search.brave.com/robots.txt disallows /search for every client. The page does answer an
    // honestly identified client, so the deployment's owner can switch it on knowingly.
    enabled: () => process.env.FOUNDER_SEARCH_BRAVE_HTML === '1',
    async search(query, { deadline } = {}) {
      const params = new URLSearchParams({ q: hostOnlySites(query), source: 'web' });
      return parseBrave(await getText(`https://search.brave.com/search?${params}`, { deadline, timeoutMs: 9000, retries: 0, accept: 'text/html' }));
    },
  },
  {
    id: 'gnews', label: 'Google News', kind: 'news', gapMs: 1000, budget: { max: 60, perMs: TEN_MINUTES }, sites: 'news',
    // On by default; see the note in the header. The owner can switch it off.
    enabled: () => process.env.FOUNDER_SEARCH_GOOGLE_NEWS !== '0',
    async search(query, { withinDays, after, before, deadline, lang } = {}) {
      // before: on its own is ignored by the feed; a window always gets both bounds.
      const w = dateWindow({ withinDays, after, before });
      const q = w ? `${query} after:${w.after} before:${w.before}` : query;
      const edition = REGION[lang]?.gnews || 'hl=en-US&gl=US&ceid=US:en';
      return parseGoogleNews(await getText(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${edition}`, { deadline, timeoutMs: 9000, retries: 0, accept: 'application/rss+xml, application/xml, text/xml' }));
    },
  },
  {
    id: 'bingnews', label: 'Bing News', kind: 'news', gapMs: 1500, budget: { max: 40, perMs: TEN_MINUTES },
    // No date windows: it only serves recent coverage, so it is skipped for a window that ends in the past.
    covers: ({ before } = {}, now = Date.now()) => !before || before >= isoDay(now - 45 * DAY_MS),
    async search(query, { deadline } = {}) {
      const params = new URLSearchParams({ q: query, format: 'rss' });
      return parseBingNews(await getText(`https://www.bing.com/news/search?${params}`, { deadline, timeoutMs: 9000, retries: 0, accept: 'application/rss+xml, application/xml, text/xml' }));
    },
  },
  {
    id: 'wikipedia', label: 'Wikipedia', kind: 'web', gapMs: 250,
    // An encyclopedia has no "published in this window".
    covers: ({ withinDays, after, before } = {}) => !after && !before && !(withinDays > 0),
    async search(query, { num = 10, deadline, lang } = {}) {
      const wiki = REGION[lang]?.wiki || 'en';
      const params = new URLSearchParams({ action: 'query', list: 'search', srsearch: withoutParens(query), srlimit: String(Math.min(20, Math.max(1, num))), srprop: 'snippet', format: 'json', formatversion: '2' });
      return parseWikipedia(await getJson(`https://${wiki}.wikipedia.org/w/api.php?${params}`, { deadline, timeoutMs: 8000, retries: 0 }), wiki);
    },
  },
  {
    id: 'gdelt', label: 'GDELT news index', kind: 'news', gapMs: 5500, minBudgetMs: 12000, lastResort: true,
    // Coverage starts in 2017.
    covers: ({ before } = {}) => !before || before > '2017-02-01',
    async search(query, { num = 10, withinDays, after, before, deadline } = {}) {
      const params = new URLSearchParams({ query: withoutShortWords(query), mode: 'artlist', format: 'json', maxrecords: String(Math.min(75, Math.max(10, num * 3))), sort: 'hybridrel' });
      if (after || before) {
        const w = dateWindow({ after, before });
        params.set('startdatetime', `${(w.after < '2017-01-01' ? '2017-01-01' : w.after).replace(/-/g, '')}000000`);
        params.set('enddatetime', `${w.before.replace(/-/g, '')}000000`);
      } else if (withinDays > 0) params.set('timespan', `${Math.max(1, Math.round(withinDays))}d`);
      return parseGdelt(await getText(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`, { deadline, timeoutMs: 22000, retries: 0, accept: 'application/json' }));
    },
  },
];

// Best first. A web question falls through to the news feeds and Wikipedia when the web engines are resting or found nothing.
const ORDER = {
  web: ['ddg', 'brave', 'gnews', 'bingnews', 'wikipedia'],
  reference: ['ddg', 'brave', 'wikipedia', 'gnews', 'bingnews'],
  news: ['gnews', 'bingnews', 'gdelt'],
};
const engineById = (id) => ENGINES.find((e) => e.id === id);
const isEnabled = (e) => (typeof e.enabled === 'function' ? Boolean(e.enabled()) : true);

/** The engines a search would ask, in order (before health is looked at). */
export function engineOrder({ news = false, prefer = null, query = '', withinDays, after, before } = {}) {
  const sites = siteFilters(query);
  return ORDER[news ? 'news' : prefer === 'reference' ? 'reference' : 'web'].map(engineById).filter((e) => {
    if (!e || !isEnabled(e)) return false;
    if (sites.length && !(e.sites === true || (e.sites === 'news' && news))) return false;
    return !e.covers || e.covers({ withinDays, after, before });
  }).map((e) => e.id);
}

/* ------------------------------------------------------------------ health */

let health = new Map();
let meteredStamps = [];
let pacing = true;
let sharedRestsAt = 0;

const meteredOn = () => process.env.FOUNDER_SEARCH_METERED !== '0';
// Only the hosted database is shared by several server instances; a local one (pglite) serves one process.
const sharedDb = () => { try { return persistenceMode() === 'neon'; } catch { return false; } };
/** Resolves to the promise's value, or to `fallback` when it takes longer than `ms` or fails. */
function within(promise, ms, fallback = null) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Tell the other server instances that this engine is paused (best effort, not awaited by the search). */
function shareRest(id, until, ms) {
  if (!sharedDb()) return;
  Promise.resolve().then(() => dbQuery(
    `INSERT INTO source_cache (key, body, fetched_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, fetched_at = now()`,
    [`${ENGINE_REST_PREFIX}${id}`, JSON.stringify({ until, ms })],
  )).catch(() => {});
}

/** Take on the pauses other instances shared, at most every SHARED_RELOAD_MS. */
async function loadSharedRests() {
  if (!sharedDb() || Date.now() - sharedRestsAt < SHARED_RELOAD_MS) return;
  sharedRestsAt = Date.now();
  try {
    const rows = await dbQuery('SELECT key, body FROM source_cache WHERE key LIKE $1', [`${ENGINE_REST_PREFIX}%`]);
    const now = Date.now();
    for (const row of rows || []) {
      const body = typeof row.body === 'string' ? JSON.parse(row.body) : row.body;
      const id = String(row.key).slice(ENGINE_REST_PREFIX.length);
      const until = Number(body?.until);
      if (!ENGINES.some((e) => e.id === id) || !(until > now)) continue;
      const h = stateOf(id);
      if (h.cooldownUntil < until) h.cooldownUntil = Math.min(until, now + COOLDOWN_MAX_MS);
      const ms = Number(body?.ms);
      if (Number.isFinite(ms) && ms > h.cooldownMs) h.cooldownMs = Math.min(ms, COOLDOWN_MAX_MS); // the next block keeps doubling
    }
  } catch {
    // best effort: this instance's own view still applies
  }
}

/**
 * Count one use of the backup search service in the shared hourly count.
 * true: allowed; false: the hour's uses across all instances are spent;
 * null: no shared count (no database, or it did not answer in time), so only this instance's count applies.
 */
async function reserveSharedMetered() {
  if (!sharedDb()) return null;
  const key = `${METERED_PREFIX}${new Date(Date.now()).toISOString().slice(0, 13)}`;
  const rows = await within(dbQuery(
    `INSERT INTO source_cache (key, body, fetched_at) VALUES ($1, to_jsonb(1), now())
     ON CONFLICT (key) DO UPDATE SET body = to_jsonb(COALESCE((source_cache.body #>> '{}')::int, 0) + 1), fetched_at = now()
     RETURNING body`,
    [key],
  ), SHARED_WAIT_MS, null);
  const raw = Array.isArray(rows) ? rows[0]?.body : undefined;
  let count = NaN;
  try { count = Number(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch { /* unreadable: no shared count */ }
  if (!Number.isFinite(count)) return null;
  if (count === 1) {
    // a new hour: clear the counts of earlier days
    Promise.resolve().then(() => dbQuery(`DELETE FROM source_cache WHERE key LIKE $1 AND fetched_at < now() - interval '1 day'`, [`${METERED_PREFIX}%`])).catch(() => {});
  }
  return count <= METERED_PER_HOUR;
}

function stateOf(id) {
  if (!health.has(id)) health.set(id, { cooldownUntil: 0, cooldownMs: 0, streak: 0, calls: 0, answers: 0, results: 0, blocks: 0, failures: 0, lastError: null, lastOkAt: 0, nextFreeAt: 0, recent: [] });
  return health.get(id);
}

const isBlock = (error) => Boolean(error?.blocked) || error?.status === 429 || error?.status === 403;

function markOk(engine, count) {
  const h = stateOf(engine.id);
  h.answers += 1;
  h.results += count;
  h.streak = 0;
  h.cooldownMs = 0; // an answer ends the doubling
  h.lastOkAt = Date.now();
}

function markFailure(engine, error) {
  const h = stateOf(engine.id);
  h.lastError = tidy(error?.message || error).slice(0, 160);
  if (isBlock(error)) {
    h.blocks += 1;
    h.cooldownMs = h.cooldownMs ? Math.min(h.cooldownMs * 2, COOLDOWN_MAX_MS) : COOLDOWN_MS;
    h.cooldownUntil = Date.now() + h.cooldownMs;
    shareRest(engine.id, h.cooldownUntil, h.cooldownMs); // always 10 minutes or more
    return 'blocked';
  }
  h.failures += 1;
  h.streak += 1;
  if (h.streak >= SOFT_FAILURES) { h.streak = 0; h.cooldownUntil = Math.max(h.cooldownUntil, Date.now() + SOFT_REST_MS); }
  return 'failed';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Take this engine's next turn. Resolves to null when the turn was taken
 * (after waiting for it), or to the reason it was not: 'paused' (cooldown),
 * 'resting' (its allowance for this period is used), 'busy' (the queue for
 * it is longer than this call can wait).
 */
async function takeTurn(engine, { deadline, maxWaitMs, siteSearch = false }) {
  const h = stateOf(engine.id);
  const now = Date.now();
  if (h.cooldownUntil > now) return 'paused';
  if (engine.budget) {
    h.recent = h.recent.filter((t) => t > now - engine.budget.perMs);
    const allowance = engine.budget.max - (siteSearch ? 0 : engine.budget.reserve || 0);
    if (h.recent.length >= allowance) return 'resting';
  }
  const wait = pacing ? Math.max(0, h.nextFreeAt - now) : 0;
  const room = deadline ? deadline - now - (engine.minBudgetMs || 3500) : Infinity;
  if (room < 0 || wait > maxWaitMs || wait > room) return 'busy';
  h.nextFreeAt = Math.max(now, h.nextFreeAt) + (engine.gapMs || 0);
  if (engine.budget) h.recent.push(now + wait);
  h.calls += 1;
  if (wait > 0) await sleep(wait);
  return null;
}

function meteredLeft() {
  const now = Date.now();
  meteredStamps = meteredStamps.filter((t) => t > now - HOUR_MS);
  return METERED_PER_HOUR - meteredStamps.length;
}

/* ------------------------------------------------------------------ search */

/** Drop blocked hosts, off-site, out-of-window and rejected results, and duplicates; keep `num`. */
function finish(raw, { num, sites, after, before, withinDays, accept }) {
  const w = dateWindow({ withinDays, after, before });
  const seen = new Set();
  const out = [];
  for (const r of raw || []) {
    if (!r || !r.url || !r.title || !/^https?:\/\//i.test(r.url)) continue;
    if (isBlockedUrl(r.url) || (r.host && isBlockedUrl(`https://${r.host}/`))) continue;
    if (sites.length && !onSite(r, sites)) continue;
    if (w && r.date && (r.date < w.after || r.date > w.before)) continue;
    const key = urlKey(r.url);
    // the same headline on many sister sites (syndicated copy) is one result
    const titleKey = `t:${r.title.toLowerCase()}${r.title.length >= 30 ? '' : `|${r.host || hostOf(r.url)}`}`;
    if (seen.has(key) || seen.has(titleKey)) continue;
    const result = { title: r.title, snippet: r.snippet || '', url: r.url, date: r.date || null, ...(r.host ? { host: r.host } : {}), ...(r.publisher ? { publisher: r.publisher } : {}) };
    if (typeof accept === 'function' && !accept(result)) continue;
    seen.add(key);
    seen.add(titleKey);
    out.push(result);
    if (out.length >= num) break;
  }
  return out;
}

const OUTCOME_WORDS = { paused: 'paused after it asked us to slow down', resting: 'resting (its allowance for now is used)', busy: 'busy', blocked: 'asked us to slow down', failed: 'did not answer', nothing: 'found nothing' };

/**
 * One search, on the best engine that is available.
 *
 * @param {string} query quoted phrases, OR groups in parentheses, site: restrictions
 * @param {{ news?: boolean, num?: number, withinDays?: number, after?: string, before?: string, deadline?: number,
 *           allowMetered?: boolean, lang?: 'fr'|'de'|'es', prefer?: 'reference', accept?: (result) => boolean }} options
 *   after/before are ISO days. accept: keep only the results it returns true for.
 * @returns {Promise<{ results: Array<{ title, snippet, url, date, host?, publisher? }>, engine: string|null,
 *                     tried: Array<{ id: string, outcome: string, count?: number, error?: string }> }>}
 *   `host` is the publisher's host when `url` is a forwarding link (Google News).
 *   Resolves with no results when the engines answered and found nothing; rejects only when none answered.
 */
export async function keylessSearch(query, { news = false, num = 10, withinDays, after, before, deadline, allowMetered = false, lang, prefer = null, accept = null } = {}) {
  const q = tidy(query);
  const tried = [];
  if (!q) return { results: [], engine: null, tried };
  const sites = siteFilters(q);
  await within(loadSharedRests(), SHARED_WAIT_MS);
  const candidates = engineOrder({ news, prefer, query: q, withinDays, after, before }).map(engineById);

  let asked = 0;
  let answered = 0;
  for (const engine of candidates) {
    if (asked >= MAX_ENGINES_PER_CALL) break;
    if (engine.lastResort && answered > 0) continue; // the others answered: nothing to gain from the slow one
    const skip = await takeTurn(engine, { deadline, siteSearch: sites.length > 0, maxWaitMs: asked === 0 && !tried.some((t) => t.outcome === 'busy') ? QUEUE_FIRST_MS : QUEUE_NEXT_MS });
    if (skip) { tried.push({ id: engine.id, outcome: skip }); continue; }
    asked += 1;
    try {
      const results = finish(await engine.search(q, { num, withinDays, after, before, deadline, lang }), { num, sites, after, before, withinDays, accept });
      markOk(engine, results.length);
      answered += 1;
      tried.push({ id: engine.id, outcome: results.length ? 'results' : 'nothing', count: results.length });
      if (results.length) return { results, engine: engine.id, tried };
    } catch (error) {
      tried.push({ id: engine.id, outcome: markFailure(engine, error), error: tidy(error?.message || error).slice(0, 120) });
    }
  }

  // Last resort: the backup search service, for the lookups that matter most. It cannot search a past window.
  const late = () => Boolean(deadline && Date.now() > deadline - 3000);
  const shared = allowMetered && meteredOn() && !before && !after && webSearchConfigured() && meteredLeft() > 0 && !late()
    ? await reserveSharedMetered()
    : undefined;
  if (shared === false) tried.push({ id: 'metered', outcome: 'resting' }); // this hour's uses across all instances are spent
  else if (shared !== undefined && late()) tried.push({ id: 'metered', outcome: 'busy' });
  else if (shared !== undefined) {
    meteredStamps.push(Date.now()); // counted here only when the service is really asked
    try {
      const items = await searchWeb(q, { news, withinDays: withinDays || 0, num, fallback: false });
      const results = finish((items || []).map((it) => ({ title: tidy(it.title), snippet: tidy(it.snippet || it.content), url: it.url, date: it.date || null })), { num, sites, after, before, withinDays, accept });
      answered += 1;
      tried.push({ id: 'metered', outcome: results.length ? 'results' : 'nothing', count: results.length });
      if (results.length) return { results, engine: 'metered', tried };
    } catch (error) {
      tried.push({ id: 'metered', outcome: 'failed', error: tidy(error?.message || error).slice(0, 120) });
    }
  }

  if (answered === 0) {
    const why = tried.map((t) => `${t.id === 'metered' ? 'the backup search service' : engineById(t.id)?.label || t.id}: ${OUTCOME_WORDS[t.outcome] || t.outcome}`).join('; ');
    throw new Error(`No search engine answered${why ? ` (${why})` : ''}`);
  }
  return { results: [], engine: null, tried };
}

/** What each engine is doing, for the coverage note. */
export function engineHealth() {
  const now = Date.now();
  const engines = ENGINES.map((e) => {
    const h = stateOf(e.id);
    const resting = Boolean(e.budget) && h.recent.filter((t) => t > now - e.budget.perMs).length >= e.budget.max;
    return {
      id: e.id, label: e.label, kind: e.kind,
      state: !isEnabled(e) ? 'off' : h.cooldownUntil > now ? 'paused' : resting ? 'resting' : 'ok',
      pausedUntil: h.cooldownUntil > now ? new Date(h.cooldownUntil).toISOString() : null,
      calls: h.calls, answers: h.answers, results: h.results, blocks: h.blocks, failures: h.failures, lastError: h.lastError,
    };
  });
  const used = METERED_PER_HOUR - meteredLeft();
  const names = (list) => list.map((e) => e.label).join(', ');
  const on = engines.filter((e) => e.state !== 'off');
  const paused = engines.filter((e) => e.state === 'paused');
  const note = [
    `Open-web and news searches ran on ${names(on)}.`,
    paused.length ? `${names(paused)} asked for fewer searches and ${paused.length === 1 ? 'is' : 'are'} paused for now; the others covered.` : '',
    used ? `${used} search${used === 1 ? '' : 'es'} this hour used the backup search service (at most ${METERED_PER_HOUR} an hour).` : '',
  ].filter(Boolean).join(' ');
  // usedThisHour is this server instance's count; the shared limit is kept in the database.
  return { engines, metered: { configured: webSearchConfigured() && meteredOn(), usedThisHour: used, hourlyLimit: METERED_PER_HOUR }, note };
}

/** Forget all health, pacing and allowances (tests). Pacing waits are off in tests unless asked for. */
export function __resetEnginesForTests({ pace = false } = {}) {
  health = new Map();
  meteredStamps = [];
  pacing = pace;
  sharedRestsAt = 0;
}
