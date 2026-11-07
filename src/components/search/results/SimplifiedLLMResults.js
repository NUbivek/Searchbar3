/**
 * SimplifiedLLMResults.js
 * A simplified version of the LLM results display with just two tabs:
 * "All Results" and "Key Insights"
 * For now, focusing on displaying raw LLM results in the All Results tab
 */

import React, { useState, useMemo, useRef, useEffect } from 'react';
import TabNavigation from './TabNavigation';
import styles from './SimplifiedLLMResults.module.css';
import EvidencePanel from './EvidencePanel';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

let purifyConfigured = false;

/**
 * Render result text (markdown or HTML) to sanitized HTML.
 * Result text comes from third-party pages, feeds and LLM output, so it must
 * never be injected unsanitized (XSS).
 */
export const renderSafeHtml = (text) => {
  // Some LLM paths emit literal "\n" sequences instead of newlines.
  const normalized = String(text || '').replace(/\\n/g, '\n');
  const looksLikeHtml = /<\/?(p|div|h[1-6]|ul|ol|li|br|strong|em|a|table)\b/i.test(normalized);
  const html = looksLikeHtml ? normalized : marked.parse(normalized, { breaks: true, gfm: true });
  if (typeof window === 'undefined') {
    // Server render: no DOM to sanitize with, so show plain escaped text.
    return normalized.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  if (!purifyConfigured) {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && node.getAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    purifyConfigured = true;
  }
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
};

/**
 * ExpandableContent Component
 * Handles expandable content with show more/less functionality
 * Enhanced to show full content by default with collapsing option
 */
const ExpandableContent = ({ content }) => {
  // Default to collapsed state
  const [expanded, setExpanded] = useState(false);
  const contentRef = useRef(null);
  const [needsExpansion, setNeedsExpansion] = useState(false);
  const maxCollapsedHeight = 300; // Increased height to show at least two paragraphs
  
  // Set up expansion detection on mount and content change
  useEffect(() => {
    // Force recheck after render to ensure accurate height measurement
    const timer = setTimeout(() => {
      if (contentRef.current) {
        const contentHeight = contentRef.current.scrollHeight;
        // Only set needs expansion if content is significantly longer
        const paragraphCount = (processContent().match(/<p/g) || []).length;
        setNeedsExpansion(contentHeight > maxCollapsedHeight && paragraphCount >= 2);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [content]);
  
  // Handle different content types to ensure consistent handling
  const processContent = () => {
    // If content is null or undefined, return empty string
    if (content === null || content === undefined) {
      return '';
    }
    
    // If content is already a string, use it directly
    if (typeof content === 'string') {
      return content;
    }
    
    // If content is an object with text or html property, use that
    if (typeof content === 'object') {
      if (content.text) return content.text;
      if (content.html) return content.html;
      if (content.content) return content.content;
      
      // Try to stringify the object
      try {
        return JSON.stringify(content, null, 2);
      } catch (e) {
        console.error('Failed to stringify content:', e);
        return 'Unable to display content';
      }
    }
    
    // For any other type, convert to string
    return String(content);
  };
  
  const processedContent = renderSafeHtml(processContent());
  
  // Toggle expanded state
  const toggleExpansion = () => {
    setExpanded(!expanded);
  }
  
  return (
    <div className={styles.expandableContent}>
      <div 
        ref={contentRef}
        className={`${styles.fullContent} ${!expanded && needsExpansion ? styles.contentCollapsed : ''}`}
        style={{
          maxHeight: expanded || !needsExpansion ? 'none' : `${maxCollapsedHeight}px`,
          overflowY: expanded || !needsExpansion ? 'auto' : 'hidden',
        }}
        dangerouslySetInnerHTML={{ __html: processedContent }} 
      />
      
      {needsExpansion && (
        <div className={styles.expandButtonContainer}>
          <button 
            className={styles.expandButton}
            onClick={toggleExpansion}
            aria-expanded={expanded}
          >
            {expanded ? 'See less' : 'See more'}
          </button>
          <span className={styles.contentIndicator}>
            {expanded ? 'Showing all content' : 'Content truncated'}
          </span>
        </div>
      )}
    </div>
  );
};

/**
 * Follow-up chat UI component
 */
export const FollowUpChat = ({ onSubmit }) => {
  const [input, setInput] = useState('');
  
  const handleSubmit = () => {
    if (!input.trim()) return;
    onSubmit(input);
    setInput('');
  };
  
  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      handleSubmit();
    }
  };
  
  return (
    <div className={styles.followupContainer}>
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyPress={handleKeyPress}
        className={styles.followupInput}
        placeholder="Ask a follow-up question..."
      />
      <button 
        onClick={handleSubmit} 
        className={styles.followupButton}
      >
        Chat
      </button>
    </div>
  );
};

/**
 * SimplifiedLLMResults Component
 * Displays LLM search results with a clean tab interface with exactly two tabs:
 * "All Results" and "Key Insights"
 * 
 * @param {Object} props Component props
 * @param {Array} props.results - Array of search result items
 * @param {string} props.query - The search query
 * @param {Function} props.onFollowUpSearch - Callback for handling follow-up searches
 */
const SimplifiedLLMResults = ({ 
  results = [],
  query = '',
  onFollowUpSearch = null
}) => {
  const [followUpQueries, setFollowUpQueries] = useState([]);
  
  const isErrorPayload = (item) => Boolean(
    item &&
    (
      item.isError === true ||
      item.type === 'error' ||
      item.errorType ||
      item.status === 'error'
    )
  );
  const sanitizeResults = (items = []) => items.filter((item) => (
    item !== null &&
    item !== undefined &&
    !isErrorPayload(item)
  ));
  

  // Detect if results contain errors
  const hasErrorResults = useMemo(() => {
    // Check if the entire results object is an error
    if (isErrorPayload(results)) {
      console.log('Detected LLM error result:', results.error || results.content || 'Unknown error');
      return true;
    }
    
    // Check array items for errors
    if (Array.isArray(results)) {
      return results.some(item => isErrorPayload(item));
    }
    
    return false;
  }, [results]);

  const hasAuthError = useMemo(() => {
    if (!results) return false;
    if (Array.isArray(results)) {
      return results.some((item) => item?.errorType === 'auth_error');
    }
    return results?.errorType === 'auth_error';
  }, [results]);

  // Process results into valid format with improved detection
  const validResults = useMemo(() => {
    console.log('Processing LLM results in SimplifiedLLMResults:', {
      resultsType: typeof results,
      isArray: Array.isArray(results),
      contentLength: results && results.content ? results.content.length : 'N/A',
      hasLLMResults: results && results.llmResults ? true : false,
      llmFlags: results ? {
        isLLMResult: results.isLLMResult,
        isLLMResults: results.isLLMResults,
        __isImmutableLLMResult: results.__isImmutableLLMResult,
        llmProcessed: results.llmProcessed
      } : {},
      topLevelKeys: results ? Object.keys(results).slice(0, 8) : []
    });
    
    if (!results) return [];
    
    // Check if this is a raw search result that needs formatting
    const isRawSearchResult = 
      !results.isLLMResult && 
      !results.isLLMResults && 
      !results.__isImmutableLLMResult && 
      !results.llmProcessed &&
      typeof results === 'object' &&
      (results.title || results.url || results.snippet);
    
    // If it's a raw search result, format it for display
    if (isRawSearchResult) {
      console.log('Detected raw search result, formatting for display');
      if (Array.isArray(results)) {
        // Format each result
        return results.map(item => ({
          content: `<div class="raw-result">
            <h3>${item.title || 'Untitled'}</h3>
            <p><a href="${item.url || '#'}">${item.url || ''}</a></p>
            <p>${item.snippet || ''}</p>
          </div>`,
          isLLMResult: true,
          __isImmutableLLMResult: true
        }));
      } else {
        // Single result
        return [{
          content: `<div class="raw-result">
            <h3>${results.title || 'Untitled'}</h3>
            <p><a href="${results.url || '#'}">${results.url || ''}</a></p>
            <p>${results.snippet || ''}</p>
          </div>`,
          isLLMResult: true,
          __isImmutableLLMResult: true
        }];
      }
    }
    
    // Check for nested llmResults property, which is common in API responses
    if (results.llmResults) {
      console.log('Found llmResults property, using it directly');
      const llmContent = results.llmResults;
      // Ensure it has the right flags
      if (typeof llmContent === 'object' && !Array.isArray(llmContent)) {
        llmContent.isLLMResult = true;
        llmContent.__isImmutableLLMResult = true;
      }
      return sanitizeResults(Array.isArray(llmContent) ? llmContent : [llmContent]);
    }
    
    // Check for content property at the top level
    if ((results.content || typeof results.text === 'string') && !Array.isArray(results)) {
      console.log('Found content or text property at top level');
      
      // If content doesn't exist but text does, use text as content
      if (!results.content && results.text) {
        console.log('Using text property as content');
        results.content = results.text;
      }
      
      // Ensure proper flags
      results.isLLMResult = true;
      results.__isImmutableLLMResult = true;
      return sanitizeResults([results]);
    }
    
    // If results is a plain array
    if (Array.isArray(results)) {
      console.log('Processing array of results');
      const filtered = results.filter(r => r !== null && r !== undefined);
      
      // Ensure each item has proper flags
      return filtered.map(item => {
        if (typeof item === 'object') {
          item.isLLMResult = true;
          item.__isImmutableLLMResult = true;
        }
        return item;
      }).filter((item) => !isErrorPayload(item));
    }
    
    // Default case: treat the whole object as a single result
    console.log('Treating object as single result');
    // Add flags if missing
    if (typeof results === 'object') {
      results.isLLMResult = true;
      results.__isImmutableLLMResult = true;  
    }
    return sanitizeResults([results]);
  }, [results]);


  // Handle follow-up search
  const handleFollowUpSearch = (followUpQuery) => {
    // Add to the list of follow-up queries
    setFollowUpQueries(prev => [...prev, followUpQuery]);
    
    // Call the parent handler if available
    if (onFollowUpSearch) {
      onFollowUpSearch(followUpQuery);
    }
  };

  // Create the two tabs
  const allResultsTab = {
    id: 'all-results',
    label: 'All Results',
    content: (
      <div className={styles.tabContentContainer}>
        {validResults.length > 0 ? (
          validResults.map((result, index) => (
            <div key={`result-${index}`} className={styles.resultItem}>
              <div className={styles.resultContent}>
                <ExpandableContent content={
                  typeof result === 'string' ? result : 
                  typeof result.content === 'string' ? result.content :
                  JSON.stringify(result)
                } />
              </div>
            </div>
          ))
        ) : (
          <div className={styles.noResultsMessage}>
            No results available for this search.
          </div>
        )}
      </div>
    )
  };

  // Evidence tab: quoted, cited facts and a source table (no invented scores)
  const keyInsightsTab = {
    id: 'key-insights',
    label: 'Evidence',
    content: (
      <div className={styles.tabContentContainer}>
        <EvidencePanel data={results} />
      </div>
    )
  };

  // Make All Results tab appear first, followed by Key Insights
  const tabsToShow = [allResultsTab, keyInsightsTab];

  return (
    <div 
      className={styles.simplifiedContainer} 
      data-testid="simplified-llm-results"
    >
      {/* Status bar with query info */}
      <div className={styles.statusBar}>
        <div className={styles.queryInfo}>
          <span className={styles.statusLabel}>{query ? `"${query}"` : 'Results'}</span>
        </div>
        <div className={styles.resultCount}>
          {validResults?.length || 0} result(s) available
        </div>
      </div>
      
      {/* Alert box for API errors if detected */}
      {hasErrorResults && validResults.length === 0 && (
        <div className={styles.errorAlert}>
          <h4 className={styles.errorTitle}>API Error</h4>
          <p className={styles.errorMessage}>
            An error occurred with the Together API. This may be due to an invalid API key.
            Please check your API key configuration or try again later.
          </p>
        </div>
      )}
      {hasAuthError && validResults.length > 0 && (
        <div className={styles.errorAlert}>
          <h4 className={styles.errorTitle}>Provider Warning</h4>
          <p className={styles.errorMessage}>
            The LLM provider returned an authentication warning. Showing available search results with fallback synthesis.
          </p>
        </div>
      )}

      {/* Tab Navigation - moved outside of scrollable area */}
      <TabNavigation 
        tabs={tabsToShow} 
        defaultTabId="all-results"
        onTabChange={(tabId) => console.log('Tab changed to:', tabId)}
        containerStyle={{ 
          margin: '10px 0 0 0',
          border: '1px solid #e5e7eb',
          borderRadius: '8px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
          flex: 1,
          display: 'flex',
          flexDirection: 'column'
        }}
      />

      {/* Follow-up chat input - fixed at bottom */}
      <div className={styles.followupWrapper}>
        {onFollowUpSearch && (
          <FollowUpChat onSubmit={handleFollowUpSearch} />
        )}
      </div>
    </div>
  );
};

export default SimplifiedLLMResults;
