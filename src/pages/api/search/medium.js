import axios from 'axios';
import { logger } from '../../../utils/logger';
import { normalizeSearchResponseV1 } from '../../../utils/contracts/searchResponse';

const SEARCH_TIMEOUT_MS = 10000;

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
    degradedSources: ['medium'],
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
    const serperApiKey = process.env.SERPER_API_KEY;
    if (!serperApiKey) {
      return res.status(200).json(failSoft('Search failed', 'Serper API key not configured'));
    }

    const response = await axios.post(
      'https://google.serper.dev/search',
      {
        q: `site:medium.com ${query}`,
        num: 10
      },
      {
        headers: {
          'X-API-KEY': serperApiKey,
          'Content-Type': 'application/json'
        },
        timeout: SEARCH_TIMEOUT_MS,
      }
    );

    const sources = [];
    
    if (response.data?.organic) {
      const organicResults = response.data.organic
        .filter(result => result.link && result.title)
        .map((result, index) => ({
          type: 'MediumResult',
          content: result.snippet || '',
          url: result.link,
          timestamp: new Date().toISOString(),
          title: result.title,
          confidence: 1,
          sourceId: `medium-${index}`
        }));
      sources.push(...organicResults);
    }

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
    logger.error('Medium search failed:', error);
    return res.status(200).json(failSoft('Search failed', error.message));
  }
}
