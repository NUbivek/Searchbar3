import axios from 'axios';
import { deepWebSearch } from './deepWebSearch';
import { debug, info, error, warn } from './logger';
import { SourceTypes } from './constants';

/**
 * Search for results within a specific domain using Serper API
 * @param {string} query - The search query
 * @param {string} domain - Domain to search within
 * @param {string} searchId - Unique identifier for logging
 * @returns {Array} - Formatted search results
 */
export const searchWithSerper = async (query, domain, searchId) => {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    warn(`[${searchId}] Serper API key not configured for ${domain}. Returning fail-soft empty set.`);
    return [];
  }

  try {
    const response = await axios.post('https://google.serper.dev/search', 
      { 
        q: `site:${domain} ${query}`,
        num: 10
      },
      { 
        headers: { 
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.data?.organic) {
      return [];
    }

    return response.data.organic
      .filter(result => result.link && result.link.includes(domain))
      .map(result => ({
        source: domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1),
        type: 'SearchResult',
        content: `${result.title}\n${result.snippet || ''}`,
        url: result.link,
        timestamp: new Date().toISOString(),
        title: result.title
      }));
  } catch (error) {
    error(`[${searchId}] Serper API error for ${domain}:`, error.message);
    return [{
      source: domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1),
      type: 'SearchError',
      content: `Unable to search ${domain} at this time. Please try again later.`,
      url: `https://${domain}/search?q=${encodeURIComponent(query)}`,
      timestamp: new Date().toISOString()
    }];
  }
};

/**
 * Search open sources for information related to the query
 * @param {Object} options - Search options
 * @param {string} options.query - Search query
 * @param {string} options.model - LLM model to use
 * @param {Array} options.sources - Sources to search
 * @param {Array} options.customUrls - Custom URLs to include
 * @param {Array} options.uploadedFiles - Uploaded files to include
 * @param {string} searchId - Unique identifier for logging
 * @returns {Object} - Search results
 * @deprecated Use the unifiedSearch function from search.js instead
 */
export async function searchOpenSources({ query, model, sources = [SourceTypes.WEB], customUrls = [], uploadedFiles = [] } = {}, searchId = Math.random().toString(36).substring(7)) {
  warn(`[${searchId}] searchOpenSources is deprecated. Use unifiedSearch from search.js instead`);
  
  try {
    // Import the unifiedSearch function from search.js
    const { default: unifiedSearch } = await import('./search');
    
    // Call the unified search function with open mode
    return await unifiedSearch({
      query,
      mode: 'open',
      model,
      sources,
      customUrls,
      uploadedFiles
    }, searchId);
  } catch (err) {
    error(`[${searchId}] Error in searchOpenSources:`, err.message);
    return [{
      source: 'Error',
      type: 'SearchError',
      content: `Failed to perform open search: ${err.message}`,
      url: '#',
      timestamp: new Date().toISOString()
    }];
  }
}
