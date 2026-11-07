/**
 * Watchlist checks: look for NEW items about a watched company in the curated
 * source index (funding news, startup news, VC portfolio pages) and Hacker
 * News, keep only real items that name the company, classify them by
 * keyword, and hand them to the store as alerts.
 *
 * Rules (no fabricated alerts):
 * - the item's title or content must contain the company name, matched
 *   case-sensitively on word boundaries;
 * - dated items must be published within the last 90 days; undated items are
 *   only allowed for portfolio listings (stored once: alerts dedupe on URL);
 * - every alert links to its source;
 * - the first check of a new watch backfills at most 10 most recent items.
 */
import { searchCuratedSources } from '../utils/sources/curatedIndex';
import { searchHackerNews } from '../utils/sources/hackernewsAlgolia';
import { dueWatches, recordWatchCheck } from './store';

export const MAX_AGE_DAYS = 90;
export const BACKFILL_LIMIT = 10;
export const CHECK_LIMIT = 20;

export const ALERT_KINDS = {
  funding: 'Funding',
  people: 'People',
  filing: 'Filing',
  portfolio: 'Portfolio',
  press: 'Press',
};

const FILING_RE = /\b(s-1|f-1|10-k|10-q|8-k|form d|sec filing|files? for|filed|filing|ipo|regulat\w*|antitrust|lawsuit|sues|sued|court|fined|probe|investigat\w*|ftc|doj|cma|european commission|competition authority|ban(s|ned)?|compliance|patent|trademark|subpoena|settle(s|d|ment)?)\b/i;
const FUNDING_RE = /\b(rais(e|es|ed|ing)|funding|fundraise|series [a-h]|seed round|pre-seed|seed funding|round|valuation|valued at|unicorn|led by|backed by|investment from)\b|\b(secures?|closes?|lands?|nabs?|bags?) [$€£]\s?\d/i;
const PEOPLE_RE = /\b(hires?|hired|hiring|appoints?|appointed|names (new|former|\w+ as)|joins|joined|poach(es|ed)?|steps? down|stepping down|depart(s|ed|ure)?|resigns?|resigned|leaves|ousted|fired|new (ceo|cto|cfo|coo|president|chair\w*|head)|as (ceo|cto|cfo|coo|president)|chief \w+ officer|layoffs?|lays off)\b/i;

/**
 * Keyword classification of one item. Portfolio listings come from VC
 * portfolio pages; otherwise the title decides (filing, funding, people),
 * falling back to "press".
 */
export function classifyAlert(item) {
  if (!item) return 'press';
  if (item.type === 'portfolio_listing') return 'portfolio';
  const title = String(item.title || '');
  if (FILING_RE.test(title)) return 'filing';
  if (FUNDING_RE.test(title)) return 'funding';
  if (PEOPLE_RE.test(title)) return 'people';
  return 'press';
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Case-sensitive, word-bounded name matcher. A name typed all in lowercase
 * ("mistral") also matches its capitalized form ("Mistral").
 */
export function companyMatcher(company) {
  const name = String(company || '').trim();
  if (!name) return () => false;
  const variants = new Set([name]);
  if (name === name.toLowerCase()) {
    variants.add(name.replace(/(^|\s)([a-z])/g, (m, sp, ch) => sp + ch.toUpperCase()));
  }
  const res = [...variants].map((v) => new RegExp(`(^|[^A-Za-z0-9])${escapeRe(v)}($|[^A-Za-z0-9])`));
  return (text) => res.some((re) => re.test(String(text || '')));
}

function itemDate(item) {
  const raw = item.publishedAt || item.date || item.timestamp || null;
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

function sourceNameFor(item) {
  if (item.sourceName) return item.sourceName;
  if (item.source === 'hackernews') return 'Hacker News';
  try {
    return new URL(item.url).hostname.replace(/^www\./, '');
  } catch {
    return 'Source';
  }
}

/**
 * Filter, classify and cap raw source items for one company. Pure: exported
 * so tests can exercise the rules without the network.
 */
export function selectAlertItems(company, items, { now = Date.now(), maxItems = CHECK_LIMIT } = {}) {
  const mentions = companyMatcher(company);
  const cutoff = now - MAX_AGE_DAYS * 86400000;
  const seen = new Set();
  const kept = [];
  for (const item of items || []) {
    if (!item || !item.url || !/^https?:\/\//i.test(item.url) || !item.title) continue;
    const url = String(item.url).trim().replace(/\\+$/, '');
    const key = url.replace(/#.*$/, '').replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/i, '').toLowerCase();
    if (seen.has(key)) continue;
    if (!mentions(item.title) && !mentions(item.content) && !mentions(item.snippet)) continue;
    const when = itemDate(item);
    const isPortfolio = item.type === 'portfolio_listing';
    if (when === null) {
      if (!isPortfolio) continue; // undated news is not alertable
    } else if (when < cutoff || when > now + 86400000) {
      continue;
    }
    seen.add(key);
    kept.push({
      kind: classifyAlert(item),
      title: String(item.title).trim(),
      url,
      sourceName: sourceNameFor(item),
      publishedAt: when === null ? null : new Date(when).toISOString(),
      _when: when,
    });
  }
  // Most recent first; undated portfolio listings after dated items.
  kept.sort((a, b) => (b._when ?? -Infinity) - (a._when ?? -Infinity));
  return kept.slice(0, maxItems).map(({ _when, ...alert }) => alert);
}

/**
 * Search the curated sources and Hacker News for one watch and return the
 * alerts to record. A watch that has never been checked backfills at most
 * BACKFILL_LIMIT items.
 */
export async function checkWatch(watch, { now = Date.now(), maxItems } = {}) {
  const company = String(watch?.company || '').trim();
  if (!company) return [];
  const firstCheck = !watch.last_checked_at;
  const cap = Math.min(maxItems ?? (firstCheck ? BACKFILL_LIMIT : CHECK_LIMIT), firstCheck ? BACKFILL_LIMIT : CHECK_LIMIT);

  const [curated, hn] = await Promise.allSettled([
    searchCuratedSources(company, { limit: 40, waitMs: 15000 }),
    searchHackerNews(company, { limit: 30 }),
  ]);
  if (curated.status === 'rejected' && hn.status === 'rejected') {
    throw new Error(`Sources unavailable: ${curated.reason?.message || curated.reason}`);
  }
  const items = [
    ...(curated.status === 'fulfilled' ? curated.value : []),
    ...(hn.status === 'fulfilled' ? hn.value : []),
  ];
  return selectAlertItems(company, items, { now, maxItems: cap });
}

/**
 * Cron entry point: check the watches that are due (oldest first) and record
 * new alerts. Stops starting new checks once the time budget is used.
 */
export async function runDueWatchChecks({ limit = 25, olderThanMinutes = 360, budgetMs = 50000 } = {}) {
  const started = Date.now();
  const watches = await dueWatches(olderThanMinutes, limit);
  const result = { due: watches.length, checked: 0, alertsCreated: 0, errors: 0, skipped: 0 };
  for (const watch of watches) {
    if (Date.now() - started > budgetMs) {
      result.skipped += 1;
      continue;
    }
    try {
      const alerts = await checkWatch(watch);
      result.alertsCreated += await recordWatchCheck(watch, alerts);
      result.checked += 1;
    } catch (error) {
      result.errors += 1;
      console.error(`Watch check failed for ${watch.company}:`, error.message);
    }
  }
  return result;
}
