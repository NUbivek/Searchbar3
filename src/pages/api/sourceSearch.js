import axios from 'axios';
import { normalizeSearchResponseV1 } from '../../utils/contracts/searchResponse';

const SOURCE_TIMEOUT_MS = 10000;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { source, query, apiKey } = req.query;

  const failSoft = (source, error) => normalizeSearchResponseV1({
    source,
    results: [],
    status: 'fail-soft',
    degradedSources: [String(source || 'unknown').toLowerCase()],
    error: error || 'Source search failed',
    synthesis: {
      enabled: false,
      provider: null,
      model: null,
      content: null,
    },
  });

  try {
    let results;

    switch (source) {
      case 'LinkedIn':
        results = await searchLinkedIn(query, apiKey);
        break;
      case 'X':
        results = await searchTwitter(query, apiKey);
        break;
      case 'Reddit':
        results = await searchReddit(query, apiKey);
        break;
      default:
        return res.status(200).json(
          failSoft(source, `Unsupported source: ${source}`)
        );
    }

    const providerResults = results && typeof results === 'object' ? results : {};
    const normalizedResults = Array.isArray(providerResults.results)
      ? providerResults.results
      : Array.isArray(providerResults.items)
        ? providerResults.items
        : [];

    res.status(200).json(normalizeSearchResponseV1({
      ...providerResults,
      source,
      status: 'ok',
      results: normalizedResults,
      degradedSources: [],
      synthesis: {
        enabled: false,
        provider: null,
        model: null,
        content: null,
      },
      llmProcessed: false,
      legacyResults: providerResults,
    }));
  } catch (error) {
    console.error(`${source} search error:`, error);
    res.status(200).json(
      failSoft(source, error.message || `${source} search failed`)
    );
  }
}

async function searchLinkedIn(query, apiKey) {
  const response = await axios.get('https://api.linkedin.com/v2/search', {
    headers: { Authorization: `Bearer ${apiKey}` },
    params: { q: query, count: 10 },
    timeout: SOURCE_TIMEOUT_MS,
  });
  return response.data;
}

async function searchTwitter(query, apiKey) {
  const response = await axios.get('https://api.twitter.com/2/tweets/search/recent', {
    headers: { Authorization: `Bearer ${apiKey}` },
    params: { query, max_results: 10 },
    timeout: SOURCE_TIMEOUT_MS,
  });
  return response.data;
}

async function searchReddit(query, apiKey) {
  const response = await axios.get('https://oauth.reddit.com/search', {
    headers: { Authorization: `Bearer ${apiKey}` },
    params: { q: query, limit: 10 },
    timeout: SOURCE_TIMEOUT_MS,
  });
  return response.data;
} 
