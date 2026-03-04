// LLM processing and search functionality temporarily disabled for simplification
import { logger } from '../../utils/logger';
import { normalizeSearchResponseV1 } from '../../utils/contracts/searchResponse';

export default async function handler(req, res) {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  try {
    // Set headers
    res.setHeader('Content-Type', 'application/json');
    
    // Log request
    logger.debug('API request (simplified):', {
      method: req.method,
      url: req.url,
      body: req.body
    });

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    if (req.method !== 'POST') {
      return res.status(405).json({
        error: 'Method not allowed',
        allowedMethods: ['POST']
      });
    }

    const { query, model, sources = ['Web'] } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    logger.debug('Simplified Open Search API', { query, sources });
    
    // Return a simple placeholder response with empty results
    // This endpoint no longer performs actual searches or LLM processing
    const simplifiedResponse = normalizeSearchResponseV1({
      query,
      model: model || 'mistral-7b',
      sources,
      timestamp: new Date().toISOString(),
      message: 'Search processing has been simplified. No results will be returned.',
      results: [],
      status: 'ok',
      degradedSources: [],
      synthesis: {
        enabled: false,
        provider: null,
        model: model || 'mistral-7b',
        content: null,
      },
      llmProcessed: false,
    });

    return res.status(200).json(simplifiedResponse);
  } catch (error) {
    logger.error('API error (simplified):', error);

    return res.status(200).json(normalizeSearchResponseV1({
      status: 'fail-soft',
      results: [],
      degradedSources: ['open-search-simplified'],
      error: 'An error occurred in the simplified search handler',
      message: error.message,
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
