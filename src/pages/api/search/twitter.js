import axios from 'axios';
import { logger } from '../../../utils/logger';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const { query } = req.body;
  if (!query) {
    return res.status(400).json({ message: 'Query is required' });
  }

  const failSoft = (message, error) => ({
    sources: [],
    status: 'fail-soft',
    degradedSources: ['twitter'],
    message,
    error
  });

  try {
    const twitterApiKey = process.env.TWITTER_API_KEY;
    if (twitterApiKey) {
      // Try Twitter API first
      try {
        const response = await axios.get(
          'https://api.twitter.com/2/tweets/search/recent',
          {
            params: {
              query: query,
              max_results: 10,
              'tweet.fields': 'created_at,author_id,public_metrics,text'
            },
            headers: {
              'Authorization': `Bearer ${twitterApiKey}`,
              'User-Agent': 'Searchbar/1.0.0'
            }
          }
        );

        if (response.data.data) {
          const sources = response.data.data.map((tweet, index) => ({
            type: 'TwitterResult',
            content: tweet.text || '',
            url: `https://twitter.com/i/web/status/${tweet.id}`,
            timestamp: tweet.created_at,
            title: `Tweet by ${tweet.author_id}`,
            confidence: 1.0,
            sourceId: `twitter-${index}`,
            metadata: {
              likes: tweet.public_metrics?.like_count || 0,
              retweets: tweet.public_metrics?.retweet_count || 0
            }
          }));

          return res.status(200).json({ sources });
        }
      } catch (twitterError) {
        logger.error('Twitter API failed:', twitterError);
      }
    }

    // Fallback to Serper if Twitter API fails
    const serperApiKey = process.env.SERPER_API_KEY;
    if (!serperApiKey) {
      return res.status(200).json(failSoft('Search failed', 'Serper API key not configured'));
    }

    const response = await axios.post(
      'https://google.serper.dev/search',
      {
        q: `site:twitter.com ${query}`,
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
          type: 'TwitterResult',
          content: result.snippet || '',
          url: result.link,
          timestamp: new Date().toISOString(),
          title: result.title,
          confidence: 1,
          sourceId: `twitter-${index}`
        }));
      sources.push(...organicResults);
    }

    return res.status(200).json({ sources });

  } catch (error) {
    logger.error('Twitter search failed:', error);
    return res.status(200).json(failSoft('Search failed', error.message));
  }
}
