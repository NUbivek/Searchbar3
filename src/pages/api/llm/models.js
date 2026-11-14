/**
 * GET /api/llm/models -> models the search can use right now, strongest
 * first. Only models on the allow-list in src/server/llm/providers.js (ones
 * that cost nothing) and that each provider serves today.
 */
import { availableModels, llmStatus } from '../../../server/llm/providers';

// Probes each provider's model list; Vercel's default function limit is 10s.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const models = await availableModels();
  res.setHeader('Cache-Control', 'private, max-age=300');
  return res.status(200).json({
    models: models.map(({ id, label, free, resting }) => ({ id, label, free, resting })),
    providers: llmStatus().map(({ id, label, free, enabled, note }) => ({ id, label, free, enabled, note })),
  });
}
