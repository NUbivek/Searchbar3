import { logger } from '../../../utils/logger';
import { performCombinedSearch } from '../../../utils/combinedSearch';
import { normalizeSearchResponseV1 } from '../../../utils/contracts/searchResponse';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const { query } = req.body;
  if (!query) {
    return res.status(400).json({ message: 'Query is required' });
  }

  const failSoft = (message, error) => normalizeSearchResponseV1({
    results: [],
    sources: [],
    status: 'fail-soft',
    degradedSources: ['pitchbook'],
    message,
    error,
    synthesis: {
      enabled: false,
      provider: null,
      model: null,
      content: null,
    },
  });

  try {
    const sources = await performCombinedSearch(query, 'pitchbook');
    return res.status(200).json(normalizeSearchResponseV1({
      sources,
      results: Array.isArray(sources) ? sources : [],
      status: 'ok',
      degradedSources: [],
      synthesis: {
        enabled: false,
        provider: null,
        model: null,
        content: null,
      },
      llmProcessed: false,
    }));
  } catch (error) {
    logger.error('Pitchbook search failed:', error);
    return res.status(200).json(failSoft('Search failed', error.message));
  }
}
