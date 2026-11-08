/**
 * Open Research search: the endpoint behind the main search box.
 *
 * Pipeline (src/server/search):
 *   1. understandQuery  - entity ("open ai"), intent ("funding"), recency ("latest")
 *   2. retrieve         - every selected source, query rewritten per source
 *   3. resolveEntity    - confirm the entity from how sources write it ("OpenAI")
 *   4. filterAndRank    - drop results not about it; date filter; rank by
 *                         entity, intent, recency and source tier; collapse
 *                         duplicates; the user's own documents always kept
 *   5. claim check (cross-source figures, same numbering as the results)
 *   6. generateAnswer   - free LLM chain with citation checks, else quoted digest
 * The response contract (results, status, degradedSources, content,
 * sourceMap, categories, ...) is unchanged for the UI.
 */
import { logger } from '../../../utils/logger';
import { processCategories } from '../../../components/search/categories/processors/CategoryProcessor';
import { normalizeSearchResponseV1 } from '../../../utils/contracts/searchResponse';
import { getUserId } from '../../../server/auth';
import { checkClaims } from '../../../utils/claimCheck';
import { recordSearch } from '../../../server/store';
import { understandQuery, resolveEntity } from '../../../server/search/queryPlan';
import { retrieve } from '../../../server/search/retrieve';
import { filterAndRank } from '../../../server/search/rank';
import { generateAnswer } from '../../../server/search/answer';

/** Save this search to the signed-in user's history (never breaks the search). */
async function saveToHistory(req, res, { query, sources, workspaceId, content, results }) {
  try {
    const userId = await getUserId(req, res);
    if (!userId) return null;
    const topSources = (results || []).slice(0, 15).map((r) => ({
      title: r.title, url: r.url || r.link, source: r.source, sourceName: r.sourceName || null,
      date: r.date || r.publishedAt || null, snippet: String(r.snippet || r.content || '').slice(0, 400)
    }));
    const saved = await recordSearch(userId, {
      workspaceId: typeof workspaceId === 'string' ? workspaceId : null,
      query, sources, summary: typeof content === 'string' ? content : '', topSources, resultCount: (results || []).length
    });
    return saved?.id || null;
  } catch (error) {
    logger.warn('Search history not saved:', error.message);
    return null;
  }
}

// Must list every source the UI offers; unlisted ones are dropped.
const VALID_SOURCES = ['curated', 'web', 'linkedin', 'twitter', 'reddit', 'substack', 'medium', 'crunchbase', 'pitchbook', 'carta', 'verified'];

export function normalizeSources(input) {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(',').map((s) => s.trim())
      : [];
  const aliasMap = { x: 'twitter', 'x.com': 'twitter', 'verified sources': 'verified', 'curated sources': 'curated' };
  const normalized = raw
    .map((source) => String(source || '').trim().toLowerCase())
    .map((source) => aliasMap[source] || source)
    .filter((source) => VALID_SOURCES.includes(source));
  return normalized.length > 0 ? Array.from(new Set(normalized)) : ['curated', 'web'];
}

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
  maxDuration: 60,
};

const toArray = (value) => (Array.isArray(value) ? value : value == null || value === '' ? [] : [value]);
const parseFile = (f) => {
  if (f && typeof f === 'object') return f;
  try { return JSON.parse(f); } catch { return null; }
};

// Leave headroom under maxDuration (60s) for categories, history and the response
const ANSWER_DEADLINE_MS = 50000;

export default async function handler(req, res) {
  const startedAt = Date.now();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const query = String(body.query || '').trim();
    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }
    if (query.length > 500) {
      return res.status(400).json({ error: 'Query is too long (500 characters max)' });
    }

    // The UI posts form-encoded data: single values arrive as strings and
    // booleans as "true"/"false".
    const sources = normalizeSources(body.sources);
    const customUrls = toArray(body.customUrls).map(String).filter((u) => /^https?:\/\//i.test(u));
    const files = [...toArray(body.uploadedFiles), ...toArray(body.files)].map(parseFile).filter(Boolean);
    const useLLM = !(body.useLLM === false || body.useLLM === 'false');
    const maxAgeDays = Math.max(0, Number(body.maxAgeDays) || 0);
    const model = typeof body.model === 'string' && body.model ? body.model : 'auto';
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : null;

    // 1-2. Understand the query and retrieve from every selected source
    const plan = understandQuery(query);
    logger.info('Open search:', { query, sources, entity: plan.entityCandidate, intents: plan.intents, recency: plan.recency });
    const { results: raw, statuses } = await retrieve(plan, sources, { customUrls, files });

    // 3-5. Resolve the entity; keep only relevant results in the date range
    // (undated kept and flagged), ranked and capped; the user's own
    // documents are always kept. Then the cross-source claim check, numbered
    // by the same list the UI shows.
    const entity = resolveEntity(plan, raw);
    const { results, droppedForRelevance, olderThanFilter } = filterAndRank(raw, plan, entity, { limit: 15, maxAgeDays });
    let claimCheck = null;
    try {
      claimCheck = checkClaims(results, { entity: entity.mode === 'entity' ? entity.name : null });
    } catch (claimError) {
      logger.warn('Claim check failed:', claimError.message);
    }

    // Degraded = a selected source failed. A source that is not configured
    // (no web search key) or that worked but had nothing is not degraded.
    const degradedSources = statuses.filter((s) => s.status === 'error').map((s) => s.source);

    // 6. Answer
    let answer = { content: null, sourceMap: {}, llm: null };
    if (results.length > 0) {
      answer = await generateAnswer(plan, entity, results, { model, useLLM, deadline: startedAt + ANSWER_DEADLINE_MS });
    }

    let categories = [];
    try {
      categories = results.length ? await processCategories(results, query, { includeBusinessMetrics: true }) : [];
    } catch (categoryError) {
      logger.warn('Category generation failed:', categoryError.message);
    }
    if ((!categories || categories.length === 0) && answer.categories) categories = answer.categories;

    const historyId = results.length > 0
      ? await saveToHistory(req, res, { query, sources, workspaceId, content: answer.content, results })
      : null;

    return res.status(200).json(normalizeSearchResponseV1({
      historyId,
      query,
      timestamp: new Date().toISOString(),
      results,
      status: results.length > 0 ? (degradedSources.length > 0 ? 'degraded' : 'ok') : 'fail-soft',
      degradedSources,
      sourceStatuses: statuses,
      queryPlan: {
        entity: entity.mode === 'entity' ? entity.name : null,
        mode: entity.mode,
        confidence: entity.confidence || null,
        intents: plan.intents,
        recency: plan.recency,
        droppedForRelevance,
        olderThanFilter,
      },
      claimCheck,
      maxAgeDays: maxAgeDays || null,
      olderThanFilter,
      content: answer.content,
      sourceMap: answer.sourceMap,
      isLLMResult: Boolean(answer.content),
      __isImmutableLLMResult: Boolean(answer.content),
      llmProcessed: Boolean(answer.llm),
      synthesis: {
        enabled: Boolean(answer.llm),
        provider: answer.llm?.providerLabel || null,
        model: answer.llm?.model || null,
        content: null,
      },
      answerInfo: answer.llm
        ? { mode: 'ai', provider: answer.llm.providerLabel, model: answer.llm.model, confidence: answer.llm.confidence, skipped: answer.llm.skipped || [], ...(answer.llm.modelNote ? { modelNote: answer.llm.modelNote } : {}) }
        : results.length > 0
          ? { mode: 'quoted', reason: answer.fallbackReason || null, ...(answer.modelNote ? { modelNote: answer.modelNote } : {}) }
          : null,
      metadata: { generatedAt: new Date().toISOString(), totalSources: results.length },
      categories,
      ...(results.length === 0 ? {
        failSoftContent: {
          message: olderThanFilter > 0
            ? `No results within the selected date range: ${olderThanFilter} result${olderThanFilter === 1 ? ' was' : 's were'} older than the filter.`
            : entity.mode === 'entity' || plan.entityCandidate
              ? `No source returned results about "${entity.name || plan.entityCandidate || query}".`
              : 'No live sources returned results right now.',
          suggestions: [
            ...(olderThanFilter > 0 ? ['Widen the Published filter to see older results'] : []),
            'Check the spelling of the company or person',
            ...(statuses.some((s) => s.source === 'web' && s.status === 'not_configured') ? ['Enable web search for broader coverage'] : []),
            'Try fewer words, e.g. just the company name'
          ]
        }
      } : {}),
    }));
  } catch (error) {
    logger.error('Error in open search API:', error);
    return res.status(200).json(normalizeSearchResponseV1({
      results: [],
      status: 'fail-soft',
      degradedSources: ['open-search'],
      error: 'An error occurred during search',
      message: error.message,
      content: null,
      categories: []
    }));
  }
}
