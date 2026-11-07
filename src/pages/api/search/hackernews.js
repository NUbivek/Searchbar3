import { searchHackerNews } from '../../../utils/sources/hackernewsAlgolia';
import { normalizeSearchResponseV1 } from '../../../utils/contracts/searchResponse';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const query = req.method === 'GET' ? req.query.q : req.body?.query;
  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  try {
    const results = await searchHackerNews(query);

    return res.status(200).json(normalizeSearchResponseV1({
      query,
      source: 'hackernews',
      results,
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
    return res.status(200).json(normalizeSearchResponseV1({
      query,
      source: 'hackernews',
      results: [],
      degraded: true,
      status: 'fail-soft',
      degradedSources: ['hackernews'],
      error: error.message,
      synthesis: {
        enabled: false,
        provider: null,
        model: null,
        content: null,
      },
      llmProcessed: false,
    }));
  }
}
