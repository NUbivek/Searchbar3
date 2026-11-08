/**
 * Filter and rank retrieved results for a query plan.
 *  - Entity queries: drop results that do not name the entity (as a proper
 *    noun). Topic queries: drop results matching under half the topic words.
 *  - Date filter (before the result cap, so a filtered search still shows
 *    everything in range; undated items are kept and flagged).
 *  - Rank by entity placement, intent match, recency (heavily for "latest"),
 *    and source tier (filings > reputable press > blogs > forums).
 *  - Collapse near-duplicates (same story syndicated across feeds, same URL).
 *  - The user's own documents and URLs are never capped out: they come first.
 */
import { INTENTS } from './queryPlan';
import { tierInfo, filterByAge } from '../../utils/sourceTiers';

const TIER_POINTS = { filing: 1.5, press: 1.2, blog: 0.5, other: 0.4, forum: 0.2 };
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const ageDays = (r) => {
  const t = Date.parse(r.publishedAt || r.date || r.timestamp || '');
  return Number.isNaN(t) ? null : (Date.now() - t) / 86400000;
};
const isUserDoc = (r) => r.source === 'file' || r.source === 'custom';

/** Same page whatever the scheme, query string, hash or trailing slash. */
export function normalizeUrl(url) {
  if (!url || url === '#') return null;
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${path}`;
  } catch {
    return String(url).toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '') || null;
  }
}

function topicMatch(r, plan) {
  const words = (plan.entityTokens.length ? plan.entityTokens : plan.query.split(/\s+/)).map((w) => w.toLowerCase());
  const text = norm(`${r.title} ${r.content || r.snippet}`);
  const hits = words.filter((w) => new RegExp(`(^| )${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(text)).length;
  return words.length ? hits / words.length : 1;
}

/**
 * @param {Object[]} results
 * @param {Object} plan from understandQuery
 * @param {{ mode: 'entity'|'topic', matcher?, inTitle? }} entity from resolveEntity
 * @param {{ maxAgeDays?: number, limit?: number }} options
 * @returns {{ results, droppedForRelevance, olderThanFilter }}
 */
export function filterAndRank(results, plan, entity, { limit = 15, maxAgeDays = 0 } = {}) {
  const relevant = results.filter((r) => {
    if (isUserDoc(r)) return true;
    if (entity.mode === 'entity') return entity.matcher(r);
    return topicMatch(r, plan) >= 0.5;
  });
  // Date filter runs before the cap; the user's own documents are never filtered
  const docs = relevant.filter(isUserDoc);
  const kept = [...docs, ...filterByAge(relevant.filter((r) => !isUserDoc(r)), maxAgeDays)];
  const olderThanFilter = relevant.length - kept.length;

  const intentRes = plan.intents.map((i) => INTENTS[i]);
  const scored = kept.map((r) => {
    let score = 0;
    const why = [];
    if (entity.mode === 'entity') {
      if (entity.inTitle(r)) { score += 4; why.push('named in title'); } else { score += 2; why.push('named in text'); }
    } else {
      score += 3 * topicMatch(r, plan);
    }
    // Intent counts fully only when it is about the entity (same headline)
    const entityInTitle = entity.mode !== 'entity' || entity.inTitle(r);
    for (const re of intentRes) {
      if (re.test(r.title || '')) { score += entityInTitle ? 2.5 : 0.8; why.push('intent in title'); } else if (re.test(r.content || r.snippet || '')) { score += entityInTitle ? 1 : 0.4; why.push('intent in text'); }
    }
    const age = ageDays(r);
    if (age != null) {
      score += plan.recency ? Math.max(0, 4 - age / 45) : Math.max(0, 1.5 - age / 365);
      if (plan.recency && age > 365) score -= 1.5;
    } else if (plan.recency) {
      score -= 0.5; // undated is weaker evidence for "latest"
    }
    const tier = tierInfo(r);
    score += TIER_POINTS[tier.tier] ?? 0.4;
    if (isUserDoc(r)) { score += 2; why.push('your document'); }
    return { r: { ...r, sourceTier: tier.tier, sourceTierLabel: tier.label, rankScore: Number(score.toFixed(2)), rankReasons: why }, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Collapse near-duplicates: same page URL, same normalized title, or same opening text
  const seen = new Set();
  const userDocs = [];
  const others = [];
  for (const { r } of scored) {
    const u = normalizeUrl(r.url || r.link);
    const t = norm(r.title).slice(0, 90);
    const lead = norm(r.content || r.snippet).slice(0, 120);
    if ((u && seen.has(`u:${u}`)) || (t && seen.has(`t:${t}`)) || (lead.length > 40 && seen.has(`l:${lead}`))) continue;
    if (u) seen.add(`u:${u}`);
    if (t) seen.add(`t:${t}`);
    if (lead.length > 40) seen.add(`l:${lead}`);
    if (isUserDoc(r)) userDocs.push(r);
    else if (others.length < limit) others.push(r);
  }
  return { results: [...userDocs, ...others], droppedForRelevance: results.length - relevant.length, olderThanFilter };
}
