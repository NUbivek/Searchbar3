/**
 * LLM provider chain (OpenAI-compatible chat APIs).
 *
 * Free first: Groq (GROQ_API_KEY), then OpenRouter free models
 * (OPENROUTER_API_KEY). Together (TOGETHER_API_KEY) is paid, so it is only
 * used when LLM_ALLOW_PAID=true.
 *
 * Each provider's live model list is fetched (and cached) and the best
 * preferred model that is actually served today is chosen, so a retired
 * model id can no longer silently break summaries.
 */
import axios from 'axios';

const CACHE_MS = 6 * 3600 * 1000;

export const PROVIDERS = [
  {
    id: 'groq',
    label: 'Groq',
    free: true,
    keyEnv: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
    preferred: [/^openai\/gpt-oss-120b$/, /^qwen\/qwen3[.\d-]*-?\d*b?/i, /^openai\/gpt-oss-20b$/, /llama-3\.3-70b/i, /llama-4/i],
    exclude: /whisper|guard|tts|orpheus|safeguard|compound/i,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (free)',
    free: true,
    keyEnv: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    preferred: [/^nvidia\/nemotron-3-ultra.*:free$/, /^google\/gemma-4-31b.*:free$/, /^qwen\/.*:free$/, /^deepseek\/.*:free$/, /^nvidia\/nemotron.*:free$/, /:free$/],
    exclude: /lyria|vl:free|omni|audio|image|coder|code:free|1\.7b|2\.6b/i,
    onlyFree: true,
  },
  {
    id: 'together',
    label: 'Together (paid)',
    free: false,
    keyEnv: 'TOGETHER_API_KEY',
    baseUrl: 'https://api.together.xyz/v1',
    preferred: [/^openai\/gpt-oss-120b$/i, /qwen3[.\d]*-?(max|plus)/i, /qwen3/i, /deepseek-v4/i, /llama-3\.3-70b-instruct/i],
    exclude: /embed|rerank|vision|image|audio|whisper|guard|flux|bge|tts/i,
  },
];

const modelCache = new Map();

export function providerEnabled(p) {
  if (!process.env[p.keyEnv]) return false;
  if (!p.free && process.env.LLM_ALLOW_PAID !== 'true') return false;
  return true;
}

async function listModels(p) {
  const cached = modelCache.get(p.id);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.models;
  const { data } = await axios.get(`${p.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${process.env[p.keyEnv]}` },
    timeout: 10000,
  });
  const raw = Array.isArray(data) ? data : data?.data || [];
  let models = raw.map((m) => ({
    id: m.id,
    free: p.free && (!p.onlyFree || String(m.id).endsWith(':free') || (String(m.pricing?.prompt) === '0' && String(m.pricing?.completion) === '0')),
    context: m.context_length || m.context_window || null,
    type: m.type || null,
  }));
  if (p.onlyFree) models = models.filter((m) => m.free);
  models = models.filter((m) => !p.exclude.test(m.id) && (!m.type || /chat|language/i.test(m.type)));
  modelCache.set(p.id, { at: Date.now(), models });
  return models;
}

/** Best available models for a provider, in preference order. */
export async function pickModels(p, max = 2) {
  const models = await listModels(p);
  const picked = [];
  for (const re of p.preferred) {
    const hit = models.find((m) => re.test(m.id) && !picked.includes(m.id));
    if (hit) picked.push(hit.id);
    if (picked.length >= max) break;
  }
  return picked;
}

/** Options for the model menu: Auto plus the models each enabled provider serves now. */
export async function availableModels() {
  const options = [];
  for (const p of PROVIDERS.filter(providerEnabled)) {
    try {
      for (const id of await pickModels(p, 3)) {
        options.push({ id: `${p.id}:${id}`, provider: p.id, model: id, label: `${id.split('/').pop().replace(/:free$/, '')} · ${p.label}`, free: p.free });
      }
    } catch (error) {
      console.warn(`Could not list ${p.label} models:`, error.response?.status || error.message);
    }
  }
  return options;
}

/**
 * Reasoning models (gpt-oss, Qwen 3, DeepSeek R1) can spend the whole token
 * budget thinking, or put <think> text in the answer. Keep reasoning short
 * and hidden so the answer itself fits.
 */
function reasoningSettings(providerId, model) {
  const m = String(model).toLowerCase();
  if (/gpt-oss/.test(m)) {
    return providerId === 'openrouter' ? { reasoning: { effort: 'low', exclude: true } } : { reasoning_effort: 'low' };
  }
  if (/qwen3|qwq|deepseek-r1|r1-distill/.test(m)) {
    if (providerId === 'groq') return { reasoning_format: 'hidden' };
    if (providerId === 'openrouter') return { reasoning: { exclude: true } };
  }
  return {};
}

/**
 * Chat completion with fallback across providers/models.
 * @param {Array<{role, content}>} messages
 * @param {{ preferred?: string, maxTokens?: number, temperature?: number, timeoutMs?: number }} options
 *   preferred: "provider:model" from the model menu, or "auto"
 * @returns {Promise<{ text, provider, model } | null>} null when no provider is configured or all fail
 */
export async function chatComplete(messages, { preferred = 'auto', maxTokens = 3000, temperature = 0.2, timeoutMs = 60000 } = {}) {
  const attempts = [];
  const enabled = PROVIDERS.filter(providerEnabled);
  const [prefProvider, ...prefModelParts] = String(preferred || 'auto').split(':');
  const prefModel = prefModelParts.join(':');
  const pref = enabled.find((p) => p.id === prefProvider);
  if (pref && prefModel) attempts.push({ p: pref, model: prefModel });
  for (const p of enabled) {
    try {
      for (const model of await pickModels(p, 2)) {
        if (!attempts.some((a) => a.p.id === p.id && a.model === model)) attempts.push({ p, model });
      }
    } catch (error) {
      console.warn(`Model list failed for ${p.label}:`, error.response?.status || error.message);
    }
  }
  const errors = [];
  for (const { p, model } of attempts) {
    try {
      const headers = { Authorization: `Bearer ${process.env[p.keyEnv]}`, 'Content-Type': 'application/json', ...(p.id === 'openrouter' ? { 'X-Title': 'Research Hub' } : {}) };
      const base = { model, messages, max_tokens: maxTokens, temperature };
      const extras = reasoningSettings(p.id, model);
      let data;
      try {
        ({ data } = await axios.post(`${p.baseUrl}/chat/completions`, { ...base, ...extras }, { headers, timeout: timeoutMs }));
      } catch (error) {
        // A provider that rejects the reasoning settings: retry without them
        if (error.response?.status !== 400 || Object.keys(extras).length === 0) throw error;
        ({ data } = await axios.post(`${p.baseUrl}/chat/completions`, base, { headers, timeout: timeoutMs }));
      }
      const text = String(data?.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      if (!text && data?.choices?.[0]?.finish_reason === 'length') {
        errors.push(`${p.id}:${model} ran out of tokens before answering`);
        continue;
      }
      if (text) return { text, provider: p.id, providerLabel: p.label, model };
      errors.push(`${p.id}:${model} empty response`);
    } catch (error) {
      errors.push(`${p.id}:${model} ${error.response?.status || error.message}`);
    }
  }
  if (errors.length) console.warn('All LLM attempts failed:', errors.join('; '));
  return null;
}

export function llmStatus() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    free: p.free,
    keySet: Boolean(process.env[p.keyEnv]),
    enabled: providerEnabled(p),
    note: !p.free && process.env[p.keyEnv] && process.env.LLM_ALLOW_PAID !== 'true' ? 'Paid provider: set LLM_ALLOW_PAID=true to use it' : null,
  }));
}
