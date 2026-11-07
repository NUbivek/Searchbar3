/**
 * Minimal Together.ai completion call for features other than the main
 * search answer (data-room Q&A, claim checking). Uses the same model list
 * and serverless fallback as utils/llmProcessing.js.
 *
 * Returns null when TOGETHER_API_KEY is missing or every call fails, so
 * callers fall back to an extractive (quoted) answer instead of guessing.
 */
import axios from 'axios';
import { MODEL_ENDPOINTS } from '../utils/llmProcessing';

const FALLBACK_MODEL = 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo';
const ENDPOINT = 'https://api.together.xyz/v1/completions';

export function togetherConfigured() {
  return Boolean(process.env.TOGETHER_API_KEY);
}

/**
 * @param {string} prompt
 * @param {{ model?: string, maxTokens?: number, temperature?: number, timeoutMs?: number }} options
 * @returns {Promise<{ text: string, model: string } | null>}
 */
export async function completeWithTogether(prompt, { model = 'mixtral-8x7b', maxTokens = 1200, temperature = 0.2, timeoutMs = 45000 } = {}) {
  const apiKey = process.env.TOGETHER_API_KEY;
  if (!apiKey) return null;
  const preferred = MODEL_ENDPOINTS[model]?.modelId || model;
  for (const modelId of [...new Set([preferred, FALLBACK_MODEL])]) {
    try {
      const { data } = await axios.post(
        ENDPOINT,
        { model: modelId, prompt, max_tokens: maxTokens, temperature, stop: ['</answer>'] },
        { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: timeoutMs }
      );
      const text = data?.choices?.[0]?.text?.trim();
      if (text) return { text, model: modelId };
    } catch (error) {
      console.warn(`Together call failed for ${modelId}:`, error.response?.status || error.message);
    }
  }
  return null;
}
