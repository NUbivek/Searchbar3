import { debug, info, error, warn } from './logger';
const { deepWebSearch } = require('./deepWebSearch');
const { sourceHandlers, performSearch: sourcePerformSearch } = require('./sourceIntegration');
const axios = require('axios');
const { SearchModes, SourceTypes } = require('./constants');

// Create a logger object for compatibility
const log = {
  debug,
  info,
  error,
  warn
};

// Constants for verified sources
const VERIFIED_SOURCES = {
  'Market Data Analytics': [
    { name: 'Bloomberg', url: 'https://www.bloomberg.com' },
    { name: 'Reuters', url: 'https://www.reuters.com' },
    { name: 'WSJ', url: 'https://www.wsj.com' }
  ],
  'VC & Startups': [
    { name: 'Crunchbase', url: 'https://www.crunchbase.com' },
    { name: 'Pitchbook', url: 'https://www.pitchbook.com' },
    { name: 'TechCrunch', url: 'https://www.techcrunch.com' }
  ],
  'VC Firms': [
    { name: 'Andreessen Horowitz', url: 'https://a16z.com', handles: { x: '@a16z', linkedin: 'company/andreessen-horowitz', substack: 'future.a16z.com' } },
    { name: 'Sequoia Capital', url: 'https://www.sequoiacap.com', handles: { x: '@sequoia', linkedin: 'company/sequoia-capital', substack: 'sequoia.substack.com' } },
    { name: 'Accel', url: 'https://www.accel.com', handles: { x: '@accel', linkedin: 'company/accel-partners', substack: 'accel.substack.com' } },
    { name: 'Greylock Partners', url: 'https://greylock.com', handles: { x: '@greylock', linkedin: 'company/greylock-partners', substack: 'greylock.substack.com' } },
    { name: 'Benchmark', url: 'https://www.benchmark.com', handles: { x: '@benchmark', linkedin: 'company/benchmark' } },
    { name: 'Lightspeed', url: 'https://lsvp.com', handles: { x: '@lightspeedvp', linkedin: 'company/lightspeed-venture-partners' } },
    { name: 'NEA', url: 'https://www.nea.com', handles: { x: '@nea', linkedin: 'company/nea' } },
    { name: 'Bessemer', url: 'https://www.bvp.com', handles: { x: '@bvp', linkedin: 'company/bessemer-venture-partners' } },
    { name: 'Index Ventures', url: 'https://www.indexventures.com', handles: { x: '@indexventures', linkedin: 'company/index-ventures' } },
    { name: 'General Catalyst', url: 'https://www.generalcatalyst.com', handles: { x: '@gcvp', linkedin: 'company/general-catalyst-partners' } },
    { name: 'Khosla Ventures', url: 'https://www.khoslaventures.com', handles: { x: '@khoslaventures', linkedin: 'company/khosla-ventures' } },
    { name: 'Founders Fund', url: 'https://foundersfund.com', handles: { x: '@foundersfund', linkedin: 'company/founders-fund' } },
    { name: 'Tiger Global', url: 'https://www.tigerglobal.com', handles: { x: '@tigerglobal', linkedin: 'company/tiger-global-management' } },
    { name: 'First Round', url: 'https://firstround.com', handles: { x: '@firstround', linkedin: 'company/first-round-capital' } },
    { name: 'Union Square Ventures', url: 'https://www.usv.com', handles: { x: '@usv', linkedin: 'company/union-square-ventures' } },
    { name: 'Kleiner Perkins', url: 'https://www.kleinerperkins.com', handles: { x: '@kleinerperkins', linkedin: 'company/kleiner-perkins' } },
    { name: 'Insight Partners', url: 'https://www.insightpartners.com', handles: { x: '@insightpartners', linkedin: 'company/insight-partners' } },
    { name: 'GGV Capital', url: 'https://www.ggvc.com', handles: { x: '@ggvcapital', linkedin: 'company/ggv-capital' } },
    { name: 'Coatue', url: 'https://www.coatue.com', handles: { x: '@coatue', linkedin: 'company/coatue-management' } },
    { name: 'Battery Ventures', url: 'https://www.battery.com', handles: { x: '@batteryventures', linkedin: 'company/battery-ventures' } }
  ],
  'VC Partners': [
    { name: 'Marc Andreessen', url: 'https://pmarca.substack.com', handles: { x: '@pmarca', linkedin: '/in/mandreessen' } },
    { name: 'Ben Horowitz', url: 'https://a16z.com/author/ben-horowitz', handles: { x: '@bhorowitz', linkedin: '/in/benhorowitz' } },
    { name: 'Roelof Botha', url: 'https://www.sequoiacap.com/people/roelof-botha', handles: { x: '@roelofbotha', linkedin: '/in/roelofbotha' } },
    { name: 'Bill Gurley', url: 'http://abovethecrowd.com', handles: { x: '@bgurley', linkedin: '/in/billgurley' } },
    { name: 'Fred Wilson', url: 'https://avc.com', handles: { x: '@fredwilson', linkedin: '/in/fredwilson' } }
  ]
};

// Process results with LLM
async function processResults(query, results, model = 'mistral', context = '') {
  try {
    let baseUrl;
    if (typeof window !== 'undefined') {
      // Client-side
      baseUrl = window.location.origin;
    } else {
      // Server-side
      baseUrl = process.env.NODE_ENV === 'development' 
        ? 'http://localhost:3010' 
        : process.env.NEXT_PUBLIC_BASE_URL || '';
    }
      
    // Use the real LLM processing endpoint
    const response = await axios.post(`${baseUrl}/api/llm/process`, {
      query,
      sources: results,
      model,
      context
    });

    return {
      content: response.data.content,
      sourceMap: response.data.sourceMap || {}
    };
  } catch (error) {
    log.error('LLM processing error:', error);
    // Return a fallback response
    return {
      content: `Found ${results.length} results for "${query}". Unable to generate summary.`,
      sourceMap: {}
    };
  }
}

// Perform search for verified sources
async function performVerifiedSearch(query, options = {}) {
  try {
    // Use the verified source handler
    const results = await sourceHandlers.verified(query, options);
    return results;
  } catch (error) {
    log.error('Error in performVerifiedSearch:', error);
    throw error;
  }
}

// Perform search across selected sources
async function performSearch(query, sources, options = {}) {
  if (!query) {
    throw new Error('Search query is required');
  }

  try {
    // Convert source names to lowercase for consistency
    const normalizedSources = sources.map(source => source.toLowerCase());
    
    // Check if we're using verified sources
    if (normalizedSources.includes('verified')) {
      log.info('Performing verified search with query:', query);
      return await performVerifiedSearch(query, options);
    }
    
    // For other sources, use the sourceHandlers
    const promises = normalizedSources.map(async (source) => {
      if (sourceHandlers[source]) {
        try {
          return await sourceHandlers[source](query, options);
        } catch (error) {
          log.error(`Error searching ${source}:`, error);
          return [];
        }
      } else {
        log.warn(`No handler found for source: ${source}`);
        return [];
      }
    });

    const settled = await Promise.allSettled(promises);
    return settled
      .filter((result) => result.status === 'fulfilled')
      .flatMap((result) => Array.isArray(result.value) ? result.value : []);
  } catch (error) {
    log.error('Error in performSearch:', error);
    throw error;
  }
}

// Handle custom sources (URLs and files)
async function handleCustomSources(query, customUrls = [], files = []) {
  const results = [];

  // Process custom URLs if any
  if (customUrls && customUrls.length > 0) {
    try {
      const urlResults = await sourceHandlers.custom(query, customUrls);
      results.push(...urlResults);
    } catch (error) {
      log.error(`Error processing custom URLs:`, error);
    }
  }

  // Process files if any
  if (files && files.length > 0) {
    try {
      const fileResults = await sourceHandlers.file(query, files);
      results.push(...fileResults);
    } catch (error) {
      log.error(`Error processing files:`, error);
    }
  }

  return results;
}

/**
 * Search open sources using the unified search function
 * This is now a wrapper around the unified search utility that maintains backward compatibility
 * @deprecated Use unifiedSearch from search.js directly instead
 */
async function searchOpenSources(query, selectedSources = [], options = {}) {
  if (!query) {
    throw new Error('Search query is required');
  }

  log.warn('searchOpenSources is deprecated. Use unifiedSearch from search.js instead');
  log.debug('Using unified searchOpenSources wrapper:', { query, sources: selectedSources });

  try {
    // Import the openSearch.js function which is now a wrapper around unifiedSearch
    const { searchOpenSources: openSearch } = require('./openSearch');
    
    return await openSearch({
      query,
      model: options?.model || 'mistral',
      sources: selectedSources,
      customUrls: options?.customUrls || [],
      uploadedFiles: options?.uploadedFiles || []
    });
  } catch (error) {
    log.error('Open search error:', error);
    throw error;
  }
}

/**
 * Search verified sources using the unified search function
 * This is now a wrapper around the unified search utility that maintains backward compatibility
 * @deprecated Use unifiedSearch from search.js directly instead
 */
async function searchVerifiedSources(query, options = {}) {
  const {
    category = null,
    model = 'mistral',
    context = ''
  } = options;

  log.warn('searchVerifiedSources is deprecated. Use unifiedSearch from search.js instead');
  log.debug('Using unified searchVerifiedSources wrapper:', { query, category });

  try {
    // Import the verifiedSearch.js function which is now a wrapper around unifiedSearch
    const { searchVerifiedSources: verifiedSearch } = require('./verifiedSearch');
    
    // Determine sources based on category if provided
    const sourcesToSearch = [];
    if (category) {
      // Convert category to appropriate source list
      if (category === 'Market Data Analytics') {
        sourcesToSearch.push('FMP', 'MarketData');
      } else if (category === 'VC & Startups') {
        sourcesToSearch.push('Crunchbase', 'Pitchbook');
      } else {
        // Default to all verified sources
        sourcesToSearch.push('VerifiedSources');
      }
    } else {
      sourcesToSearch.push('VerifiedSources');
    }
    
    return await verifiedSearch(query, {
      sources: sourcesToSearch,
      model,
      customUrls: options.customUrls || [],
      uploadedFiles: options.uploadedFiles || []
    });
  } catch (error) {
    log.error('Verified search error:', error);
    throw error;
  }
}

/**
 * Simplified search function that uses unified search
 * @param {string} query - The search query
 * @param {Array<string>} sources - Array of source names to search
 * @param {Object} options - Additional options
 * @returns {Promise<Array>} - Array of search results
 */
async function performSimpleSearch(query, sources = ['web'], options = {}) {
  try {
    if (!query) {
      throw new Error('Query is required');
    }

    log.debug('Using unified performSimpleSearch:', { query, sources });
    
    // Import unified search function using require to avoid circular dependencies
    const { unifiedSearch } = require('./search');
    
    // Call unified search with open mode
    const searchResult = await unifiedSearch({
      query,
      mode: 'open',
      sources: sources,
      model: options?.model || 'mistral',
      customUrls: options?.customUrls || [],
      uploadedFiles: options?.uploadedFiles || []
    });
    
    // Return the results array
    return searchResult?.results || [];
  } catch (error) {
    log.error('Error in performSimpleSearch:', error);
    return [];
  }
}

/**
 * Simplified verified search function that uses unified search
 * @param {string} query - The search query
 * @param {Array<string>} sources - Array of source names to search
 * @param {Object} options - Additional options including customUrls and uploadedFiles
 * @returns {Promise<Array>} - Array of search results
 */
async function performSimpleVerifiedSearch(query, sources = ['fmp', 'sec'], options = {}) {
  try {
    if (!query) {
      throw new Error('Query is required');
    }

    log.debug('Using unified performSimpleVerifiedSearch:', { query, sources });
    
    // Import unified search function using require to avoid circular dependencies
    const { unifiedSearch } = require('./search');
    
    // Call unified search with verified mode
    const searchResult = await unifiedSearch({
      query,
      mode: 'verified',
      sources: sources,
      model: options?.model || 'mistral',
      customUrls: options?.customUrls || [],
      uploadedFiles: options?.uploadedFiles || []
    });
    
    // Return the results array
    return searchResult?.results || [];
  } catch (error) {
    log.error('Error in performSimpleVerifiedSearch:', error);
    return [];
  }
}

module.exports = {
  VERIFIED_SOURCES,
  processResults,
  performVerifiedSearch,
  performSearch,
  handleCustomSources,
  searchOpenSources,
  searchVerifiedSources,
  performSimpleSearch,
  performSimpleVerifiedSearch
};
