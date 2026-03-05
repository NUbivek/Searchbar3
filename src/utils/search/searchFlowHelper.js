/**
 * Search Flow Helper
 * Provides utility functions for handling search flows across the application
 */
import axios from 'axios';
import { logger } from '../logger';
import { detectQueryContext } from '../../components/search/utils/contextDetector';
import { ALL_VERIFIED_SOURCES } from '../allVerifiedSources';
import { buildApiUrl } from '../clientApi';

/**
 * Execute a search with proper error handling and result processing
 * 
 * @param {Object} searchParams - Search parameters
 * @param {string} searchParams.query - Search query
 * @param {string} searchParams.mode - Search mode (verified or open)
 * @param {string} searchParams.model - LLM model to use
 * @param {Array} searchParams.sources - Sources to search through
 * @param {Array} searchParams.customUrls - Custom URLs to include
 * @param {Array} searchParams.files - Files to include in search
 * @returns {Promise<Object>} - Search results with metadata
 */
export async function executeSearch({
  query,
  mode = 'verified',
  model = 'mistral',
  sources = [],
  customUrls = [],
  files = []
}) {
  // Always use LLM processing
  const useLLM = true;
  if (!query) {
    return {
      error: true,
      message: 'Search query is required',
      query,
      results: [],
      metadata: {
        timestamp: new Date().toISOString(),
        errorType: 'ValidationError'
      }
    };
  }
  
  logger.info(`Executing ${mode} search`, {
    query,
    model,
    sources: Array.isArray(sources) ? sources.length : 'unknown',
    customUrls: Array.isArray(customUrls) ? customUrls.length : 'unknown',
    files: Array.isArray(files) ? files.length : 'unknown',
    useLLM: true
  });

  try {
    // Detect query context
    const context = detectQueryContext(query);
    
    // Call the search API
    const response = await axios.post(buildApiUrl('/api/search'), {
      query,
      mode,
      model,
      sources,
      customUrls,
      files,
      useLLM,
      context: context
    });
    
    // Check for API errors
    if (response.data.error) {
      return {
        error: true,
        message: response.data.error,
        query,
        results: [],
        metadata: {
          timestamp: new Date().toISOString(),
          errorType: 'SearchError'
        }
      };
    }
    
    // Extract results and categories
    const results = response.data.results || [];
    const categories = response.data.categories || [];
    
    // Log categories received from API for debugging purposes
    if (Array.isArray(categories) && categories.length > 0) {
      console.log(`Search API returned ${categories.length} categories for query '${query}'`);
    }
    
    // Log categories for debugging
    logger.info(`Received ${categories.length} categories from search API`, {
      categories: categories.map(c => ({
        name: c.name,
        id: c.id,
        metrics: c.metrics || 'none',
        count: c.content?.length || 0
      }))
    });
    
    // Also log to console for immediate visibility
    console.log('Categories with metrics:', 
      categories.map(c => ({
        name: c.name, 
        metrics: c.metrics?.overall || 'none',
        count: c.content?.length || 0
      })));
    
    // Return formatted results with metadata and categories
    return {
      results,
      query,
      categories,
      metadata: {
        context,
        mode,
        model,
        timestamp: new Date().toISOString(),
        resultCount: results.length,
        sources: typeof sources === 'object' ? sources : []
      }
    };
  } catch (error) {
    logger.error('Search execution error', {
      error: error.message,
      query,
      mode
    });
    
    // Provide structured error response
    return {
      error: true,
      message: error.message || 'An error occurred during search',
      query,
      results: [],
      metadata: {
        timestamp: new Date().toISOString(),
        errorType: error.name || 'SearchError'
      }
    };
  }
}

/**
 * Get sources based on selected source types
 * 
 * @param {Array} selectedSources - Array of source types (e.g., 'web', 'verified', 'reddit')
 * @returns {Array} - Array of actual source identifiers
 */
export function getSourcesFromSelection(selectedSources = []) {
  if (!Array.isArray(selectedSources)) {
    return [];
  }
  
  let sources = [];
  
  // Add verified sources if selected
  if (selectedSources.includes('verified')) {
    sources = [...sources, ...ALL_VERIFIED_SOURCES];
  }
  
  // Add web sources if selected
  if (selectedSources.includes('web')) {
    sources.push('web');
  }
  
  // Add specific social media sources
  if (selectedSources.includes('reddit')) {
    sources.push('reddit');
  }
  
  if (selectedSources.includes('linkedin')) {
    sources.push('linkedin');
  }
  
  if (selectedSources.includes('twitter')) {
    sources.push('twitter');
  }
  
  return sources;
}

/**
 * Format search results for display
 * This ensures consistent result structure across the application
 * 
 * @param {Array} results - Raw search results
 * @param {Object} options - Formatting options
 * @returns {Array} - Formatted results
 */
export function formatSearchResults(results, options = {}) {
  if (!Array.isArray(results)) {
    return [];
  }
  
  // Log for debugging
  console.log('formatSearchResults: Processing search results', {
    count: results.length,
    hasQuery: !!options.query
  });
  
  // Extract and create default categories if needed
  let defaultCategories = extractCategoriesFromResults(results);
  console.log('Search Helper: Extracted categories', { count: defaultCategories.length });
  
  // Format each result
  return results.map(result => {
    // Check if this result already has categories
    const hasCategories = result.categories && Array.isArray(result.categories) && result.categories.length > 0;
    const hasCategory = result.category && typeof result.category === 'object';
    
    // Ensure each result has required properties
    return {
      id: result.id || generateResultId(),
      title: result.title || 'Untitled Result',
      content: result.content || result.text || '',
      source: normalizeSource(result.source),
      url: result.url || '',
      // Use existing category or null
      category: result.category || null,
      // Use existing categories or default ones
      categories: hasCategories ? result.categories : 
                 hasCategory ? [result.category] : 
                 defaultCategories,
      metrics: result.metrics || {},
      timestamp: result.timestamp || new Date().toISOString(),
      ...result // Keep all other properties
    };
  });
}

// Helper to normalize source objects
function normalizeSource(source) {
  if (!source) {
    return { name: 'Unknown Source', url: '', type: 'unknown' };
  }
  
  if (typeof source === 'string') {
    return { name: source, url: '', type: 'text' };
  }
  
  return {
    name: source.name || source.title || 'Unknown Source',
    url: source.url || '',
    type: source.type || 'unknown',
    ...source
  };
}

// Generate a unique ID for results that don't have one
function generateResultId() {
  return `result_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Extract categories from search results or create default ones
 * @param {Array} results - Search results to process
 * @returns {Array} - Array of category objects
 */
function extractCategoriesFromResults(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return [];
  }
  
  // Extract existing categories
  const singleCategories = results
    .filter(result => result.category && typeof result.category === 'object')
    .map(result => result.category);
  
  const multiCategories = results
    .filter(result => Array.isArray(result.categories) && result.categories.length > 0)
    .flatMap(result => result.categories);
  
  // Combine and deduplicate
  let categories = [...singleCategories, ...multiCategories]
    .filter((cat, index, self) => 
      cat && cat.id && index === self.findIndex(c => c && c.id === cat.id)
    );
  
  // If no categories found, create default ones
  if (categories.length === 0) {
    console.log('Creating default categories from search results');
    
    // Default "All Results" category
    const allResultsCategory = {
      id: 'all_results_' + Date.now(),
      name: 'All Results',
      icon: 'search',
      description: 'Complete search results',
      content: results.map(result => ({
        ...result,
        displayMetrics: {
          relevance: 0.85,
          credibility: 0.82,
          accuracy: 0.8,
          overall: 0.82
        }
      })),
      metrics: {
        relevance: 0.85,
        credibility: 0.82,
        accuracy: 0.8,
        overall: 0.82
      },
      color: '#4285F4' // Google Blue
    };
    
    categories.push(allResultsCategory);
    
    // Check for financial content
    const hasFinancial = results.some(result => {
      const content = result.content || result.text || '';
      return typeof content === 'string' && 
        (content.toLowerCase().includes('financial') ||
         content.toLowerCase().includes('finance') ||
         content.toLowerCase().includes('investment') ||
         content.toLowerCase().includes('market'));
    });
    
    if (hasFinancial) {
      categories.push({
        id: 'financial_insights_' + Date.now(),
        name: 'Financial Insights',
        icon: 'chart-line',
        description: 'Financial information and analysis',
        content: results.filter(result => {
          const content = result.content || result.text || '';
          return typeof content === 'string' && 
            (content.toLowerCase().includes('financial') ||
             content.toLowerCase().includes('finance') ||
             content.toLowerCase().includes('investment') ||
             content.toLowerCase().includes('market'));
        }).map(result => ({
          ...result,
          displayMetrics: {
            relevance: 0.9,
            credibility: 0.85,
            accuracy: 0.88,
            overall: 0.88
          }
        })),
        metrics: {
          relevance: 0.9,
          credibility: 0.85,
          accuracy: 0.88,
          overall: 0.88
        },
        color: '#34A853' // Google Green
      });
    }
  }
  
  return categories;
}
