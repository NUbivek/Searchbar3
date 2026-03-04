import axios from 'axios';
import { deepWebSearch } from './deepWebSearch';
import { debug, info, error, warn } from './logger';
import { SourceTypes } from './constants';
import { VC_FIRMS, MARKET_DATA_SOURCES, searchAcrossDataSources } from './dataSources';
import { searchGovernmentData } from './governmentData';
import { VERIFIED_DATA_SOURCES, searchVerifiedSources as searchVerifiedSourcesInternal } from './verifiedDataSources';
import { withRetry } from './errorHandling';
import { isDebugMode } from './debug';
const { performSearchDetailed } = require('./sourceIntegration');

// Import the processWithLLM function explicitly to avoid circular dependencies
let nativeProcessWithLLM = null;
try {
  const { processWithLLM: llmProcessor } = require('./llmProcessing');
  nativeProcessWithLLM = llmProcessor;
  debug('Successfully imported LLM processing module');
} catch (error) {
  warn('LLM processing module not available, using fallback');
  nativeProcessWithLLM = async (query, results, context, model) => {
    return {
      content: `Unable to process with LLM: ${error.message}`,
      sourceMap: {},
      followUpQuestions: []
    };
  };
}

/**
 * Process search results with an LLM
 * @param {Object} options - LLM processing options
 * @param {string} options.query - Search query
 * @param {Array} options.sources - Search results to process
 * @param {string} options.model - LLM model to use
 * @param {number} options.maxTokens - Maximum tokens for response
 * @param {number} options.temperature - Temperature for response
 * @returns {Object} - Processed results
 */
const processWithLLM = async (options) => {
  // Check if we have a native implementation of processWithLLM
  if (nativeProcessWithLLM && typeof nativeProcessWithLLM === 'function') {
    try {
      return await nativeProcessWithLLM(options);
    } catch (error) {
      console.error('Native LLM processing failed, using fallback:', error.message);
    }
  }

  // Fallback implementation
  const {
    query = '',
    sources = [],
    model = 'gpt-3.5-turbo',
    maxTokens = 1000,
    temperature = 0.3,
    originalSources = [],
    systemPrompt = null,
    forceFallback = false,
  } = options;

  return callLLMAPI(query, sources, {
    model,
    maxTokens,
    temperature,
    systemPrompt,
    forceFallback,
  }, originalSources);
};

/**
 * Helper function to create an LLM prompt from search results
 * @param {string} query The search query
 * @param {Array} results The search results to include in the prompt
 * @returns {string} The formatted prompt
 */
const createLLMPrompt = (query, results) => {
  // Create a basic prompt with the query and search results
  let prompt = `Search Query: "${query}"\n\n`;
  prompt += "Search Results:\n\n";

  // Add each search result to the prompt
  results.forEach((result, index) => {
    prompt += `[${index + 1}] ${result.title || 'Untitled'}\n`;
    prompt += `Source: ${result.source || 'Unknown'}\n`;
    if (result.url) prompt += `URL: ${result.url}\n`;
    prompt += `Content: ${result.content || 'No content available'}\n\n`;
  });

  // Add instructions for the LLM
  prompt += `
Based on the search results above, please:
1. Synthesize the information into a comprehensive answer to the query
2. Group your answer into logical categories if applicable
3. Cite your sources using [1], [2], etc.
4. Include a "sources" section mapping each citation number to its source
5. Suggest 3 follow-up questions related to the query

Please respond in JSON format:
{
  "content": "Your synthesized answer here with [1], [2] citations",
  "categories": [
    {
      "title": "Category 1",
      "content": "Information for this category with [1] citations"
    },
    {
      "title": "Category 2",
      "content": "Information for this category with [2] citations"
    }
  ],
  "sources": {
    "[1]": "Title of source 1",
    "[2]": "Title of source 2"
  },
  "followUpQuestions": ["Follow-up question 1?", "Follow-up question 2?", "Follow-up question 3?"]
}
`;
  return prompt;
};

/**
 * Call the LLM API to process search results
 * @param {string} query The search query
 * @param {Array} results The search results to process
 * @param {Object} options Additional options for processing
 * @param {Array} originalSources Original sources to include in processing
 * @returns {Promise<Object>} The processed results
 */
const callLLMAPI = async (query, results, options = {}, originalSources = []) => {
  // Prepare enhanced results with standardized source format
  const enhancedResults = Array.isArray(results) ? results.map(result => {
    // Ensure each result has all required properties
    return {
      ...result,
      title: result.title || result.name || 'Untitled',
      content: result.content || result.snippet || result.description || '',
      url: result.url || result.link || '',
      source: result.source || 'unknown'
    };
  }) : [];

  // Combine with original sources if provided
  const combinedSources = [
    ...enhancedResults,
    ...(Array.isArray(originalSources) ? originalSources : [])
  ];

  try {

    // If we have no sources, return an empty response
    if (combinedSources.length === 0) {
      console.log('No sources to process for LLM');
      return {
        data: null,
        metadata: {
          error: 'No sources to process',
          model: 'none',
          sourceCount: 0
        }
      };
    }

    const {
      model = 'mistral', // Use model ID, it will be mapped to apiModelName
      maxTokens = 1000,
      temperature = 0.3,
      systemPrompt = null,
      forceFallback = false,
    } = options;

    // Skip API call in debug mode if force fallback is enabled
    if (isDebugMode() && forceFallback) {
      console.log('DEBUG: Using fallback response for LLM processing');
      return {
        data: {
          content: "This is a fallback response for debugging purposes. The search query was: " + query,
          categories: [
            {
              title: "Sample Category 1",
              content: "This is sample content for category 1. No real processing was done."
            },
            {
              title: "Sample Category 2",
              content: "This is sample content for category 2. This is running in debug mode."
            }
          ],
          sources: { "[1]": "Debug Source" },
          followUpQuestions: [
            "This is a sample follow-up question 1?",
            "This is a sample follow-up question 2?",
            "This is a sample follow-up question 3?"
          ]
        },
        metadata: {
          model: 'fallback-debug',
          sourceCount: combinedSources.length,
          processingTime: 0
        }
      };
    }

    // Generate a prompt using the search results
    const prompt = createLLMPrompt(query, combinedSources);
    
    // Get base URL and API key from environment if available
    const apiKey = process.env.TOGETHER_API_KEY;
    const apiEndpoint = process.env.LLM_API_ENDPOINT || 'https://api.together.xyz/v1/chat/completions';
    
    // Check if API key is available
    if (!apiKey) {
      logger.warn('No valid Together API key found. Using fallback response.');
      return {
        data: {
          content: "API key is not configured. Please check your Together API key in the .env.local file.",
          categories: [],
          sources: {},
          followUpQuestions: []
        },
        metadata: {
          error: 'Missing API key',
          model: 'fallback',
          sourceCount: combinedSources.length
        }
      };
    }
    
    console.log(`DEBUG: Using model ${model} for LLM processing`);
    const startTime = Date.now();
    
    // Call the API
    const response = await axios.post(
      apiEndpoint,
      {
        model: model,
        messages: [
          ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
          { role: 'user', content: prompt }
        ],
        max_tokens: maxTokens,
        temperature: temperature,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        }
      }
    );

    const endTime = Date.now();
    const processingTime = endTime - startTime;
    
    if (!response.data || !response.data.choices || !response.data.choices[0]) {
      logger.error('Invalid response from LLM API');
      return {
        data: {
          content: "I wasn't able to process your query at this time. Please try again later.",
          categories: [],
          sources: {},
          followUpQuestions: []
        },
        metadata: {
          error: 'Invalid response from LLM API',
          model: 'fallback',
          sourceCount: combinedSources.length
        }
      };
    }

    const content = response.data.choices[0].message.content;
    let parsedContent;
    
    try {
      // Attempt to parse the response as JSON
      parsedContent = JSON.parse(content);
      console.log('DEBUG: Successfully parsed LLM response as JSON');
    } catch (error) {
      console.log('DEBUG: Failed to parse response as JSON, using raw content');
      parsedContent = {
        content: content,
        categories: [],
        sources: {},
        followUpQuestions: []
      };
    }

    // Return the processed results
    return {
      data: parsedContent,
      metadata: {
        model: response.data.model || model,
        sourceCount: combinedSources.length,
        processingTime
      }
    };
  } catch (error) {
    logger.error('Error in LLM processing:', error);
    
    // Return a fallback response
    const fallbackResponse = {
      data: {
        content: "I wasn't able to process your query at this time. Please try again later.",
        categories: [],
        sources: {},
        followUpQuestions: []
      },
      metadata: {
        error: error.message,
        model: 'fallback',
        sourceCount: combinedSources.length
      }
    };
    
    return fallbackResponse;
  }
}

const extractContentFromLLMResponse = (response) => {
  // Extract content from the LLM response
  if (!response || !response.data) {
    logger.error('Invalid response from LLM API');
    return null;
  }

  try {
    // Check if response has a content field
    if (response.data.content) {
      return response.data.content;
    }

    // If response is a string, return it directly
    if (typeof response.data === 'string') {
      return response.data;
    }

    // If response is an object without a content field, try to stringify it
    if (typeof response.data === 'object') {
      // First, check for common content fields with different names
      if (response.data.answer) return response.data.answer;
      if (response.data.result) return response.data.result;
      if (response.data.response) return response.data.response;
      if (response.data.message) return response.data.message;
      if (response.data.text) return response.data.text;

      // If no matching field, convert the entire object to a string
      try {
        const contentStr = JSON.stringify(response.data, null, 2);
        if (contentStr === '{}' || contentStr === '[]') {
          return "No content was found in the response.";
        }
        return contentStr;
      } catch (e) {
        console.error('Error stringifying response data:', e);
        return "Error processing the response content.";
      }
    }

    // If we couldn't extract content, return a default message
    return "The content couldn't be extracted from the response.";
  } catch (error) {
    // Log the error and return a friendly error message
    logger.error('Error extracting content from LLM response:', error);
    console.error('DEBUG: Error in content extraction:', error.message);
    return "An error occurred while processing your query. Please try again later.";
  }
}

const extractFollowUpQuestionsFromLLMResponse = (response) => {
  // Extract follow-up questions from the LLM response
  if (!response || !response.data) {
    console.log('DEBUG: Invalid response for follow-up questions extraction');
    return [];
  }

  try {
    // Check if response has a followUpQuestions field
    if (response.data.followUpQuestions && Array.isArray(response.data.followUpQuestions)) {
      return response.data.followUpQuestions.filter(q => q && typeof q === 'string');
    }

    // Check for alternative field names
    if (response.data.follow_up_questions && Array.isArray(response.data.follow_up_questions)) {
      return response.data.follow_up_questions.filter(q => q && typeof q === 'string');
    }

    if (response.data.questions && Array.isArray(response.data.questions)) {
      return response.data.questions.filter(q => q && typeof q === 'string');
    }

    if (response.data.follow_ups && Array.isArray(response.data.follow_ups)) {
      return response.data.follow_ups.filter(q => q && typeof q === 'string');
    }

    // If response is a string, try to parse it as JSON
    if (typeof response.data === 'string') {
      try {
        const parsedData = JSON.parse(response.data);
        
        // Look for question arrays in the parsed data
        if (parsedData.followUpQuestions && Array.isArray(parsedData.followUpQuestions)) {
          return parsedData.followUpQuestions.filter(q => q && typeof q === 'string');
        }
        
        if (parsedData.follow_up_questions && Array.isArray(parsedData.follow_up_questions)) {
          return parsedData.follow_up_questions.filter(q => q && typeof q === 'string');
        }
        
        if (parsedData.questions && Array.isArray(parsedData.questions)) {
          return parsedData.questions.filter(q => q && typeof q === 'string');
        }
      } catch (error) {
        console.log('DEBUG: Response is not valid JSON for question extraction');
        return [];
      }
    }

    // Default: no follow-up questions found
    return [];
  } catch (error) {
    // Log the error and return an empty array
    logger.error('Error extracting follow-up questions from LLM response:', error);
    console.error('DEBUG: Error in follow-up questions extraction:', error.message);
    return [];
  }
}

const extractSourceMapFromLLMResponse = (response) => {
  // Extract source map from the LLM response
  if (!response || !response.data) {
    console.log('DEBUG: Invalid response for source map extraction');
    return {};
  }

  try {
    // Check if response has a sources field that is an object
    if (response.data.sources && typeof response.data.sources === 'object' && !Array.isArray(response.data.sources)) {
      console.log('DEBUG: Found sources object in response');
      return response.data.sources;
    }

    // Check if response.data is a string, try to parse it as JSON
    if (typeof response.data === 'string') {
      console.log('DEBUG: Attempting to parse string response as JSON for source map');
      try {
        const parsedData = JSON.parse(response.data);
        if (parsedData.sources && typeof parsedData.sources === 'object') {
          console.log('DEBUG: Found source map in parsed JSON');
          return parsedData.sourceMap;
        }
      } catch (error) {
        console.log('DEBUG: Response is not valid JSON for source map');
        return {};
      }
    }

    // If response.data.sources is an array, convert it to a map
    if (response.data.sources && Array.isArray(response.data.sources)) {
      console.log('DEBUG: Found sources array in response');
      return response.data.sources.reduce((map, source, index) => {
        map[`[${index + 1}]`] = source;
        return map;
      }, {});
    }

    // If response has citations and sources arrays, map them
    if (response.data.citations && Array.isArray(response.data.citations) && 
        response.data.sources && Array.isArray(response.data.sources)) {
      console.log('DEBUG: Found citations array in response');
      return response.data.citations.reduce((map, citation, index) => {
        map[citation] = response.data.sources[index];
        return map;
      }, {});
    }

    // Default: no source map found
    console.log('DEBUG: Using default source map');
    return {};
  } catch (error) {
    logger.error('Error extracting source map from LLM response:', error);
    console.error('DEBUG: Error in source map extraction:', error.message);
    return {};
  }
}

/**
 * Search with Serper API for a specific domain
 * @param {string} query - The search query
 * @param {string} domain - Domain to search within
 * @param {string} searchId - Search identifier for tracking
 * @returns {Array} Search results
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
        },
        timeout: 30000, // 30 second timeout for Serper API requests
        timeoutErrorMessage: 'Search request to Serper API timed out'
      }
    );

    if (!response.data?.organic) {
      return [];
    }

    return response.data.organic
      .filter(result => result.link && result.link.includes(domain))
      .map(result => ({
        title: result.title,
        snippet: result.snippet,
        link: result.link,
        source: domain
      }));
  } catch (err) {
    error(`[${searchId}] Error searching Serper for ${domain}:`, err.message);
    return [];
  }
};

/**
 * Enhanced search function that handles both open and verified sources
 * @param {Object} options - Search options
 * @param {string} options.query - Search query
 * @param {string} options.mode - Search mode ('open' or 'verified')
 * @param {string} options.model - LLM model to use
 * @param {Array} options.sources - Sources to search
 * @param {Array} options.customUrls - Custom URLs to include
 * @param {Array} options.uploadedFiles - Uploaded files to include
 * @param {string} searchId - Search identifier
 * @returns {Object} Search results
 */
export async function unifiedSearch({ 
  query, 
  mode = 'open',
  model = 'mistral', 
  sources = [SourceTypes.WEB], 
  customUrls = [], 
  uploadedFiles = [] 
} = {}, searchId = Math.random().toString(36).substring(7)) {
  debug(`[${searchId}] Starting unified search`, { query, mode, model, sources });
  
  // Implementation for both search modes directly to avoid circular dependencies
  try {
    let results = [];
    let providerStatuses = [];
    debug(`[${searchId}] Performing ${mode} search for: ${query}`);
    
    if (mode === 'verified') {
      // Verified search implementation
      debug(`[${searchId}] Searching verified sources:`, sources);
      
      // Implement verified search logic directly here
      if (sources.includes('VerifiedSources') || sources.includes('FMP') || sources.includes('MarketData')) {
        debug(`[${searchId}] Searching market data sources`);
        const marketResults = await searchAcrossDataSources(query, MARKET_DATA_SOURCES);
        results = results.concat(marketResults);
      }

      if (sources.includes('VerifiedSources') || sources.includes('Crunchbase') || sources.includes('Pitchbook')) {
        debug(`[${searchId}] Searching VC firms data`);
        const vcResults = await searchAcrossDataSources(query, VC_FIRMS);
        results = results.concat(vcResults);
      }

      if (sources.includes('VerifiedSources') || sources.includes('Government')) {
        debug(`[${searchId}] Searching government data`);
        const govResults = await searchGovernmentData(query);
        results = results.concat(govResults);
      }
      
      // Add verified data sources
      if (sources.includes('VerifiedSources') || sources.includes('Verified')) {
        debug(`[${searchId}] Searching verified sources internally`);
        const verifiedResults = await searchVerifiedSourcesInternal(query);
        results = results.concat(verifiedResults);
      }
    } else {
      // Open search implementation
      debug(`[${searchId}] Searching open sources:`, sources);

      const sourceKeyMap = {
        Web: 'web',
        LinkedIn: 'linkedin',
        X: 'x',
        Twitter: 'twitter',
        Reddit: 'reddit',
        Substack: 'substack',
        Medium: 'medium',
        Crunchbase: 'crunchbase',
        Pitchbook: 'pitchbook',
        Carta: 'carta'
      };

      const normalizedSources = Array.from(
        new Set(
          (Array.isArray(sources) ? sources : [])
            .map(source => sourceKeyMap[source] || null)
            .filter(Boolean)
        )
      );

      if (Array.isArray(customUrls) && customUrls.length > 0) {
        normalizedSources.push('custom');
      }

      if (Array.isArray(uploadedFiles) && uploadedFiles.length > 0) {
        normalizedSources.push('file');
      }

      const openSearchResult = await performSearchDetailed(query, normalizedSources, {
        customUrls,
        files: uploadedFiles,
        timeoutMs: 8000
      });

      results = results.concat(openSearchResult.results || []);
      providerStatuses = Array.isArray(openSearchResult.providers) ? openSearchResult.providers : [];
    }
    
    // Process results with LLM if needed
    if (results.length > 0 && model) {
      debug(`[${searchId}] Processing results with LLM model: ${model}`);
      try {
        const summary = await processWithLLM(query, results, '', model);
        return {
          results,
          summary,
          providerStatuses
        };
      } catch (llmError) {
        error(`[${searchId}] LLM processing error:`, llmError.message);
        // Return raw results if LLM processing fails
        return { results, providerStatuses };
      }
    }
    
    return { results, providerStatuses };
  } catch (err) {
    error(`[${searchId}] Unified search error:`, err.message);
    return {
      results: [{
        source: 'Error',
        type: 'SearchError',
        content: `Search error: ${err.message}`,
        title: 'Search Error',
        timestamp: new Date().toISOString()
      }],
      providerStatuses: []
    };
  }
}



// Direct export of unifiedSearch as default export
export default unifiedSearch;

// Export other utility functions
export {
  extractContentFromLLMResponse,
  extractFollowUpQuestionsFromLLMResponse,
  extractSourceMapFromLLMResponse,
  processWithLLM
};
