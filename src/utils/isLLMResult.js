/**
 * Comprehensive LLM result detection utility
 * Implements multiple strategies to reliably detect LLM-generated content
 */

// Common flags that indicate an object is an LLM result
const LLM_RESULT_FLAGS = [
  '__isImmutableLLMResult',
  'isLLMResult',
  'llmProcessed',
  'aiProcessed',
  'isAIGenerated',
  'isLLM',
  'fromLLM',
  'hasLLMMetadata',
  'llmFormatted',
  'llmGenerated'
];

// Common error types for LLM processing
const LLM_ERROR_TYPES = [
  'auth_error',
  'api_error',
  'rate_limit',
  'server_error',
  'processing_error',
  'format_error'
];

/**
 * Enhanced detection of LLM results using multiple strategies
 * @param {any} obj - Object to check
 * @returns {boolean} - Whether the object is an LLM result
 */
export function isLLMResult(obj) {
  // Handle null/undefined
  if (!obj || typeof obj !== 'object') return false;

  // Strategy 1: Check for explicit flags (most reliable)
  if (hasLLMFlag(obj)) return true;

  // Strategy 1.5: Check for specific properties common in LLM results
  if (obj.llmResults || obj.llm_results || obj.content || obj.synthesizedAnswer ||
      obj.isLLMResults || obj.type === 'llm_summary' || obj.followUpQuestions) {
    return true;
  }

  // Strategy 2: Check content structure characteristics
  if (hasLLMContentStructure(obj)) return true;

  // Strategy 3: Check for common error patterns
  if (isLLMError(obj)) return true;

  // Strategy 4: Check for nested LLM results
  if (hasNestedLLMResult(obj)) return true;

  return false;
}

/**
 * Check if object has any of the standard LLM result flags
 */
function hasLLMFlag(obj) {
  return LLM_RESULT_FLAGS.some(flag => obj[flag] === true);
}

/**
 * Check if the object structure matches common LLM response patterns
 * Enhanced to detect more LLM result formats
 */
function hasLLMContentStructure(obj) {
  // Check for object with content property (most common case)
  if (obj.content) {
    // If content is a string and reasonably long, it's likely LLM content
    if (typeof obj.content === 'string' && obj.content.length > 20) {
      // More aggressive pattern matching to catch LLM-generated content
      const hasTextPatterns = /\n|\*|#|>|\.|,|:/.test(obj.content) || 
                             obj.content.includes('.');
      
      if (hasTextPatterns) return true;
    }
    
    // If content is an array (chat-like format)
    if (Array.isArray(obj.content) && obj.content.length > 0) {
      // Check for message format
      const hasMessageStructure = obj.content.some(item => 
        item.role === 'assistant' || 
        item.type === 'assistant' || 
        item.type === 'ai' || 
        item.type === 'llm'
      );
      
      if (hasMessageStructure) return true;
    }
  }
  
  // Check for other common properties in LLM results
  if (obj.results && Array.isArray(obj.results) && obj.results.length > 0) {
    return true;
  }

  // Check for standard chat-completion API structure
  if (obj.choices && Array.isArray(obj.choices) && obj.choices.length > 0) {
    if (obj.choices[0].text || obj.choices[0].message?.content) return true;
  }

  // Properties that typically carry written output. An empty array (the
  // API's `categories: []` on a no-result search) is not written output.
  const llmIndicators = [
    'summary',
    'analysis',
    'synthesized',
    'answer',
    'generated',
    'followUpQuestions',
    'keyInsights'
  ];

  for (const indicator of llmIndicators) {
    const value = obj[indicator];
    if ((typeof value === 'string' && value.trim()) || (Array.isArray(value) && value.length > 0)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if object represents an LLM processing error
 */
export function isLLMError(obj) {
  if (!obj || typeof obj !== 'object') return false;

  // Explicit error flag
  if (obj.isError === true) return true;

  // Known LLM error types (a plain `error` key on a search response is the
  // search service's own message, not an LLM result)
  if (obj.errorType && LLM_ERROR_TYPES.includes(obj.errorType)) return true;

  // Chat-completion API error structure
  if (obj.error && typeof obj.error === 'object' && obj.error.type && obj.error.message) return true;

  return false;
}

/**
 * Check for nested LLM results in common container properties
 */
function hasNestedLLMResult(obj) {
  // Common container properties that might hold an LLM result
  const containerProps = ['result', 'llm', 'data', 'response'];
  
  // Check each container property
  for (const prop of containerProps) {
    if (obj[prop] && typeof obj[prop] === 'object') {
      if (isLLMResult(obj[prop])) return true;
    }
  }
  
  // Check array of results
  if (Array.isArray(obj) && obj.length > 0) {
    // Check if first element is an LLM result
    if (isLLMResult(obj[0])) return true;
  }
  
  return false;
}

/**
 * Create a standard empty LLM result
 */
export function createEmptyLLMResult(query = '', errorMessage = null) {
  return {
    content: errorMessage || 'No results available.',
    query: query,
    __isImmutableLLMResult: true,
    isLLMResult: true,
    llmProcessed: true,
    empty: true,
    error: errorMessage || null
  };
}

// Export constants for external use
export { LLM_RESULT_FLAGS, LLM_ERROR_TYPES };
