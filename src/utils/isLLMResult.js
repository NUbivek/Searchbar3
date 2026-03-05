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
  if (!obj) return false;
  
  console.log('Checking if object is LLM result:', JSON.stringify(obj).substring(0, 150) + '...');
  
  // Strategy 1: Check for explicit flags (most reliable)
  if (hasLLMFlag(obj)) {
    console.log('✅ Detected LLM result via flags');
    return true;
  }
  
  // Strategy 1.5: Check for specific properties common in LLM results
  if (obj.llmResults || obj.llm_results || obj.synthesizedAnswer || 
      obj.isLLMResults || obj.type === 'llm_summary' || obj.followUpQuestions) {
    console.log('✅ Detected LLM result via specific properties');
    return true;
  }
  
  // Strategy 2: Check content structure characteristics
  if (hasLLMContentStructure(obj)) {
    console.log('✅ Detected LLM result via content structure');
    return true;
  }
  
  // Strategy 3: Check for common error patterns
  if (isLLMError(obj)) {
    console.log('✅ Detected LLM result via error pattern');
    return true;
  }
  
  // Strategy 4: Check for nested LLM results
  if (hasNestedLLMResult(obj)) {
    console.log('✅ Detected LLM result via nested results');
    return true;
  }
  
  console.log('❌ Not detected as LLM result');
  // Not detected as LLM result
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
  if (typeof obj.content === 'string' && obj.content.trim().length > 0) {
    // If content is a string and reasonably long, it's likely LLM content
    if (typeof obj.content === 'string' && obj.content.length > 20) {
      // More aggressive pattern matching to catch LLM-generated content
      const hasTextPatterns = /\n|\*|#|>|\.|,|:/.test(obj.content) || 
                             obj.content.includes('.');
      
      if (hasTextPatterns) {
        console.log('Detected LLM pattern in content string');
        return true;
      }
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
      
      if (hasMessageStructure) {
        console.log('Detected assistant/LLM messages in content array');
        return true;
      }
    }
  }
  
  // NOTE: plain `results` arrays are common for non-LLM search APIs.
  // Do not treat them as LLM output without explicit LLM markers.
  
  // Check for standard Together.ai structure
  if (obj.choices && Array.isArray(obj.choices) && obj.choices.length > 0) {
    if (obj.choices[0].text || obj.choices[0].message?.content) {
      console.log('Detected standard LLM API response format');
      return true;
    }
  }
  
  // Check for any properties that typically indicate LLM results
  const llmIndicators = [
    'summary',
    'analysis',
    'synthesized',
    'answer',
    'generated',
    'followUpQuestions',
    'keyInsights',
    'categories'
  ];
  
  for (const indicator of llmIndicators) {
    if (obj[indicator] && 
       (typeof obj[indicator] === 'string' || 
        Array.isArray(obj[indicator]))) {
      console.log(`Detected LLM indicator property: ${indicator}`);
      return true;
    }
  }
  
  return false;
}

/**
 * Check if object represents an LLM processing error
 */
export function isLLMError(obj) {
  if (!obj) return false;
  
  // Check for explicit error flags
  if (obj.isError === true || obj.error || obj.errorType) {
    return true;
  }
  
  // Check for known error types
  if (obj.errorType && LLM_ERROR_TYPES.includes(obj.errorType)) {
    return true;
  }
  
  // Check for Together API error structure
  if (obj.error && obj.error.type && obj.error.message) {
    return true;
  }
  
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
