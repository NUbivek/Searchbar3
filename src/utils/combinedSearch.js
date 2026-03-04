import axios from 'axios';
import { logger } from './logger';
import { withRetry } from './errorHandling';
import { rateLimit } from './rateLimiter';

// Function to extract text content from HTML
function extractTextFromHtml(html) {
  // Remove script and style tags and their contents
  html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
             .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  
  // Remove all HTML tags
  html = html.replace(/<[^>]+>/g, ' ');
  
  // Replace multiple spaces with single space
  html = html.replace(/\s+/g, ' ');
  
  // Decode HTML entities
  html = html.replace(/&nbsp;/g, ' ')
             .replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"');
  
  return html.trim();
}

// Function to scrape content from a URL
async function scrapeUrl(url) {
  try {
    const response = await withRetry(() => axios.get(url, {
      headers: {
        'User-Agent': 'Searchbar/1.0.0'
      },
      timeout: 10000
    }));

    return extractTextFromHtml(response.data);
  } catch (error) {
    logger.error(`Failed to scrape URL ${url}:`, error);
    return '';
  }
}

// Function to search a specific domain using web search
async function searchDomain(query, domain, serperApiKey) {
  try {
    const response = await withRetry(() => axios.post(
      'https://google.serper.dev/search',
      {
        q: `site:${domain} ${query}`,
        num: 10
      },
      {
        headers: {
          'X-API-KEY': serperApiKey,
          'Content-Type': 'application/json'
        }
      }
    ));

    return response.data.organic || [];
  } catch (error) {
    logger.error(`Failed to search domain ${domain}:`, error);
    return [];
  }
}

// Main function to perform combined search
export async function performCombinedSearch(query, source) {
  const searchId = Math.random().toString(36).substring(7);
  logger.info(`[${searchId}] Starting combined search for ${source} with query: ${query}`);

  const serperApiKey = process.env.SERPER_API_KEY;
  if (!serperApiKey) {
    logger.warn(`[${searchId}] Serper API key not configured. Returning degraded empty set for ${source}.`);
    return [];
  }

  let domain;
  let type;
  switch (source.toLowerCase()) {
    case 'crunchbase':
      domain = 'crunchbase.com';
      type = 'CrunchbaseResult';
      break;
    case 'pitchbook':
      domain = 'pitchbook.com';
      type = 'PitchbookResult';
      break;
    case 'substack':
      domain = 'substack.com';
      type = 'SubstackResult';
      break;
    case 'medium':
      domain = 'medium.com';
      type = 'MediumResult';
      break;
    default:
      logger.warn(`[${searchId}] Unsupported source '${source}'. Returning degraded empty set.`);
      return [];
  }

  // First, get search results from the domain
  const searchResults = await searchDomain(query, domain, serperApiKey);

  // Then, scrape content from each result
  const settled = await Promise.allSettled(searchResults.map(async (result, index) => {
    const content = await scrapeUrl(result.link);

    return {
      type,
      content: content || result.snippet || '',
      url: result.link,
      timestamp: new Date().toISOString(),
      title: result.title || '',
      confidence: 1,
      sourceId: `${source.toLowerCase()}-${index}`
    };
  }));

  const sources = settled
    .filter(item => item.status === 'fulfilled')
    .map(item => item.value);

  logger.info(`[${searchId}] Combined search completed for ${source}`);
  return sources.filter(source => source.content);
}
