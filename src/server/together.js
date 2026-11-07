/**
 * Plain completion helper used by data-room Q&A and claim checking.
 * Now backed by the provider chain in ./llm/providers.js (free Groq and
 * OpenRouter first; paid Together only with LLM_ALLOW_PAID=true). The names
 * are kept for compatibility with existing callers.
 *
 * Returns null when no provider is configured or every call fails, so
 * callers fall back to an extractive (quoted) answer instead of guessing.
 */
import { chatComplete, PROVIDERS, providerEnabled } from './llm/providers';

export function togetherConfigured() {
  return PROVIDERS.some(providerEnabled);
}

/**
 * @param {string} prompt
 * @param {{ model?: string, maxTokens?: number, temperature?: number, timeoutMs?: number }} options
 * @returns {Promise<{ text: string, model: string } | null>}
 */
export async function completeWithTogether(prompt, { model = 'auto', maxTokens = 1200, temperature = 0.2, timeoutMs = 45000 } = {}) {
  const out = await chatComplete([{ role: 'user', content: prompt }], { preferred: model, maxTokens, temperature, timeoutMs });
  return out ? { text: out.text, model: `${out.provider}:${out.model}` } : null;
}
