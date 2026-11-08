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
 *
 * Email digests (optional): when RESEND_API_KEY is set, each scheduled run
 * emails every user whose watches produced new alerts one digest, sent with
 * Resend's free tier. ALERT_EMAIL_FROM sets the sender (defaults to Resend's
 * onboarding address, which can only deliver to the Resend account owner).
 */
import { searchCuratedSources } from '../utils/sources/curatedIndex';
import { searchHackerNews } from '../utils/sources/hackernewsAlgolia';
import { dueWatches, recordWatchCheck } from './store';
import { query } from './db';

const RESEND_URL = 'https://api.resend.com/emails';
const DIGEST_MAX_PER_COMPANY = 10;

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

export function emailAlertsConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Subject, plain text and HTML for one user's new alerts, grouped by company. */
export function renderAlertDigest(companies, { baseUrl = '' } = {}) {
  const groups = (companies || []).filter((c) => c && c.alerts && c.alerts.length);
  const total = groups.reduce((n, c) => n + c.alerts.length, 0);
  const names = groups.map((c) => c.company);
  const subject = `${total} new alert${total === 1 ? '' : 's'}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`;
  const link = baseUrl ? `${baseUrl.replace(/\/$/, '')}/watchlist` : '/watchlist';
  const text = [
    ...groups.map((c) => [
      `${c.company} (${c.alerts.length})`,
      ...c.alerts.slice(0, DIGEST_MAX_PER_COMPANY).map((a) => `- [${ALERT_KINDS[a.kind] || a.kind}] ${a.title}${a.sourceName ? ` (${a.sourceName}${a.publishedAt ? `, ${String(a.publishedAt).slice(0, 10)}` : ''})` : ''}\n  ${a.url}`),
      ...(c.alerts.length > DIGEST_MAX_PER_COMPANY ? [`  and ${c.alerts.length - DIGEST_MAX_PER_COMPANY} more`] : []),
      '',
    ].join('\n')),
    `All alerts: ${link}`,
    'You get this email because you watch these companies in Research Hub. Remove a company from your watchlist to stop its alerts.',
  ].join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#1f2937">
${groups.map((c) => `<h3 style="margin:16px 0 6px">${escapeHtml(c.company)} <span style="color:#6b7280;font-weight:normal">(${c.alerts.length})</span></h3>
<ul style="margin:0;padding-left:18px">${c.alerts.slice(0, DIGEST_MAX_PER_COMPANY).map((a) => `<li style="margin:4px 0"><span style="color:#6b7280">[${escapeHtml(ALERT_KINDS[a.kind] || a.kind)}]</span> <a href="${escapeHtml(a.url)}">${escapeHtml(a.title)}</a>${a.sourceName ? ` <span style="color:#6b7280">(${escapeHtml(a.sourceName)}${a.publishedAt ? `, ${escapeHtml(String(a.publishedAt).slice(0, 10))}` : ''})</span>` : ''}</li>`).join('')}${c.alerts.length > DIGEST_MAX_PER_COMPANY ? `<li style="color:#6b7280">and ${c.alerts.length - DIGEST_MAX_PER_COMPANY} more</li>` : ''}</ul>`).join('')}
<p style="margin-top:16px"><a href="${escapeHtml(link)}">All alerts</a></p>
<p style="color:#6b7280;font-size:12px">You get this email because you watch these companies in Research Hub. Remove a company from your watchlist to stop its alerts.</p>
</div>`;
  return { subject, text, html, total };
}

/** Send one digest with Resend. Throws on failure; never logs the key. */
export async function sendAlertDigest({ to, companies, baseUrl }, { fetchImpl = globalThis.fetch } = {}) {
  if (!emailAlertsConfigured()) throw new Error('Email alerts are not configured (RESEND_API_KEY).');
  const digest = renderAlertDigest(companies, { baseUrl });
  if (!digest.total) return false;
  const r = await fetchImpl(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.ALERT_EMAIL_FROM || 'Research Hub <onboarding@resend.dev>',
      to: [to],
      subject: digest.subject,
      text: digest.text,
      html: digest.html,
    }),
  });
  if (!r.ok) {
    let detail = '';
    try { detail = String((await r.json())?.message || '').slice(0, 120); } catch { /* no body */ }
    throw new Error(`Resend returned ${r.status}${detail ? `: ${detail}` : ''}`);
  }
  return true;
}

/** Alerts stored for a watch since a point in time (the ones this run created). */
async function alertsSince(watchId, sinceMs) {
  return query(
    `SELECT kind, title, url, source_name AS "sourceName", published_at AS "publishedAt"
       FROM alerts WHERE watch_id = $1 AND created_at >= $2::timestamptz
       ORDER BY created_at DESC LIMIT 50`,
    [watchId, new Date(sinceMs).toISOString()]
  );
}

/**
 * Cron entry point: check the watches that are due (oldest first) and record
 * new alerts. Stops starting new checks once the time budget is used. When
 * email is configured, users with new alerts get one digest each.
 */
export async function runDueWatchChecks({ limit = 25, olderThanMinutes = 360, budgetMs = 50000, baseUrl = process.env.NEXTAUTH_URL || process.env.NEXT_PUBLIC_BASE_URL || '' } = {}) {
  const started = Date.now();
  const watches = await dueWatches(olderThanMinutes, limit);
  const result = { due: watches.length, checked: 0, alertsCreated: 0, errors: 0, skipped: 0, emailsSent: 0, emailErrors: 0, emailConfigured: emailAlertsConfigured() };
  const digests = new Map(); // user_id -> [{ company, alerts }]
  for (const watch of watches) {
    if (Date.now() - started > budgetMs) {
      result.skipped += 1;
      continue;
    }
    try {
      const checkStarted = Date.now() - 1000;
      const alerts = await checkWatch(watch);
      const created = await recordWatchCheck(watch, alerts);
      result.alertsCreated += created;
      result.checked += 1;
      if (created > 0 && result.emailConfigured) {
        const fresh = await alertsSince(watch.id, checkStarted);
        if (fresh.length) {
          if (!digests.has(watch.user_id)) digests.set(watch.user_id, []);
          digests.get(watch.user_id).push({ company: watch.company, alerts: fresh });
        }
      }
    } catch (error) {
      result.errors += 1;
      console.error(`Watch check failed for ${watch.company}:`, error.message);
    }
  }
  for (const [userId, companies] of digests) {
    try {
      const [user] = await query('SELECT email FROM users WHERE id = $1', [userId]);
      if (!user?.email) continue;
      if (await sendAlertDigest({ to: user.email, companies, baseUrl })) result.emailsSent += 1;
    } catch (error) {
      result.emailErrors += 1;
      console.error('Alert email failed:', error.message);
    }
  }
  return result;
}
