import axios from 'axios';
import { logger } from '../../../utils/logger';
import { normalizeSearchResponseV1 } from '../../../utils/contracts/searchResponse';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const query = req.method === 'GET' ? req.query.query : req.body.query;
  if (!query) {
    return res.status(400).json({ message: 'Query is required' });
  }

  const failSoft = (message, error) => normalizeSearchResponseV1({
    results: [],
    sources: [],
    status: 'fail-soft',
    degradedSources: ['reddit'],
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
          q: `site:reddit.com ${query}`,
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
            type: 'RedditResult',
            content: result.snippet || '',
            url: result.link,
            timestamp: new Date().toISOString(),
            title: result.title,
            confidence: 1,
            sourceId: `reddit-${index}`
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
      logger.error('Reddit search and fallback failed:', { original: originalError, fallback: fallbackError });
      return res.status(200).json(
        failSoft('Search failed', fallbackError.message || originalError?.message || null)
      );
    }
  };

  try {
    const clientId = process.env.REDDIT_CLIENT_ID;
    const clientSecret = process.env.REDDIT_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return runSerperFallback(new Error('Reddit credentials not configured'));
    }

    // First, get an access token
    const tokenResponse = await axios.post(
      'https://www.reddit.com/api/v1/access_token',
      new URLSearchParams({
        grant_type: 'client_credentials'
      }).toString(),
      {
        auth: {
          username: clientId,
          password: clientSecret
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Searchbar/1.0.0 (by /u/BivekAdhikari)'
        }
      }
    );
    const accessToken = tokenResponse.data.access_token;

    // Use the access token to search Reddit
    const searchResponse = await axios.get(
      'https://oauth.reddit.com/search',
      {
        params: {
          q: query,
          sort: 'relevance',
          limit: 10,
          t: 'month'
        },
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'User-Agent': 'Searchbar/1.0.0 (by /u/BivekAdhikari)'
        }
      }
    );

    const sources = searchResponse.data.data.children.map((post, index) => ({
      type: 'RedditResult',
      content: post.data.selftext || post.data.title || '',
      url: `https://reddit.com${post.data.permalink}`,
      timestamp: new Date(post.data.created_utc * 1000).toISOString(),
      title: post.data.title || '',
      confidence: 1,
      sourceId: `reddit-${index}`,
      metadata: {
        score: post.data.score,
        subreddit: post.data.subreddit,
        author: post.data.author
      }
    }));

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
