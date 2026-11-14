/**
 * The model chain: which AI models may write an answer, and in what order.
 *
 * Two promises are kept here.
 *
 * 1. Nothing here can cost money. Only providers with a free plan that
 *    cannot bill are listed (Google Gemini, OpenRouter's ":free" models,
 *    Groq, and NVIDIA's hosted catalogue when a key for it is set), and a
 *    model is only ever called when it is on that provider's allow-list:
 *      - OpenRouter: the id must end in ":free", the catalogue must price it
 *        at zero, and it must be a text model. Anything else is refused.
 *      - Groq: only the chat models on its free plan. If Groq ever reports
 *        paid-plan limits for the key, the provider is switched off.
 *      - Gemini: only the models served on the free tier. (Free only while
 *        the key's Google project has no billing account: that cannot be
 *        checked from here.)
 *    Keys for paid services that may exist in the environment are never read.
 *    A model picked in the menu goes through the same list: an id that is not
 *    on it is ignored.
 *
 * 2. The strongest model that can answer in time is tried first. Every
 *    allowed model has a quality score (from public benchmark results, see
 *    MODEL TABLE below), and the order is that score adjusted by what has
 *    happened on this site: how often the model answered and how often its
 *    answer passed the caller's checks (learning.js, kind 'model'). A model
 *    that is rate limited rests until its limit resets instead of being
 *    asked again on every request.
 *
 * Tasks:
 *   'analysis'  a report that draws conclusions (the deep background check).
 *               Strongest first, more thinking, weak models never used.
 *   'chat'      an ordinary answer (search, data room). Strongest first, but
 *               the few daily calls of the very best models are kept back for
 *               'analysis' once most of them are used.
 *   'extract'   pulling structured facts out of text. High-allowance models
 *               first, since there are many such calls.
 */
import axios from 'axios';
import { loadStats, recordStats, pruneStats, expectedValue } from '../learning';
import { query, persistenceMode } from '../db';

const LIST_CACHE_MS = 6 * 3600 * 1000;
const FALLBACK_RESERVE_MS = 12000;
const MIN_ATTEMPT_MS = 5000;
const MAX_ATTEMPTS = 6;
/** Groq's free plan allows 8,000 tokens a minute; a paid plan reports far more. */
const GROQ_FREE_TPM = 8000;
const GROQ_PAID_TRIPWIRE_TPM = 50000;

/**
 * MODEL TABLE. quality: how good the model is at writing a grounded answer
 * (0-100; a blend of the Artificial Analysis index with its long-context and
 * non-hallucination scores, November 2026). bulk: how suitable it is for many
 * small extraction calls (allowance and structured output). scarce: calls
 * per day on the free plan, and how many of those are kept for 'analysis'.
 * weak: never trusted with a report (poor non-hallucination score).
 * abroad: served by an operator in another jurisdiction than the rest; not
 * used for text about a named person under review.
 */
export const PROVIDERS = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    keyEnv: ['GOOGLE_AI_API_KEY', 'GEMINI_API_KEY'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    resets: 'pacific',
    models: [
      { family: 'gemini-4-hydrogen', re: /^gemini-4-hydrogen$/, quality: 95, bulk: 5, scarce: { perDay: 20, keep: 8 } },
      { family: 'gemini-3.8-flash', re: /^gemini-3\.8-flash$|^gemini-flash-latest$/, quality: 76, bulk: 10, scarce: { perDay: 20, keep: 4 } },
      { family: 'gemini-3.6-flash', re: /^gemini-3\.6-flash$/, quality: 66, bulk: 10 },
      { family: 'gemini-3-flash', re: /^gemini-3-flash-preview$/, quality: 62, bulk: 10 },
      { family: 'gemini-flash', re: /^gemini-(\d+(?:\.\d+)?)-flash$/, quality: 56, bulk: 10, newest: true },
      { family: 'gemini-flash-lite', re: /^gemini-(\d+(?:\.\d+)?)-flash-lite$/, quality: 58, bulk: 85, newest: true },
      { family: 'gemma-4', re: /^gemma-4-31b-it$|^gemma-4-26b-a4b-it$/, quality: 32, bulk: 55, weak: true },
    ],
    fallbackIds: ['gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    keyEnv: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    resets: 'utc',
    models: [
      { family: 'inkling-2-small', re: /inkling-2-small.*:free$/, quality: 75, bulk: 40 },
      { family: 'ling-flash', re: /\/ling-3\.\d+-flash.*:free$/, quality: 71, bulk: 80, abroad: true },
      { family: 'nemotron-3-ultra', re: /nemotron-3-ultra.*:free$/, quality: 61, bulk: 35 },
      { family: 'qwen-3.8', re: /qwen-?3\.8.*:free$/, quality: 60, bulk: 55, abroad: true },
      { family: 'ernie-flash', re: /ernie-5\.\d+-flash.*:free$/, quality: 60, bulk: 75, abroad: true },
      { family: 'nemotron-3.5-super', re: /nemotron-3\.5-super.*:free$/, quality: 56, bulk: 60 },
      { family: 'nemotron-3.5-lightning', re: /nemotron-3\.5-lightning.*:free$/, quality: 46, bulk: 45 },
      { family: 'gemma-4', re: /gemma-4-(31b|26b).*:free$/, quality: 32, bulk: 40, weak: true },
      // A free text model that is not scored yet: usable, but behind every known one.
      { family: 'other-free', re: /:free$/, quality: 38, bulk: 30, weak: true, any: true },
    ],
    exclude: /^openrouter\/|lyria|audio|image|omni|coder|code|particle|flint|nano|lfm|note|1\.7b|2\.6b|guard|embed|rerank/i,
    fallbackIds: ['thinkingmachines/inkling-2-small:free', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3.5-super-vl:free'],
  },
  {
    id: 'groq',
    label: 'Groq',
    keyEnv: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
    smallPromptsOnly: true,
    models: [
      { family: 'qwen-3.8', re: /^qwen\/qwen3\.8-27b$/, quality: 60, bulk: 65, maxOut: 16384 },
      { family: 'gpt-oss-120b', re: /^openai\/gpt-oss-120b$/, quality: 25, bulk: 45, weak: true },
      { family: 'gpt-oss-20b', re: /^openai\/gpt-oss-20b$/, quality: 15, bulk: 40, weak: true },
    ],
    fallbackIds: ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  },
  {
    // Optional: only when the owner has added a key for NVIDIA's hosted catalogue.
    id: 'nvidia',
    label: 'NVIDIA',
    keyEnv: 'NVIDIA_API_KEY',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: [
      { family: 'step-5', re: /^stepfun-ai\/step-5/, quality: 74, bulk: 40 },
      { family: 'mistral-large-4', re: /^mistralai\/mistral-large-4/, quality: 69, bulk: 40 },
      { family: 'glm-5.3-flash', re: /^z-ai\/glm-5\.3-flash/, quality: 68, bulk: 50 },
      { family: 'nemotron-3-ultra', re: /^nvidia\/nemotron-3-ultra/, quality: 61, bulk: 35 },
      { family: 'nemotron-3.5-super', re: /^nvidia\/nemotron-3\.5-super/, quality: 56, bulk: 55 },
      { family: 'deepseek-v4.1-flash', re: /^deepseek-ai\/deepseek-v4\.1-flash/, quality: 50, bulk: 45 },
    ],
    fallbackIds: [],
  },
];

let prunedUsage = false;
const listCache = new Map(); // provider id -> { at, models }
const cooldowns = new Map(); // "provider:model" or "provider:*" -> { until, why }
const quotaCache = new Map(); // provider id -> { at, remaining }

/** The API key for a provider (keyEnv may list alternative names). */
export function providerKey(p) {
  const names = Array.isArray(p.keyEnv) ? p.keyEnv : [p.keyEnv];
  for (const name of names) if (process.env[name]) return process.env[name];
  return null;
}

export function providerEnabled(p) {
  return Boolean(providerKey(p));
}

/** True when at least one provider can be called. */
export function llmConfigured() {
  return PROVIDERS.some(providerEnabled);
}

const versionOf = (id, re) => Number((String(id).match(re) || [])[1] || 0);

/**
 * The allow-list test. Returns the table entry for a model id served by a
 * provider, or null when the model must not be called.
 */
export function allowedEntry(p, raw) {
  const id = String(raw?.id || raw || '').replace(/^models\//, '');
  if (!id) return null;
  if (p.exclude && p.exclude.test(id)) return null;
  if (p.id === 'openrouter') {
    if (!id.endsWith(':free')) return null;
    if (raw && typeof raw === 'object') {
      const pricing = raw.pricing;
      if (pricing && (Number(pricing.prompt) !== 0 || Number(pricing.completion) !== 0)) return null;
      const out = raw.architecture?.output_modalities;
      if (Array.isArray(out) && !(out.length === 1 && out[0] === 'text')) return null;
      if (raw.expiration_date && Date.parse(raw.expiration_date) < Date.now()) return null;
    }
  }
  return p.models.find((m) => m.re.test(id)) || null;
}

async function fetchModelList(p) {
  const headers = { Authorization: `Bearer ${providerKey(p)}` };
  const { data } = await axios.get(`${p.baseUrl}/models`, { headers, timeout: 10000 });
  return Array.isArray(data) ? data : data?.data || [];
}

/**
 * The models a provider serves now that are on its allow-list, one per table
 * entry (the newest when an entry covers several versions), best first.
 */
async function listAllowed(p) {
  const cached = listCache.get(p.id);
  if (cached && Date.now() - cached.at < LIST_CACHE_MS) return cached.models;
  let raw;
  let failed = false;
  try {
    raw = await fetchModelList(p);
  } catch (error) {
    console.warn(`Could not list ${p.label} models:`, error.response?.status || error.message);
    if (cached) return cached.models;
    // The usual ids still pass the same allow-list, so this stays free.
    raw = (p.fallbackIds || []).map((id) => ({ id }));
    failed = true;
  }
  const byFamily = new Map();
  for (const item of raw) {
    const id = String(item?.id || '').replace(/^models\//, '');
    if (item?.type && !/chat|language/i.test(item.type)) continue;
    const entry = allowedEntry(p, { ...item, id });
    if (!entry) continue;
    const candidate = {
      id,
      entry,
      context: item.context_length || item.context_window || null,
      maxOut: item.top_provider?.max_completion_tokens || item.max_completion_tokens || entry.maxOut || null,
      params: Array.isArray(item.supported_parameters) ? item.supported_parameters : null,
    };
    if (entry.any) {
      // every unscored free model is its own option
      byFamily.set(`${entry.family}:${id}`, candidate);
      continue;
    }
    const held = byFamily.get(entry.family);
    if (!held) byFamily.set(entry.family, candidate);
    else if (entry.newest && versionOf(id, entry.re) > versionOf(held.id, entry.re)) byFamily.set(entry.family, candidate);
    else if (!entry.newest && /latest$/.test(held.id) && !/latest$/.test(id)) byFamily.set(entry.family, candidate); // prefer the dated id over its alias
  }
  const models = [...byFamily.values()];
  models.sort((a, b) => b.entry.quality - a.entry.quality);
  // A list built from the usual ids is only kept for ten minutes, then the provider is asked again
  listCache.set(p.id, { at: failed ? Date.now() - LIST_CACHE_MS + 10 * 60000 : Date.now(), models });
  return models;
}

/** Best allowed model ids for a provider, strongest first. */
export async function pickModels(p, max = 2) {
  return (await listAllowed(p)).slice(0, max).map((m) => m.id);
}

// ---------------------------------------------------------------------------
// Limits: resting a model that is out of allowance, and keeping the best for reports
// ---------------------------------------------------------------------------

function msUntilReset(kind) {
  const now = new Date();
  if (kind === 'pacific') {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(now);
    const get = (t) => Number(parts.find((x) => x.type === t)?.value || 0);
    return Math.max(60000, (24 * 3600 - (get('hour') * 3600 + get('minute') * 60 + get('second'))) * 1000);
  }
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(60000, midnight - now.getTime());
}

function dayKey(kind) {
  if (kind === 'pacific') return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  return new Date().toISOString().slice(0, 10);
}

const errorBody = (error) => {
  const data = error.response?.data;
  return Array.isArray(data) ? data[0] : data; // Gemini wraps errors in an array
};

/** Short, user-facing reason a model was skipped (no secrets). */
export function describeFailure(error) {
  const status = error.response?.status;
  const body = errorBody(error);
  const detail = String(body?.error?.message || body?.message || (typeof body === 'string' ? body : '')).slice(0, 160);
  const why = status === 429 ? 'rate limited or out of quota'
    : status === 402 ? 'out of quota'
    : status === 401 || status === 403 ? 'key rejected'
    : status === 404 ? 'model not available'
    : status === 413 ? 'question too long for this model'
    : status === 400 ? 'request rejected'
    : status >= 500 ? 'provider error'
    : /timeout|ECONNABORTED|ETIMEDOUT/i.test(`${error.code || ''} ${error.message || ''}`) ? 'timed out'
    : 'request failed';
  return { why, detail, status: status || null };
}

/** How long to rest a model (or a whole provider) after a failure. */
function restAfter(p, model, error) {
  const status = error.response?.status;
  const { detail } = describeFailure(error);
  const header = Number(error.response?.headers?.['retry-after']);
  if (status === 429) {
    const daily = /per[\s_-]?day|daily|perday|free-models-per-day|\brpd\b|\btpd\b|quota/i.test(detail);
    let ms = Number.isFinite(header) && header > 0 ? header * 1000 : 60000;
    if (daily) ms = Math.max(ms, p.resets ? msUntilReset(p.resets) : 30 * 60000);
    return { key: `${p.id}:${model}`, ms: Math.min(Math.max(ms, 15000), 24 * 3600 * 1000), why: 'rate limited or out of quota' };
  }
  if (status === 402) return { key: `${p.id}:*`, ms: p.resets ? msUntilReset(p.resets) : 6 * 3600 * 1000, why: 'out of quota' };
  if (status === 401 || status === 403) return { key: `${p.id}:*`, ms: 30 * 60000, why: 'key rejected' };
  if (status === 404) return { key: `${p.id}:${model}`, ms: 6 * 3600 * 1000, why: 'model not available' };
  if (status >= 500) return { key: `${p.id}:${model}`, ms: 90000, why: 'provider error' };
  return null;
}

/**
 * A model that has used up its allowance for the day rests on every server
 * instance, not only the one that found out: the rest is written to the
 * database and re-read every couple of minutes.
 */
const SHARED_REST_PREFIX = 'llm-rest:';
let sharedRestsAt = 0;

async function shareRest(key, until, why) {
  if (persistenceMode() === 'none' || !Number.isFinite(until)) return;
  try {
    await query(
      `INSERT INTO source_cache (key, body, fetched_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, fetched_at = now()`,
      [`${SHARED_REST_PREFIX}${key}`, JSON.stringify({ until, why })],
    );
  } catch {
    // best effort
  }
}

async function loadSharedRests() {
  if (persistenceMode() === 'none' || Date.now() - sharedRestsAt < 2 * 60000) return;
  sharedRestsAt = Date.now();
  try {
    const rows = await query('SELECT key, body FROM source_cache WHERE key LIKE $1', [`${SHARED_REST_PREFIX}%`]);
    for (const row of rows || []) {
      const body = typeof row.body === 'string' ? JSON.parse(row.body) : row.body;
      const key = String(row.key).slice(SHARED_REST_PREFIX.length);
      const held = cooldowns.get(key);
      if (body?.until > Date.now() && (!held || held.until < body.until)) cooldowns.set(key, { until: body.until, why: body.why || 'rate limited or out of quota' });
    }
  } catch {
    // best effort
  }
}

function resting(p, model) {
  const now = Date.now();
  for (const key of [`${p.id}:*`, `${p.id}:${model}`]) {
    const c = cooldowns.get(key);
    if (c && c.until > now) return c;
    if (c) cooldowns.delete(key);
  }
  return null;
}

/** OpenRouter says how many free calls are left today; ask at most every few minutes. */
async function openRouterRemaining(p) {
  const cached = quotaCache.get(p.id);
  if (cached && Date.now() - cached.at < 3 * 60000) return cached.remaining;
  let remaining = null;
  try {
    const { data } = await axios.get(`${p.baseUrl}/key`, { headers: { Authorization: `Bearer ${providerKey(p)}` }, timeout: 4000 });
    const box = data?.data?.free_model_daily_requests ?? data?.free_model_daily_requests;
    const n = Number(box?.remaining);
    if (box && Number.isFinite(n)) remaining = n;
  } catch {
    // unknown: carry on as if there is allowance
  }
  quotaCache.set(p.id, { at: Date.now(), remaining });
  return remaining;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

const TASKS = ['analysis', 'chat', 'extract'];
const estimateTokens = (messages) => Math.ceil(messages.reduce((n, m) => n + String(m.content || '').length, 0) / 3.5);
const statKey = (task, c) => `${task}|${c.p.id}:${c.entry.family}`;
const withTimeout = (promise, ms, fallback) => {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]);
};

/**
 * Every model that may be called for this request, best first, with the
 * reason any model was left out.
 */
async function buildChain({ task, preferred, personal, promptTokens, deadline }) {
  const enabled = PROVIDERS.filter(providerEnabled);
  const lists = await Promise.all(enabled.map(async (p) => ({ p, models: await listAllowed(p).catch(() => []) })));
  await withTimeout(loadSharedRests(), 1500, null);
  const [stats, usage] = await Promise.all([
    withTimeout(loadStats('model').catch(() => new Map()), 1500, new Map()),
    withTimeout(loadStats('model-day').catch(() => new Map()), 1500, new Map()),
  ]);
  const skipGeminiForPeople = personal && process.env.LLM_SKIP_GEMINI_FOR_PEOPLE === 'true';
  const openRouter = enabled.find((p) => p.id === 'openrouter');
  const orRemaining = openRouter ? await openRouterRemaining(openRouter) : null;

  const chain = [];
  const left = [];
  for (const { p, models } of lists) {
    for (const m of models) {
      const c = { p, id: m.id, entry: m.entry, maxOut: m.maxOut, params: m.params };
      const base = task === 'extract' ? m.entry.bulk : m.entry.quality;
      const out = (why) => left.push({ provider: p.label, model: m.id, why, base });
      const rest = resting(p, m.id);
      if (rest) { out(rest.why); continue; }
      if (task === 'analysis' && m.entry.weak) continue; // never trusted with a report
      if (personal && m.entry.abroad) continue;
      if (skipGeminiForPeople && p.id === 'gemini') continue;
      if (p.smallPromptsOnly && promptTokens > GROQ_FREE_TPM * 0.75) { out('question too long for this model'); continue; }
      if (m.context && promptTokens > m.context * 0.85) { out('question too long for this model'); continue; }
      if (p.id === 'openrouter' && orRemaining !== null) {
        if (orRemaining <= 0) { out('rate limited or out of quota'); continue; }
        if (task !== 'analysis' && orRemaining <= 10) continue; // the last few calls of the day are for reports
      }
      if (m.entry.scarce && task !== 'analysis') {
        const used = usage.get(`${dayKey(p.resets)}|${p.id}:${m.entry.family}`)?.tries || 0;
        if (used >= m.entry.scarce.perDay - m.entry.scarce.keep) continue; // kept for reports
      }
      const stat = stats.get(statKey(task, c));
      const reliability = expectedValue(stat, 0.85);
      c.base = base;
      c.score = base * (0.55 + 0.45 * reliability);
      c.avgMs = stat && stat.wins >= 3 ? stat.totalMs / stat.wins : null;
      chain.push(c);
    }
  }
  // 'chat': a weak model is a last resort, whatever its score
  chain.sort((a, b) => (task === 'chat' ? Number(Boolean(a.entry.weak)) - Number(Boolean(b.entry.weak)) : 0) || b.score - a.score);

  // The model picked in the menu goes first, if it is on the list.
  const [prefProvider, ...rest] = String(preferred || 'auto').split(':');
  const prefModel = rest.join(':');
  if (prefProvider && prefModel) {
    const i = chain.findIndex((c) => c.p.id === prefProvider && c.id === prefModel);
    if (i > 0) chain.unshift(...chain.splice(i, 1));
  }
  // A model that has been too slow for the time left is not worth starting with.
  if (deadline) {
    const room = deadline - Date.now() - FALLBACK_RESERVE_MS;
    const fits = chain.filter((c) => !c.avgMs || c.avgMs < room);
    const slow = chain.filter((c) => c.avgMs && c.avgMs >= room);
    if (fits.length) return { chain: [...fits, ...slow], left };
  }
  return { chain, left };
}

// ---------------------------------------------------------------------------
// Request settings per provider
// ---------------------------------------------------------------------------

/**
 * Thinking models spend output tokens on reasoning before the answer, so they
 * need room for both, and the amount of thinking is set per task: a report
 * gets more, a plain extraction gets little.
 */
function requestBody(c, messages, { task, maxTokens, temperature, json, promptTokens }) {
  const effort = task === 'analysis' ? 'high' : task === 'extract' ? 'low' : 'medium';
  const body = { model: c.id, messages, temperature };
  const extras = {};
  const id = c.id.toLowerCase();
  if (c.p.id === 'gemini') {
    // Thinking cannot be switched off on current Gemini models and counts against max_tokens.
    body.max_tokens = /^gemma/.test(id) ? maxTokens : Math.max(maxTokens + (effort === 'high' ? 12000 : effort === 'medium' ? 6000 : 3000), 8000);
    if (!/^gemma/.test(id)) extras.reasoning_effort = effort;
  } else if (c.p.id === 'groq') {
    // Groq counts the answer allowance against the per-minute limit, so it must fit beside the question.
    const room = Math.max(600, GROQ_FREE_TPM - 300 - promptTokens);
    body.max_completion_tokens = Math.min(maxTokens, room, c.maxOut || maxTokens);
    if (/gpt-oss/.test(id)) { extras.reasoning_effort = effort; extras.include_reasoning = false; }
    else if (/qwen/.test(id)) { extras.reasoning_effort = task === 'extract' ? 'none' : 'high'; extras.reasoning_format = 'hidden'; }
  } else if (c.p.id === 'openrouter') {
    const thinks = !c.params || c.params.includes('reasoning');
    body.max_tokens = thinks ? Math.max(maxTokens + (effort === 'high' ? 8000 : 4000), 8000) : maxTokens;
    if (c.maxOut) body.max_tokens = Math.min(body.max_tokens, c.maxOut);
    if (thinks) extras.reasoning = { effort, exclude: true };
  } else {
    body.max_tokens = maxTokens;
  }
  if (json) {
    const structured = c.p.id === 'gemini' || c.p.id === 'groq' || (c.p.id === 'openrouter' && c.params && (c.params.includes('structured_outputs') || c.params.includes('response_format')));
    if (structured) extras.response_format = { type: 'json_schema', json_schema: { name: json.name || 'result', ...(c.p.id === 'gemini' ? {} : { strict: true }), schema: json.schema } };
  }
  return { body, extras };
}

const cleanText = (data) => String(data?.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

/**
 * Chat completion with fallback across every allowed model.
 *
 * @param {Array<{role, content}>} messages
 * @param {{ preferred?: string, task?: 'analysis'|'chat'|'extract', maxTokens?: number, temperature?: number,
 *           timeoutMs?: number, deadline?: number, personal?: boolean, accept?: (text: string) => boolean,
 *           json?: { name?: string, schema: object } }} options
 *   preferred: "provider:model" from the model menu, or "auto". Ignored unless it is on the allow-list.
 *   deadline: epoch ms by which the whole chain must finish (serverless time
 *     limit). Each attempt leaves FALLBACK_RESERVE_MS for the next one.
 *   personal: the text is about a named person under review; models served
 *     from another jurisdiction are left out.
 *   accept: the caller's own check of the answer (structure, citations). An
 *     answer that fails it counts as a failure of that model and the next
 *     model is asked, instead of the caller giving up on AI altogether.
 * @returns {Promise<{ text, provider, providerLabel, model, family, skipped, ms } | null>}
 *   null when no provider is configured or every model failed.
 *   skipped: models tried first that failed, e.g. [{ model, provider, why }]
 */
export async function chatComplete(messages, { preferred = 'auto', task = 'chat', maxTokens = 3000, temperature = 0.2, timeoutMs = 60000, deadline = null, personal = false, accept = null, json = null } = {}) {
  if (!llmConfigured()) return null;
  const kind = TASKS.includes(task) ? task : 'chat';
  const promptTokens = estimateTokens(messages);
  const { chain, left } = await buildChain({ task: kind, preferred, personal, promptTokens, deadline });
  const attempts = chain.slice(0, MAX_ATTEMPTS);
  const errors = [];
  const skipped = [];
  const outcomes = [];
  const used = [];
  const shared = [];
  let result = null;

  for (const [i, c] of attempts.entries()) {
    const { p } = c;
    let attemptMs = timeoutMs;
    if (deadline) {
      const remaining = deadline - Date.now();
      const isLast = i === attempts.length - 1;
      attemptMs = Math.min(timeoutMs, isLast ? remaining : remaining - FALLBACK_RESERVE_MS);
      if (!isLast && attemptMs < MIN_ATTEMPT_MS) attemptMs = Math.min(timeoutMs, remaining); // no room to reserve
      if (attemptMs < MIN_ATTEMPT_MS) {
        errors.push(`${p.id}:${c.id} not tried (out of time)`);
        break;
      }
    }
    // `learn`: running out of allowance says nothing about how good a model is, so it is not held against it
    const fail = (why, note, learn = true) => {
      errors.push(`${p.id}:${c.id} ${note || why}`);
      skipped.push({ provider: p.label, model: c.id, why });
      if (learn) outcomes.push({ key: statKey(kind, c), win: 0, ms: 0 });
    };
    const started = Date.now();
    try {
      const headers = { Authorization: `Bearer ${providerKey(p)}`, 'Content-Type': 'application/json', ...(p.id === 'openrouter' ? { 'X-Title': 'Research Hub' } : {}) };
      const { body, extras } = requestBody(c, messages, { task: kind, maxTokens, temperature, json, promptTokens });
      if (c.entry.scarce) used.push({ key: `${dayKey(p.resets)}|${p.id}:${c.entry.family}`, win: 1 });
      let response;
      try {
        response = await axios.post(`${p.baseUrl}/chat/completions`, { ...body, ...extras }, { headers, timeout: attemptMs });
      } catch (error) {
        // A provider that rejects the extra settings: retry without them
        if (error.response?.status !== 400 || Object.keys(extras).length === 0) throw error;
        response = await axios.post(`${p.baseUrl}/chat/completions`, body, { headers, timeout: Math.max(MIN_ATTEMPT_MS, deadline ? Math.min(attemptMs, deadline - Date.now()) : attemptMs) });
      }
      const { data } = response;
      // Tripwires: proof, after the fact, that a call was not on a free plan. Stop using the provider.
      if (p.id === 'groq' && Number(response.headers?.['x-ratelimit-limit-tokens']) > GROQ_PAID_TRIPWIRE_TPM) {
        cooldowns.set(`${p.id}:*`, { until: Infinity, why: 'switched off: the key is on a paid plan' });
        console.error('Groq reports paid-plan limits for this key: Groq is switched off until the server restarts.');
      }
      if (p.id === 'openrouter' && data?.model && !String(data.model).endsWith(':free')) {
        cooldowns.set(`${p.id}:*`, { until: Infinity, why: 'switched off: a paid model answered' });
        console.error(`OpenRouter answered with ${data.model}, which is not a free model: OpenRouter is switched off until the server restarts.`);
      }
      const text = cleanText(data);
      if (!text) {
        fail(data?.choices?.[0]?.finish_reason === 'length' ? 'ran out of tokens before answering' : 'empty response');
        continue;
      }
      if (typeof accept === 'function') {
        let ok = false;
        try { ok = Boolean(accept(text)); } catch { ok = false; }
        if (!ok) { fail('answer did not pass checks'); continue; }
      }
      const ms = Date.now() - started;
      outcomes.push({ key: statKey(kind, c), win: 1, ms });
      // Stronger models that were resting or could not take this request are part of the story too
      const passedOver = left.filter((x) => x.base > c.base).map(({ provider, model, why }) => ({ provider, model, why }));
      result = { text, provider: p.id, providerLabel: p.label, model: c.id, family: c.entry.family, skipped: [...passedOver, ...skipped], ms };
      break;
    } catch (error) {
      const f = describeFailure(error);
      const quota = f.status === 429 || f.status === 402 || f.status === 401 || f.status === 403;
      fail(f.why, `${f.status || error.message}${f.detail ? ` (${f.detail})` : ''}`, !quota);
      const rest = restAfter(p, c.id, error);
      if (rest) {
        const until = Date.now() + rest.ms;
        cooldowns.set(rest.key, { until, why: rest.why });
        if (rest.ms >= 10 * 60000) shared.push(shareRest(rest.key, until, rest.why));
      }
      if (error.response?.status === 404) listCache.delete(p.id);
    }
  }

  // Remember what happened, so the next request starts with what works.
  await withTimeout(Promise.all([
    recordStats('model', outcomes).catch(() => {}),
    used.length ? recordStats('model-day', used).catch(() => {}) : null,
    used.length && !prunedUsage ? pruneStats('model-day', 3).catch(() => {}) : null,
    ...shared,
  ]), 1500, null);
  if (used.length) prunedUsage = true;

  if (result) {
    if (skipped.length) console.warn('LLM fallback:', errors.join('; '));
    return result;
  }
  if (errors.length) console.warn('All LLM attempts failed:', errors.join('; '));
  return null;
}

/** The first JSON object or array in a model's reply, or null. */
export function parseJsonReply(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = s.search(/[[{]/);
  if (start < 0) return null;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * Ask for structured data. Uses each model's own structured-output mode
 * where it has one, and otherwise reads the JSON out of the reply; a reply
 * that is not valid JSON (or fails `check`) sends the request to the next model.
 *
 * @param {Array<{role, content}>} messages
 * @param {{ schema: object, name?: string, check?: (data: any) => boolean } & object} options  plus any chatComplete option
 * @returns {Promise<{ data: any, provider, model, family, skipped } | null>}
 */
export async function chatJson(messages, { schema, name = 'result', check = null, ...options } = {}) {
  const guide = { role: 'system', content: `Reply with one JSON value only, no prose and no code fence. It must match this JSON Schema:\n${JSON.stringify(schema)}` };
  const out = await chatComplete([guide, ...messages], {
    task: 'extract',
    maxTokens: 2000,
    temperature: 0,
    ...options,
    json: { name, schema },
    accept: (text) => {
      const data = parseJsonReply(text);
      return data !== null && (typeof check !== 'function' || Boolean(check(data)));
    },
  });
  if (!out) return null;
  return { data: parseJsonReply(out.text), provider: out.provider, providerLabel: out.providerLabel, model: out.model, family: out.family, skipped: out.skipped };
}

/**
 * Tell the chain how an answer turned out after the fact (for example a
 * second check found claims the sources do not support), so the model's
 * standing reflects more than whether it replied.
 * @param {{ provider: string, family: string }} result from chatComplete
 * @param {boolean|number} good
 * @param {'analysis'|'chat'|'extract'} task
 */
export async function reportAnswerQuality(result, good, task = 'chat') {
  if (!result?.provider || !result?.family) return;
  await recordStats('model', [{ key: `${task}|${result.provider}:${result.family}`, win: good, ms: 0 }]).catch(() => {});
}

/**
 * The order the chain would use right now for a task, without calling any
 * model (for the diagnostics route and for tests).
 * @returns {Promise<{ order: Array<{ provider, model, score }>, passedOver: Array<{ provider, model, why }> }>}
 */
export async function describeChain({ task = 'chat', personal = false } = {}) {
  if (!llmConfigured()) return { order: [], passedOver: [] };
  const { chain, left } = await buildChain({ task: TASKS.includes(task) ? task : 'chat', preferred: 'auto', personal, promptTokens: 500, deadline: null });
  return {
    order: chain.map((c) => ({ provider: c.p.label, model: c.id, score: Number(c.score.toFixed(1)) })),
    passedOver: left.map(({ provider, model, why }) => ({ provider, model, why })),
  };
}

/** Options for the model menu: the models that can be called now, strongest first. */
export async function availableModels(max = 8) {
  const options = [];
  for (const p of PROVIDERS.filter(providerEnabled)) {
    try {
      for (const m of await listAllowed(p)) {
        if (m.entry.any) continue; // unscored models are fallbacks, not menu choices
        options.push({ id: `${p.id}:${m.id}`, provider: p.id, model: m.id, label: `${m.id.split('/').pop().replace(/:free$/, '')} · ${p.label}`, free: true, quality: m.entry.quality, resting: Boolean(resting(p, m.id)) });
      }
    } catch (error) {
      console.warn(`Could not list ${p.label} models:`, error.response?.status || error.message);
    }
  }
  options.sort((a, b) => b.quality - a.quality);
  return options.slice(0, max);
}

export function llmStatus() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    free: true,
    keySet: Boolean(providerKey(p)),
    enabled: providerEnabled(p),
    note: p.id === 'gemini' && providerKey(p) ? 'Stays within the free plan only while the key\'s Google project has no billing account' : null,
  }));
}

/** For tests. */
export function __resetLlmForTests() {
  listCache.clear();
  cooldowns.clear();
  quotaCache.clear();
  sharedRestsAt = 0;
  prunedUsage = false;
}
