/**
 * GET /api/llm/models -> models the search can use right now.
 * Free providers first (Groq, OpenRouter free); Together only with
 * LLM_ALLOW_PAID=true. Lists only models each provider serves today.
 */
import { availableModels, llmStatus } from '../../../server/llm/providers';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const models = await availableModels();
  res.setHeader('Cache-Control', 'private, max-age=300');
  return res.status(200).json({
    models: models.map(({ id, label, free }) => ({ id, label, free })),
    providers: llmStatus().map(({ id, label, free, enabled, note }) => ({ id, label, free, enabled, note })),
  });
}
