import axios from 'axios';
import { logger } from '../../../utils/logger';
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
    degradedSources: ['linkedin'],
    message,
    error,
    synthesis: {
      enabled: false,
      provider: null,
      model: null,
      content: null,
    },
  });

  const runSerperFallback = async (originalError = null) => {
    try {
      const serperApiKey = process.env.SERPER_API_KEY;
      if (!serperApiKey) {
        return res.status(200).json(
          failSoft('Search failed', 'Serper API key not configured')
        );
      }

      const response = await axios.post(
        'https://google.serper.dev/search',
        {
          q: `site:linkedin.com ${query}`,
          num: 10
        },
        {
          headers: {
            'X-API-KEY': serperApiKey,
            'Content-Type': 'application/json'
          }
        }
      );

      const sources = [];
      if (response.data?.organic) {
        const organicResults = response.data.organic
          .filter(result => result.link && result.title)
          .map((result, index) => ({
            type: 'LinkedInResult',
            content: result.snippet || '',
            url: result.link,
            timestamp: new Date().toISOString(),
            title: result.title,
            confidence: 1,
            sourceId: `linkedin-${index}`
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
    } catch (fallbackError) {
      logger.error('LinkedIn search and fallback failed:', { original: originalError, fallback: fallbackError });
      return res.status(200).json(
        failSoft('Search failed', fallbackError.message || originalError?.message || null)
      );
    }
  };

  try {
    const clientId = process.env.LINKEDIN_CLIENT_ID;
    const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return runSerperFallback(new Error('LinkedIn credentials not configured'));
    }
    // First, get an access token
    const tokenResponse = await axios.post(
      'https://www.linkedin.com/oauth/v2/accessToken',
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const accessToken = tokenResponse.data.access_token;

    // Use the access token to search LinkedIn
    const searchResponse = await axios.get(
      'https://api.linkedin.com/v2/search',
      {
        params: {
          q: query,
          count: 10,
          start: 0
        },
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'X-Restli-Protocol-Version': '2.0.0',
          'LinkedIn-Version': '202401'
        }
      }
    );

    // Process and format the results
    const sources = searchResponse.data.elements?.map((result, index) => ({
      type: 'LinkedInResult',
      content: result.text || result.description || '',
      url: result.url || `https://www.linkedin.com/feed/update/${result.id}`,
      timestamp: result.created?.time || new Date().toISOString(),
      title: result.title || '',
      confidence: 1,
      sourceId: `linkedin-${index}`
    })) || [];

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
    return runSerperFallback(error);
  }
}
