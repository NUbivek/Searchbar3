import axios from 'axios';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { source, query, apiKey } = req.query;

  const failSoft = (source, error) => ({
    source,
    results: [],
    status: 'fail-soft',
    degradedSources: [String(source || 'unknown').toLowerCase()],
    error: error || 'Source search failed'
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

    res.status(200).json(results);
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
    params: { q: query, count: 10 }
  });
  return response.data;
}

async function searchTwitter(query, apiKey) {
  const response = await axios.get('https://api.twitter.com/2/tweets/search/recent', {
    headers: { Authorization: `Bearer ${apiKey}` },
    params: { query, max_results: 10 }
  });
  return response.data;
}

async function searchReddit(query, apiKey) {
  const response = await axios.get('https://oauth.reddit.com/search', {
    headers: { Authorization: `Bearer ${apiKey}` },
    params: { q: query, limit: 10 }
  });
  return response.data;
} 
