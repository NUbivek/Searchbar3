/**
 * LLM Result Detector Utility
 * 
 * Provides standardized functions for detecting and handling LLM-processed results
 * Eliminates redundancies across the codebase by centralizing detection logic
 */
const logger = require('../logger');
const { debug, info, warn, error } = logger;

// Common flag names used to identify LLM results
const LLM_RESULT_FLAGS = [
  '__isImmutableLLMResult',
  'isLLMResults', 
  'llmProcessed',
  'aiProcessed',
  'isAIGenerated',
  'isLLM',
  'fromLLM',
  'hasLLMMetadata',
  'llmFormatted',
  'llmGenerated',
  // Additional flags used in the system
  'shouldUseLLM',
  'forceLLM',
  'useLLM',
  'isProcessedByLLM',
  'hasLLMContent',
  // New flags for better coverage
  'isTogetherAIResult',
  'generatedByLLM',
  'fromLLMAPI',
  'llmContent',
  'generatedContent',
  'aiGenerated'
];

/**
 * Detect if an item is an LLM result using multiple strategies
 * Enhanced with more comprehensive detection patterns
 * @param {any} item - The item to check
 * @returns {boolean} - Whether the item is an LLM result
 */
function isLLMResult(item) {
  if (!item) return false;
  
  try {
    // Strategy 1: Check for explicit flags (most reliable)
    for (const flag of LLM_RESULT_FLAGS) {
      if (item[flag] === true) {
        debug('LLM result detected via flag:', flag);
        return true;
      }
    }
    
    // Strategy 2: Check for content structure patterns
    if (item.content) {
      // Handle array content with type fields
      if (Array.isArray(item.content) && item.content.length > 0) {
        const firstContent = item.content[0];
        if (firstContent && (
          firstContent.type === 'llm' || 
          firstContent.type === 'ai' || 
          firstContent.type === 'assistant' || 
          firstContent.role === 'assistant'
        )) {
          debug('LLM result detected via content type/role');
          return true;
        }
      }
      
      // Check for HTML content with specific LLM patterns (enhanced for better detection)
      if (typeof item.content === 'string') {
        const content = item.content.toLowerCase();
        if (
          // Error messages
          content.includes('<div class="error-message">') ||
          content.includes('api authentication error') ||
          content.includes('api request timed out') ||
          content.includes('error processing search results') ||
          // Typical LLM response intros
          content.includes('i\'ve analyzed') ||
          content.includes('based on the search results') ||
          content.includes('according to the search results') ||
          content.includes('based on the provided') ||
          content.includes('here\'s what i found') ||
          content.includes('from the information provided') ||
          // HTML structural elements common in LLM responses
          content.includes('<h2>') ||
          content.includes('<h3>') ||
          content.includes('<summary>') ||
          content.includes('<analysis>') ||
          content.includes('<ul>') ||
          content.includes('<ol>') ||
          content.includes('<div class="llm-content">') ||
          // Common section markers in LLM output
          content.includes('summary:') ||
          content.includes('key points:') ||
          content.includes('analysis:') ||
          content.includes('conclusion:') ||
          content.includes('findings:') ||
          // Citation patterns
          content.includes('[source') ||
          content.includes('[citation') ||
          // More aggressive matches for length-based heuristics
          (content.length > 200 && (content.includes('<ul>') || content.includes('•'))) || // Bulleted lists are often from LLM
          (content.length > 400 && (content.includes('<p>') || content.match(/\n\n/g)?.length > 2)) || // Multiple paragraphs
          (content.length > 600) // Very long content is likely LLM-generated
        ) {
          debug('LLM result detected via enhanced content pattern matching');
          return true;
        }
      }
    }
    
    // Strategy 3: Check for special fields and structures
    if (
      (item.metrics && (item.categories || item.tabs)) ||
      (item.categories && Object.keys(item.categories).length > 0) ||
      (item.followUpQuestions && Array.isArray(item.followUpQuestions)) ||
      (item.sourceMap && Object.keys(item.sourceMap).length > 0)
    ) {
      debug('LLM result detected via special fields (metrics/categories/followUp/sourceMap)');
      return true;
    }
    
    // Strategy 4: Check for specific properties in errors
    // Enhanced with more detailed API error detection
    if (
      // Check if it has error indicators
      (item.isError || 
       item.error || 
       item.errorType || 
       item.apiError ||
       item.type === 'error' ||
       item.statusCode >= 400) && 
      // Check for API or authentication related errors
      ((item.text && (item.text.includes('LLM') || item.text.includes('API') || item.text.includes('key') || item.text.includes('auth'))) ||
       (item.errorMessage && (item.errorMessage.includes('API') || item.errorMessage.includes('key') || item.errorMessage.includes('auth') || item.errorMessage.includes('token'))) ||
       (item.message && (item.message.includes('API') || item.message.includes('key') || item.message.includes('auth') || item.message.includes('token'))) ||
       // Check for common error properties from API responses
       (item.statusCode === 401 || item.statusCode === 403) ||
       (item.status === 401 || item.status === 403) ||
       (item.errorCode === 'unauthorized' || item.errorCode === 'forbidden' || item.errorCode === 'authentication_error')
      )
    ) {
      debug('LLM API error result detected with enhanced detection');
      return true;
    }
    
    // Strategy 5: Check for synthesized content indicators
    if (item.synthesizedAnswer || item.summary || item.apiStatus) {
      debug('LLM result detected via synthesized content indicators');
      return true;
    }
    
    // If we reach here, it's not an LLM result within the try block
    return false;
  } catch (error) {
    // Handle detection errors gracefully
    warn('Error in LLM result detection:', error);
    return false;
  }
}

/**
 * Add LLM flags to an object to ensure proper rendering
 * Enhanced to ensure content is properly formatted with paragraphs and bullet points
 * @param {Object} item - The item to add flags to
 * @param {boolean} isSynthesized - Whether the content is synthesized (for metadata)
 * @returns {Object} - The item with added flags and properly formatted content
 */
function addLLMFlags(item, isSynthesized = false) {
  if (!item) return item;
  
  // Create a copy with all LLM flags set to true
  const flaggedItem = { ...item };
  LLM_RESULT_FLAGS.forEach(flag => {
    flaggedItem[flag] = true;
  });
  
  // Add synthesized flag if this is fallback content
  if (isSynthesized) {
    flaggedItem.synthesized = true;
    flaggedItem.fallbackSynthesized = true;
  }
  
  // Ensure we have content in a consistent format
  if (!flaggedItem.content) {
    if (flaggedItem.text) {
      flaggedItem.content = flaggedItem.text;
    } else if (flaggedItem.summary) {
      flaggedItem.content = flaggedItem.summary;
    } else if (flaggedItem.message) {
      flaggedItem.content = typeof flaggedItem.message === 'string' 
        ? flaggedItem.message 
        : JSON.stringify(flaggedItem.message);
    } else {
      // Create a minimal content placeholder
      flaggedItem.content = 'No detailed content available for this result.';
    }
  }
  
  // Ensure we have followUpQuestions
  if (!flaggedItem.followUpQuestions || !Array.isArray(flaggedItem.followUpQuestions)) {
    flaggedItem.followUpQuestions = [];
  }
  
  // Ensure we have sourceMap for attribution
  if (!flaggedItem.sourceMap) {
    flaggedItem.sourceMap = {};
  }
  
  // Ensure query is preserved
  if (!flaggedItem.query && item.query) {
    flaggedItem.query = item.query;
  }
  
  debug('Enhanced LLM result with flags and content normalization');
  return flaggedItem;
}

/**
 * Process LLM results to ensure consistency
 * Enhanced with better categorization and more stable processing
 * Optimized for paragraph and bullet point formatting
 * @param {Array|Object} results - The results to process
 * @returns {Array|Object} - Processed results
 */
function processLLMResults(results) {
  if (!results) return results;
  
  try {
    // Handle special cases
    if (results.error || results.isError || results.errorType) {
      debug('Processing LLM error result');
      return processSpecialResults(results);
    }
    
    // Handle array of results
    if (Array.isArray(results)) {
      debug(`Processing array of ${results.length} possible LLM results`);
      return results.map(item => {
        // Direct LLM result detection
        if (isLLMResult(item)) {
          return processSpecialResults(item);
        }
        
        // Check for nested objects that might be LLM results
        if (item && typeof item === 'object') {
          // Process nested arrays
          if (Array.isArray(item.content)) {
            debug('Processing nested content array');
            item.content = item.content.map(contentItem => {
              if (contentItem && typeof contentItem === 'object' && isLLMResult(contentItem)) {
                return processSpecialResults(contentItem);
              }
              return contentItem;
            });
          }
          
          // Process nested objects in 'result' or 'data' properties
          ['result', 'data', 'response'].forEach(propName => {
            if (item[propName] && typeof item[propName] === 'object' && isLLMResult(item[propName])) {
              debug(`Processing nested LLM result in ${propName} property`);
              item[propName] = processSpecialResults(item[propName]);
            }
          });
          
          // If the item has nested content that's an LLM result but the item itself isn't flagged,
          // Add LLM flags to the parent item too
          if ((item.content && isLLMResult(item.content)) || 
              (item.result && isLLMResult(item.result)) || 
              (item.data && isLLMResult(item.data))) {
            debug('Adding LLM flags to parent object with nested LLM content');
            return addLLMFlags(item);
          }
        }
        
        return item;
      });
    }
    
    // Handle single result object
    if (isLLMResult(results)) {
      // Process content for better formatting
      if (results.content && typeof results.content === 'string') {
        debug('Processing and enhancing structured LLM content');
        
        // Ensure content has proper markdown formatting for paragraphs and sections
        let content = results.content;
        
        // Check if we have markdown headings, if not add them
        if (!content.includes('## ')) {
          // Try to detect sections and add proper formatting
          ['SUMMARY', 'KEY POINTS', 'DETAILED ANALYSIS', 'FOLLOW-UP'].forEach(section => {
            const regex = new RegExp(`\\b${section}\\b\\s*:?`, 'i');
            content = content.replace(regex, `## ${section}`);
          });
        }
        
        // Make sure bullet points are properly formatted
        content = content.replace(/^\s*\*\s+/gm, '• '); // Convert * to bullet points
        content = content.replace(/^\s*-\s+/gm, '• '); // Convert - to bullet points
        
        // Update the content
        results.content = content;
      }
      
      debug('Processing single LLM result');
      return processSpecialResults(results);
    }
  } catch (err) {
    error('Error in processLLMResults:', err);
    // Return original results with error flag if processing fails
    if (typeof results === 'object') {
      return {
        ...results,
        processingError: err.message,
        ...addLLMFlags({}) // Add LLM flags to ensure it's detected
      };
    }
  }
  
  return results;
}

/**
 * Process special result types with enhanced handling
 * Optimized for structured format with paragraphs and bullet points
 * @param {Object} result - The result to process
 * @returns {Object} - Processed result with correct flags and format
 */
function processSpecialResults(result) {
  if (!result) return result;
  
  try {
    // Start with the original result
    let processedResult = { ...result };
    
    // Handle error objects specially with enhanced error messages and standardized format
    if (result.error || result.isError || result.errorType || result.apiError || (result.status && result.status >= 400)) {
      // Extract error details with fallbacks for different error structures
      const errorDetails = {
        message: 
          result.errorMessage || 
          (result.error && result.error.message) || 
          (result.error && typeof result.error === 'string' ? result.error : null) ||
          result.message || 
          'Unknown error',
        status: result.status || result.statusCode || (result.error && result.error.status) || 500,
        code: result.errorCode || (result.error && result.error.code) || 'error',
        type: result.errorType || (result.error && result.error.type) || 'processing_error'
      };
      
      // Check if this is an API key or authentication error
      const isAuthError = (
        errorDetails.status === 401 || 
        errorDetails.status === 403 ||
        errorDetails.code === 'unauthorized' ||
        errorDetails.message.toLowerCase().includes('api key') ||
        errorDetails.message.toLowerCase().includes('authentication') ||
        errorDetails.message.toLowerCase().includes('unauthorized')
      );
      
      // Create user-friendly error message based on error type
      let userFriendlyMessage = '';
      if (isAuthError) {
        userFriendlyMessage = 'The answer service could not be reached. Please try again.';
      } else if (errorDetails.status === 429) {
        userFriendlyMessage = 'The API rate limit was exceeded. Please try again in a few moments.';
      } else if (errorDetails.status >= 500) {
        userFriendlyMessage = 'There was an issue with the LLM service. Please try again later.';
      } else {
        userFriendlyMessage = 'An error occurred while processing your search results. Please try a different query.';
      }
      
      // Format content for display with troubleshooting information
      const formattedContent = `<div class="error-message">
        <h3>Error: ${errorDetails.message}</h3>
        <p>${userFriendlyMessage}</p>
        <p>Troubleshooting:</p>
        <ul>
          
          
          ${errorDetails.status >= 500 ? '<li>The service might be temporarily unavailable</li>' : ''}
          ${errorDetails.status === 429 ? '<li>Wait a moment and try again</li>' : ''}
          <li>Try a simpler search query</li>
          <li>Check your internet connection</li>
        </ul>
      </div>`;
      
      processedResult = {
        ...processedResult,
        isError: true,
        error: {
          ...errorDetails,
          isAuthError,
          userFriendlyMessage
        },
        // Ensure there's always content for rendering
        content: formattedContent,
        // Add error-specific flags
        errorDetected: true,
        errorProcessed: true
      };
    }
    
    // Format content for better readability if it exists
    if (processedResult.content && typeof processedResult.content === 'string') {
      let content = processedResult.content;
      
      // Only process if not already well-formatted
      if (!content.includes('## SUMMARY') && !content.includes('## Summary')) {
        debug('Enhancing content structure in processSpecialResults');
        
        // Add section headers if missing
        ['SUMMARY', 'KEY POINTS', 'DETAILED ANALYSIS', 'FOLLOW-UP QUESTIONS'].forEach(section => {
          const regex = new RegExp(`\\b${section}\\b\\s*:?`, 'i');
          if (content.match(regex)) {
            content = content.replace(regex, `## ${section}`);
          }
        });
        
        // Improve bullet point formatting
        content = content.replace(/^\s*\*\s+/gm, '• '); // Convert * to bullet points
        content = content.replace(/^\s*-\s+/gm, '• '); // Convert - to bullet points
        content = content.replace(/(?<!#)\n\n(?=\w)/g, '\n\n'); // Fix paragraph spacing
        
        // Convert citation references to consistent format
        content = content.replace(/\[(\d+)\]/g, '[Source $1]');
        
        processedResult.content = content;
      }
    }
    
    // Handle category objects
    if (result.categories && Object.keys(result.categories).length > 0) {
      // Transform categories if needed
      const categoryItems = Object.entries(result.categories).map(([key, value]) => ({
        id: key,
        name: key.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' '),
        content: value,
        items: Array.isArray(value) ? value : [{ content: value }]
      }));
      
      if (!processedResult.processedCategories) {
        processedResult.processedCategories = categoryItems;
      }
    }
    
    // Ensure followUpQuestions is always populated
    if (!processedResult.followUpQuestions) {
      processedResult.followUpQuestions = [];
    }
    
    // Add all LLM flags to ensure consistent detection
    return addLLMFlags(processedResult);
  } catch (err) {
    error('Error in processSpecialResults:', err);
    return addLLMFlags(result); // Fallback to just adding flags
  }
}

/**
 * Detect if an object has LLM error information
 * @param {any} item - The item to check
 * @returns {boolean} - Whether the item has LLM error information
 */
function isLLMError(item) {
  if (!item) return false;
  
  try {
    if (item.isError || item.error || item.errorType || item.apiError || 
        (item.status && item.status >= 400) || 
        (item.statusCode && item.statusCode >= 400)) {
      return true;
    }
    
    // Check for error messages in common properties
    const errorKeywords = ['error', 'fail', 'authentication', 'unauthorized', 'api key'];
    for (const prop of ['message', 'errorMessage', 'text', 'content']) {
      if (item[prop] && typeof item[prop] === 'string') {
        const content = item[prop].toLowerCase();
        for (const keyword of errorKeywords) {
          if (content.includes(keyword)) {
            return true;
          }
        }
      }
    }
  } catch (err) {
    warn('Error in isLLMError detection:', err);
  }
  
  return false;
}

/**
 * Create standardized empty LLM result
 * @param {string} query - The query for which to create an empty result
 * @returns {Object} - An empty LLM result with proper flags
 */
function createEmptyLLMResult(query = '') {
  return addLLMFlags({
    content: 'No results were found for this query.',
    query,
    followUpQuestions: [
      'Would you like to try a different search query?',
      'Can you be more specific about what you\'re looking for?'
    ],
    sourceMap: {},
    isEmpty: true
  });
}

module.exports = {
  isLLMResult,
  isLLMError,
  addLLMFlags,
  processLLMResults,
  processSpecialResults,
  createEmptyLLMResult,
  LLM_RESULT_FLAGS
};
