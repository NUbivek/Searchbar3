/**
 * Filter and rank retrieved results for a query plan.
 *  - Entity queries: drop results that do not name the entity (as a proper
 *    noun). Topic queries: drop results matching under half the topic words.
 *  - Rank by entity placement, intent match, recency (heavily for "latest"),
 *    and source tier (filings > reputable press > blogs > forums).
 *  - Collapse near-duplicates (same story syndicated across feeds).
 */
import { INTENTS } from './queryPlan';
import { tierInfo } from '../../utils/sourceTiers';

const TIER_POINTS = { filing: 1.5, press: 1.2, blog: 0.5, other: 0.4, forum: 0.2 };
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const ageDays = (r) => {
  const t = Date.parse(r.publishedAt || r.date || r.timestamp || '');
  return Number.isNaN(t) ? null : (Date.now() - t) / 86400000;
};

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
 */
export function filterAndRank(results, plan, entity, { limit = 15 } = {}) {
  const userDocs = (r) => r.source === 'file' || r.source === 'custom';
  const kept = results.filter((r) => {
    if (userDocs(r)) return true;
    if (entity.mode === 'entity') return entity.matcher(r);
    return topicMatch(r, plan) >= 0.5;
  });

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
    if (userDocs(r)) score += 2;
    return { r: { ...r, sourceTier: tier.tier, sourceTierLabel: tier.label, rankScore: Number(score.toFixed(2)), rankReasons: why }, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Collapse near-duplicates: same normalized title, or same opening text
  const seen = new Set();
  const out = [];
  for (const { r } of scored) {
    const t = norm(r.title).slice(0, 90);
    const lead = norm(r.content || r.snippet).slice(0, 120);
    if ((t && seen.has(`t:${t}`)) || (lead.length > 40 && seen.has(`l:${lead}`))) continue;
    if (t) seen.add(`t:${t}`);
    if (lead.length > 40) seen.add(`l:${lead}`);
    out.push(r);
    if (out.length >= limit) break;
  }
  return { results: out, droppedForRelevance: results.length - kept.length };
}
