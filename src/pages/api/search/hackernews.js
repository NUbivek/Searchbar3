export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const query = req.method === 'GET' ? req.query.q : req.body?.query;
  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  try {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=10`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(url, { signal: controller.signal });
    const data = await r.json();
    clearTimeout(timeout);

    const results = (data.hits || []).map((hit) => ({
      title: hit.title || hit.story_title || 'Untitled',
      url: hit.url || hit.story_url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      content: hit.story_text || hit.comment_text || '',
      snippet: hit.story_text || hit.comment_text || '',
      source: 'hackernews',
      timestamp: hit.created_at || new Date().toISOString(),
      score: hit.points || 0
    }));

    return res.status(200).json({ query, source: 'hackernews', results });
  } catch (error) {
    return res.status(200).json({
      query,
      source: 'hackernews',
      results: [],
      degraded: true,
      error: error.message
    });
  }
}
