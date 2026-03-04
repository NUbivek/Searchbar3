/**
 * LLM Processing Functionality
 * This file provides LLM integration for the search application using the Together AI API.
 */

import axios from 'axios';
const { debug, info, warn, error } = require('./logger');
const { isLLMResult, createEmptyLLMResult } = require('./llm/resultDetector');

// Model configuration and endpoint mapping
export const MODEL_ENDPOINTS = {
  'mistral-7b': {
    endpoint: 'https://api.together.xyz/v1/completions',
    modelId: 'mistralai/Mistral-7B-Instruct-v0.2',
    temperature: 0.7,
    max_tokens: 4096
  },
  'mixtral-8x7b': {
    endpoint: 'https://api.together.xyz/v1/completions',
    modelId: 'mistralai/Mixtral-8x7B-Instruct-v0.1',
    temperature: 0.7,
    max_tokens: 4096
  },
  'llama-2-13b': {
    endpoint: 'https://api.together.xyz/v1/completions',
    modelId: 'meta-llama/Llama-2-13b-chat-hf',
    temperature: 0.7,
    max_tokens: 4096
  },
  'llama-2-70b': {
    endpoint: 'https://api.together.xyz/v1/completions',
    modelId: 'meta-llama/Llama-2-70b-chat-hf',
    temperature: 0.7,
    max_tokens: 4096
  },
  'gemma-7b': {
    endpoint: 'https://api.together.xyz/v1/completions',
    modelId: 'google/gemma-7b-it',
    temperature: 0.7,
    max_tokens: 4096
  }
};

// Define aliases for backward compatibility
const MODEL_ALIASES = {
  'mistral': 'mistral-7b',
  'mixtral': 'mixtral-8x7b',
  'llama': 'llama-2-13b',
  'llama-13b': 'llama-2-13b',
  'gemma': 'gemma-7b',
  'gemma-27b': 'gemma-7b'
};

/**
 * Process search results with an LLM model
 * Supports both (searchResults, query, modelId, options) and (query, searchResults, modelId, apiKey) formats
 * for backward compatibility
 * 
 * @param {Array|Object|string} param1 Search results to process OR query string
 * @param {string|Array|Object} param2 Original search query OR search results
 * @param {string} param3 Model ID to use for processing
 * @param {Object|string} param4 Additional options OR API key
 * @returns {Promise<Object>} Processed results
 */
export const processWithLLM = async (param1, param2, param3 = 'mistral-7b', param4 = {}) => {
  // Check which parameter format is used
  let searchResults, query, modelId, options;
  
  if (typeof param1 === 'string') {
    // Old format: (query, searchResults, modelId, apiKey)
    query = param1;
    searchResults = param2;
    modelId = param3 || 'mistral-7b';
    options = typeof param4 === 'string' ? { apiKey: param4 } : (param4 || {});
  } else {
    // New format: (searchResults, query, modelId, options)
    searchResults = param1;
    query = param2;
    modelId = param3 || 'mistral-7b';
    options = param4 || {};
  }
  
  // Normalize model ID using aliases if needed
  if (MODEL_ALIASES[modelId]) {
    console.log(`Converting model alias '${modelId}' to standard ID '${MODEL_ALIASES[modelId]}'`);
    modelId = MODEL_ALIASES[modelId];
  }
  
  console.log('LLM processing request format:', {
    format: typeof param1 === 'string' ? 'old' : 'new',
    hasResults: !!searchResults,
    hasQuery: !!query,
    modelId
  });
  try {
    console.log(`Processing with LLM: ${modelId}`, {
      resultsLength: Array.isArray(searchResults) ? searchResults.length : 'not an array',
      query: query?.substring(0, 50) + (query?.length > 50 ? '...' : ''),
      options
    });
    
    // Ensure we have search results to process
    if (!searchResults || (Array.isArray(searchResults) && searchResults.length === 0)) {
      console.error('No search results to process with LLM');
      return {
        content: 'I couldn\'t find any relevant information for your query. Please try a different search term.',
        __isImmutableLLMResult: true,
        isLLMResult: true,
        llmProcessed: true,
        error: 'No search results available',
        query: query
      };
    }
    
    // Get API key - first check options, then environment variable
    let apiKey = options.apiKey || process.env.TOGETHER_API_KEY;
    
    // For debugging - checking API key format without exposing the full key
    console.log('DEBUG: API Key check:', {
      provided: !!apiKey,
      length: apiKey?.length || 0,
      firstFiveChars: apiKey ? apiKey.substring(0, 5) + '...' : 'none',
      envVarExists: !!process.env.TOGETHER_API_KEY,
      envVarLength: process.env.TOGETHER_API_KEY?.length || 0
    });
    
    // Validate API key
    if (!apiKey || apiKey.length < 64) {
      console.error(`Invalid Together API key - must be at least 64 characters, got ${apiKey?.length || 0}`);
      return createErrorResponse('API key validation failed - check your .env.local file', 'auth_error');
    }
    
    // Create source map for reference
    const sourceMap = createSourceMap(searchResults);
    
    // Format search results for the LLM
    const formattedResults = formatContentForLLM(searchResults);
    
    // Generate a prompt for the LLM
    const prompt = generateSearchPrompt(query, formattedResults, options);
    
    // Get model configuration
    const modelConfig = MODEL_ENDPOINTS[modelId] || MODEL_ENDPOINTS['mistral-7b'];
    
    // Call the LLM API
    const llmResponse = await callLLMAPI(prompt, modelConfig, apiKey);
    
    // Process the response
    return processLLMResponse(llmResponse, query, sourceMap);
  } catch (error) {
    console.error('LLM processing error:', error);
    return createErrorResponse(
      error.message || 'An error occurred during LLM processing',
      error.code || 'processing_error'
    );
  }
};

/**
 * Internal implementation of LLM processing
 * Same as processWithLLM but with more flexibility for internal use
 */
export const processWithLLMInternal = processWithLLM;

/**
 * Format content for the LLM by extracting relevant text
 * @param {Array|Object} content Content to format
 * @returns {string} Formatted content for LLM consumption
 */
const formatContentForLLM = (content) => {
  if (!content) return '';
  
  let formatted = '';
  
  if (Array.isArray(content)) {
    // Process array of results
    content.forEach((item, index) => {
      const itemText = extractTextFromItem(item);
      if (itemText) {
        formatted += `SOURCE ${index + 1}:\n${itemText}\n\n`;
      }
    });
  } else if (typeof content === 'object') {
    // Process single object
    formatted = extractTextFromItem(content);
  } else if (typeof content === 'string') {
    // Already a string
    formatted = content;
  }
  
  return formatted;
};

/**
 * Extract text content from various item formats
 * @param {Object|string} item Item to extract text from
 * @returns {string} Extracted text
 */
const extractTextFromItem = (item) => {
  if (!item) return '';
  
  if (typeof item === 'string') {
    return item;
  }
  
  // Handle different item structures
  if (item.content) return item.content;
  if (item.snippet) return item.snippet;
  if (item.text) return item.text;
  if (item.title && item.description) {
    return `${item.title}\n${item.description}`;
  }
  
  // Try to convert object to string
  try {
    return JSON.stringify(item);
  } catch (e) {
    return '';
  }
};

/**
 * Generate a search prompt for the LLM
 * @param {string} query Search query
 * @param {string} content Formatted content
 * @param {Object} options Additional options
 * @returns {string} Generated prompt
 */
const generateSearchPrompt = (query, content, options = {}) => {
  return `You are a comprehensive research assistant analyzing search results. Please provide an extremely detailed, in-depth answer to the user's query based on the search results provided. Your response should be at least 4 times longer than typical answers, with extensive analysis, multiple perspectives, and thorough explanations.\n\n
  USER QUERY: ${query}\n\n
  SEARCH RESULTS:\n${content}\n\n
  RESPONSE STRUCTURE REQUIREMENTS:\n
  ## SUMMARY\n  - Provide a detailed overview of the answer (3-4 substantial paragraphs)

  ## KEY POINTS\n  - Include at least 6-8 bullet points highlighting the most important aspects
  - Each point should be detailed and informative

  ## DETAILED ANALYSIS\n  - This section must be very comprehensive (at least 6-8 paragraphs)
  - Deeply analyze all aspects of the topic
  - Include multiple subsections with headings
  - Explore the topic from various angles
  - Provide specific examples, data points, and evidence

  ## DIFFERENT PERSPECTIVES\n  - Present at least 3-4 different viewpoints on the topic
  - Analyze competing theories or approaches
  - Consider alternative interpretations

  ## FOLLOW-UP QUESTIONS\n  - Suggest 3-5 thoughtful questions for further exploration\n\n
  YOUR RESPONSE: Based on the search results provided, here is my comprehensive answer to the query: "${query}":`;
};

// Backward-compatible export used by /api/llm/process
export const generatePrompt = (query, sources = []) => {
  const formatted = formatContentForLLM(sources);
  return generateSearchPrompt(query, formatted, {});
};

/**
 * Call the LLM API with the given prompt
 * @param {string} prompt LLM prompt
 * @param {Object} modelConfig Model configuration
 * @param {string} apiKey API key
 * @returns {Promise<Object>} LLM API response
 */
const callLLMAPI = async (prompt, modelConfig, apiKey) => {
  console.log('Calling Together API with model:', modelConfig.modelId);
  try {
    // Log the request details (without the full API key)
    console.log('API Request:', {
      endpoint: modelConfig.endpoint,
      model: modelConfig.modelId,
      promptLength: prompt?.length || 0,
      temperature: modelConfig.temperature,
      max_tokens: modelConfig.max_tokens,
      apiKeyProvided: !!apiKey,
      apiKeyLength: apiKey?.length || 0
    });

    const response = await axios.post(
      modelConfig.endpoint,
      {
        model: modelConfig.modelId,
        prompt: prompt,
        temperature: modelConfig.temperature,
        max_tokens: modelConfig.max_tokens,
        top_p: 0.9,
        stop: ['USER:', 'ASSISTANT:']
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        }
      }
    );
    
    // Log successful response format
    console.log('API Response format:', {
      success: true,
      id: response.data.id?.substring(0, 8) + '...',
      choicesLength: response.data.choices?.length,
      tokensUsed: response.data.usage?.total_tokens
    });
    
    return response.data;
  } catch (error) {
    // Create detailed error logs
    const errorDetails = {
      response: error.response?.data,
      status: error.response?.status,
      message: error.message,
      errorType: error.response?.status === 401 ? 'Authentication Error' : 
                error.response?.status === 429 ? 'Rate Limit Error' : 
                error.response?.status >= 500 ? 'Server Error' : 'API Error'
    };
    
    console.error('LLM API error:', errorDetails);
    
    // Provide more descriptive error messages based on status codes
    let errorMessage = error.response?.data?.error?.message || error.message;
    if (error.response?.status === 401) {
      errorMessage = 'Authentication failed. Please check your API key in .env.local file.';
    } else if (error.response?.status === 429) {
      errorMessage = 'Rate limit exceeded. Please try again later or use a different API key.';
    } else if (error.response?.status >= 500) {
      errorMessage = 'Together.ai server error. Please try again later.';
    }
    
    throw {
      message: errorMessage,
      code: error.response?.status === 401 ? 'auth_error' : 
            error.response?.status === 429 ? 'rate_limit_error' : 
            error.response?.status >= 500 ? 'server_error' : 'api_error',
      status: error.response?.status,
      original: error
    };
  }
};

/**
 * Process the LLM API response
 * @param {Object} response LLM API response
 * @param {string} query Original query
 * @param {Object} sourceMap Source map for reference
 * @returns {Object} Processed response
 */
const processLLMResponse = (response, query, sourceMap) => {
  if (!response || !response.choices || !response.choices[0]) {
    return createErrorResponse('Invalid LLM response format', 'format_error');
  }
  
  try {
    const text = response.choices[0].text || '';
    const formattedText = formatContentForDisplay(text);
    
    // Generate follow-up questions based on the content
    const followUpQuestions = [
      `Can you tell me more about ${query}?`,
      `What are the most recent developments in ${query}?`,
      `How do experts in the field view ${query}?`,
      `What are some practical applications of ${query}?`,
      `What are the key challenges related to ${query}?`,
    ];
    
    // Create the result object with comprehensive flags for detection
    const result = {
      // Core content
      content: formattedText,
      query: query,
      sources: sourceMap,
      sourceMap: sourceMap,
      followUpQuestions: followUpQuestions,
      
      // Model metadata
      modelId: response.model,
      usage: response.usage,
      
      // ALL standard LLM detection flags
      __isImmutableLLMResult: true,
      isLLMResult: true,
      llmProcessed: true,
      aiProcessed: true,
      isAIGenerated: true,
      isLLM: true,
      fromLLM: true,
      hasLLMMetadata: true,
      llmFormatted: true,
      llmGenerated: true,
      
      // Additional metadata for debugging
      raw: response,
      metadata: {
        processingTime: new Date().toISOString(),
        responseTime: response.created,
        tokensUsed: response.usage?.total_tokens || 0,
        model: response.model
      }
    };
    
    console.log('Successfully processed LLM response:', {
      contentLength: formattedText.length,
      hasFollowUp: true,
      model: response.model,
      tokensUsed: response.usage?.total_tokens
    });
    
    return result;
  } catch (error) {
    console.error('Error processing LLM response:', error);
    return createErrorResponse(
      'Error processing LLM response: ' + error.message,
      'processing_error'
    );
  }
};

/**
 * Format content for display by adding hyperlinks and formatting
 * @param {string} content Content to format
 * @returns {string} Formatted content
 */
export const formatContentForDisplay = (content) => {
  if (!content) return '';
  
  // Add hyperlinks
  let formatted = addHyperlinks(content);
  
  // Advanced formatting for better reading experience
  formatted = formatted
    // Format consecutive newlines for paragraph breaks
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/\n/g, '<br/>')
    // Format markdown-style headers
    .replace(/^#{1,6}\s+(.+)$/gm, (match, title) => `<strong>${title}</strong><br/>`)
    // Format markdown-style bullet points
    .replace(/^\s*[\*\-]\s+(.+)$/gm, (match, point) => `• ${point}<br/>`)
    // Format markdown-style numbered lists
    .replace(/^\s*\d+\.\s+(.+)$/gm, (match, point) => `• ${point}<br/>`)
    // Bold important terms enclosed in ** or __ (markdown style)
    .replace(/\*\*([^\*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    // Italicize text enclosed in * or _ (markdown style)
    .replace(/\*([^\*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    // Clean up any empty paragraphs
    .replace(/<br\/>\s*<br\/>\s*<br\/>/g, '<br/><br/>')
    // Format code blocks
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  
  return formatted;
};

/**
 * Add hyperlinks to text
 * @param {string} text Text to process
 * @returns {string} Text with hyperlinks
 */
export const addHyperlinks = (text) => {
  if (!text) return '';
  
  // URL regex pattern
  const urlPattern = /(https?:\/\/[^\s]+)/g;
  
  // Replace URLs with hyperlinks
  return text.replace(urlPattern, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
};

/**
 * Create a source map from search results
 * @param {Array|Object} searchResults Search results
 * @returns {Object} Source map
 */
export const createSourceMap = (searchResults) => {
  const sourceMap = {};
  
  if (Array.isArray(searchResults)) {
    searchResults.forEach((result, index) => {
      if (result && (result.url || result.link || result.source)) {
        sourceMap[`source-${index + 1}`] = {
          url: result.url || result.link || '',
          title: result.title || 'Source ' + (index + 1),
          snippet: result.snippet || result.description || ''
        };
      }
    });
  }
  
  return sourceMap;
};

/**
 * Create an error response object
 * @param {string} message Error message
 * @param {string} code Error code
 * @returns {Object} Error response object
 */
export const createErrorResponse = (message, code = 'error') => {
  return {
    __isImmutableLLMResult: true,
    isLLMResult: true,
    isError: true,
    errorType: code,
    error: message,
    content: `Error: ${message}`,
    type: 'error'
  };
};

/**
 * Create a fallback response when LLM processing fails
 * @param {string} query Search query
 * @returns {Object} Fallback response
 */
export const createFallbackResponse = (query) => {
  return {
    __isImmutableLLMResult: true,
    isLLMResult: true,
    content: `We couldn't process the LLM results for "${query}". Here are the raw search results instead.`,
    isFallback: true,
    query: query
  };
};

/**
 * Check if query is business-related
 * @param {string} query Query to check
 * @returns {boolean} True if business-related
 */
export const isBusinessRelatedQuery = (query) => {
  if (!query) return false;
  
  const businessTerms = [
    'business', 'company', 'startup', 'entrepreneur',
    'market', 'industry', 'finance', 'investment',
    'revenue', 'profit', 'sales', 'growth', 'strategy'
  ];
  
  const lowerQuery = query.toLowerCase();
  return businessTerms.some(term => lowerQuery.includes(term));
};
