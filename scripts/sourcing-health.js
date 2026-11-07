#!/usr/bin/env node
/**
 * Source health check for sources/registry.json.
 *
 * Fetches every indexable source once and writes sources/registry-health.json:
 *   - status "ok":       works as listed
 *   - status "repaired": listed URL failed, but a verified replacement was
 *                        found (the site's own advertised RSS feed, or a
 *                        standard portfolio path); `url` holds the fix
 *   - status "dead":     domain does not resolve / refuses connections
 *   - status "broken":   site exists but no working URL was found
 *
 * It never edits registry.json. The curated search index reads this file to
 * skip dead/broken sources and to use repaired URLs.
 *
 * Usage: npm run sourcing:health
 */
const fs = require('fs');
const path = require('path');
const { RssAdapter } = require('../src/sourcing/adapters/rssAdapter');
const { HtmlListAdapter } = require('../src/sourcing/adapters/htmlListAdapter');

const ROOT = path.join(__dirname, '..');
const REGISTRY = require(path.join(ROOT, 'sources/registry.json'));
const OUT = path.join(ROOT, 'sources/registry-health.json');
const USER_AGENT = 'Mozilla/5.0 (compatible; Searchbar3-Research/1.0)';
const TIMEOUT_MS = 10000;
const CONCURRENCY = 16;
const DEAD_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ENETUNREACH', 'EAI_AGAIN']);
const RSS_PATHS = ['/feed', '/feed/', '/rss', '/rss.xml', '/feed.xml', '/index.xml', '/blog/feed', '/blog/rss.xml'];
const PORTFOLIO_PATHS = ['/portfolio', '/portfolio/', '/companies', '/our-portfolio', '/investments', '/portfolio-companies'];
const MIN_PORTFOLIO_ITEMS = 5;

function errorCode(error) {
  return error?.cause?.code || (String(error?.message || '').match(/HTTP \d+/) || [])[0] || error?.name || 'error';
}

async function tryAdapter(source, url) {
  const isRss = source.adapter === 'rss';
  const Adapter = isRss ? RssAdapter : HtmlListAdapter;
  const tuned = { ...source, method: { ...source.method, url, extract: { ...(source.method.extract || {}), limit: 50 } } };
  const items = await new Adapter(tuned, { timeoutMs: TIMEOUT_MS, userAgent: USER_AGENT }).run({ query: '' });
  const usable = items.filter((i) => i.title && i.url);
  const needed = isRss ? 1 : MIN_PORTFOLIO_ITEMS;
  if (usable.length < needed) throw new Error(`only ${usable.length} items`);
  return usable.length;
}

async function discoverFeedLinks(origin) {
  try {
    const res = await fetch(origin, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return [];
    const html = await res.text();
    const links = [];
    for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
      if (/rel=["']?alternate/i.test(tag) && /type=["']?application\/rss\+xml/i.test(tag)) {
        const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
        if (href) links.push(new URL(href, origin).toString());
      }
    }
    return links;
  } catch {
    return [];
  }
}

async function checkSource(source) {
  const listed = source.method.url;
  try {
    const items = await tryAdapter(source, listed);
    return { status: 'ok', items };
  } catch (error) {
    const code = errorCode(error);
    if (DEAD_CODES.has(code)) return { status: 'dead', error: code };

    const origin = new URL(listed).origin;
    const candidates = source.adapter === 'rss'
      ? [...(await discoverFeedLinks(origin)), ...RSS_PATHS.map((p) => origin + p)]
      : PORTFOLIO_PATHS.map((p) => origin + p);

    for (const candidate of [...new Set(candidates)]) {
      if (candidate === listed) continue;
      try {
        const items = await tryAdapter(source, candidate);
        return { status: 'repaired', url: candidate, items, error: code };
      } catch {
        // try next candidate
      }
    }
    return { status: 'broken', error: code };
  }
}

async function main() {
  const sources = REGISTRY.filter((s) => !String(s.method?.url || '').includes('{{query}}') && ['rss', 'html_list', 'js_rendered'].includes(s.adapter));
  const results = {};
  let next = 0;
  let done = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < sources.length) {
      const source = sources[next++];
      results[source.id] = { name: source.name, adapter: source.adapter, listedUrl: source.method.url, ...(await checkSource(source)) };
      done += 1;
      if (done % 100 === 0) console.log(`checked ${done}/${sources.length}`);
    }
  }));

  const counts = Object.values(results).reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
  fs.writeFileSync(OUT, JSON.stringify({ checkedAt: new Date().toISOString(), counts, sources: results }, null, 2) + '\n');
  console.log('Source health:', counts);
  console.log(`Wrote ${path.relative(ROOT, OUT)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
