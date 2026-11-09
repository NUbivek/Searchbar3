/**
 * Hacker News stories via the public Algolia API (no key required).
 * Shared by /api/search/hackernews and the search routes' no-key fallback,
 * so they call it directly instead of making HTTP calls to themselves.
 */
export async function searchHackerNews(query, { limit = 10, timeoutMs = 8000 } = {}) {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${limit}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    if (!r.ok) throw new Error(`Hacker News search returned ${r.status}`);
    const data = await r.json();
    return (data.hits || []).map((hit) => ({
      title: hit.title || hit.story_title || 'Untitled',
      url: hit.url || hit.story_url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
      content: hit.story_text || hit.comment_text || '',
      snippet: hit.story_text || hit.comment_text || '',
      source: 'hackernews',
      timestamp: hit.created_at || null, // never invent a date
      score: hit.points || 0
    }));
  } finally {
    clearTimeout(timeout);
  }
}
