import { selfBaseUrl } from '../serverBaseUrl';
import axios from 'axios';
import { logger } from '../logger';

export async function searchReddit(query) {
  const searchId = Math.random().toString(36).substring(7);
  logger.debug(`[${searchId}] Searching Reddit`, { query });

  try {
    // Use base URL from environment if available
    const baseUrl = selfBaseUrl();
    const response = await axios.get(`${baseUrl}/api/search/reddit`, {
      params: {
        query,
        limit: 20, // Increase result limit for better coverage
        sort: 'relevance',
        time: 'all' // Get results from all time for better coverage
      },
      timeout: 15000 // 15 second timeout
    });

    if (!response.data?.results || !Array.isArray(response.data.results)) {
      logger.warn(`[${searchId}] Reddit returned no results or invalid format`);
      return getFallbackResults(query);
    }

    const results = response.data.results
      .filter(post => post && (post.title || post.selftext)) // Filter out empty posts
      .map(post => ({
        source: 'Reddit',
        type: 'RedditResult',
        title: post.title || 'Untitled Reddit Post',
        content: formatRedditContent(post),
        url: post.permalink 
          ? `https://reddit.com${post.permalink}` 
          : `https://reddit.com/search?q=${encodeURIComponent(query)}`,
        timestamp: post.created_utc 
          ? new Date(post.created_utc * 1000).toISOString() 
          : new Date().toISOString(),
        author: post.author || 'Unknown',
        subreddit: post.subreddit_name_prefixed || 'r/unknown',
        score: post.score || 0,
        relevanceScore: calculateRelevance(post, query)
      }));

    logger.info(`[${searchId}] Successfully retrieved ${results.length} Reddit results`);
    return results.length > 0 ? results : getFallbackResults(query);
  } catch (error) {
    logger.error(`[${searchId}] Reddit search error:`, error.message);
    return getFallbackResults(query);
  }
}

// Format Reddit content to be more comprehensive
function formatRedditContent(post) {
  const title = post.title || 'Untitled';
  const selftext = post.selftext || '';
  const url = post.url || '';
  const subreddit = post.subreddit_name_prefixed || 'r/unknown';
  const author = post.author || 'Unknown';
  const score = post.score || 0;
  const numComments = post.num_comments || 0;
  
  let content = `# ${title}\n\n`;
  
  if (selftext) {
    // Include full post text for comprehensive content
    content += `${selftext}\n\n`;
  }
  
  content += `**Subreddit**: ${subreddit}\n`;
  content += `**Author**: u/${author}\n`;
  content += `**Score**: ${score} upvotes\n`;
  content += `**Comments**: ${numComments}\n`;
  
  if (url && !url.includes('reddit.com')) {
    content += `**External Link**: ${url}\n`;
  }
  
  return content;
}

// Calculate relevance score for sorting
function calculateRelevance(post, query) {
  if (!post) return 0;
  
  const queryTerms = query.toLowerCase().split(/\s+/);
  let score = 0;
  
  // Score title matches highly
  if (post.title) {
    const titleLower = post.title.toLowerCase();
    queryTerms.forEach(term => {
      if (titleLower.includes(term)) score += 10;
    });
  }
  
  // Score content matches
  if (post.selftext) {
    const textLower = post.selftext.toLowerCase();
    queryTerms.forEach(term => {
      if (textLower.includes(term)) score += 5;
    });
  }
  
  // Weight by Reddit score and comment count
  score += (post.score || 0) * 0.01;
  score += (post.num_comments || 0) * 0.05;
  
  return score;
}

// Provide fallback results if the API fails
function getFallbackResults(query) {
  return [{
    source: 'Reddit',
    type: 'RedditSearch',
    title: `Reddit Search: ${query}`,
    content: `Search Reddit for discussions about "${query}".\n\nReddit is a collection of communities where people can find entertaining, engaging, and informative discussions about virtually any topic.\n\nClick to view search results on Reddit.`,
    url: `https://reddit.com/search?q=${encodeURIComponent(query)}`,
    timestamp: new Date().toISOString(),
    relevanceScore: 50
  }];
}
