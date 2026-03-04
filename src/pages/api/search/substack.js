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
    degradedSources: ['substack'],
    message,
    error
  });

  try {
    const serperApiKey = process.env.SERPER_API_KEY;
    if (!serperApiKey) {
      return res.status(200).json(failSoft('Search failed', 'Serper API key not configured'));
    }

    const response = await axios.post(
      'https://google.serper.dev/search',
      {
        q: `site:substack.com ${query}`,
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
          type: 'SubstackResult',
          content: result.snippet || '',
          url: result.link,
          timestamp: new Date().toISOString(),
          title: result.title,
          confidence: 1,
          sourceId: `substack-${index}`
        }));
      sources.push(...organicResults);
    }

    return res.status(200).json({ sources });

  } catch (error) {
    logger.error('Substack search failed:', error);
    return res.status(200).json(failSoft('Search failed', error.message));
  }
}
