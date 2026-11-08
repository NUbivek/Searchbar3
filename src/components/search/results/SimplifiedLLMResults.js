/**
 * SimplifiedLLMResults.js
 * A simplified version of the LLM results display with just two tabs:
 * "All Results" and "Key Insights"
 * For now, focusing on displaying raw LLM results in the All Results tab
 */

import React, { useState, useMemo, useRef, useEffect } from 'react';
import TabNavigation from './TabNavigation';
import styles from './SimplifiedLLMResults.module.css';
import searchResultScorer from '../../../utils/scoring/SearchResultScorer';
import { detectQueryContext } from '../utils/contextDetector';
import { scoreSourceReputation, getSourceBadge } from '../sources/SourceReputationScorer';
import { describeMetric } from '../metrics/MeasuredMetrics';
import { isVerifiedSource } from '../../../utils/sourceTiers';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

let purifyConfigured = false;

/**
 * Render result text (markdown or HTML) to sanitized HTML. Result text comes
 * from third-party pages, feeds and LLM output, so it must never be injected
 * unsanitized (XSS).
 */
export const renderSafeHtml = (text) => {
  // Some LLM paths emit literal "\n" sequences instead of newlines.
  const normalized = String(text || '').replace(/\\n/g, '\n');
  const looksLikeHtml = /<\/?(p|div|h[1-6]|ul|ol|li|br|strong|em|a|table|span)\b/i.test(normalized);
  const html = looksLikeHtml ? normalized : marked.parse(normalized, { breaks: true, gfm: true });
  if (typeof window === 'undefined') {
    return normalized.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  if (!purifyConfigured) {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      // External links open in a new tab; in-page anchors (#source-3) do not
      if (node.tagName === 'A' && node.getAttribute('href') && !node.getAttribute('href').startsWith('#')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    purifyConfigured = true;
  }
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
};

const escapeHtml = (text) => String(text || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Same highlight style as categories/display/NumberHighlighter.js
const NUMBER_PATTERN = /((?:[$€£]\s?)?\d[\d,.]*\s?(?:%|percent|[MBK]\b|million|billion|x\b)?)/g;
// Highlight figures but not dates ("2026-10-21") or source citations.
const DATE_OR_CITATION = /(\d{4}-\d{2}-\d{2}|\[Source[^\]]*\])/;
const highlightNumbers = (sentence) => escapeHtml(sentence)
  .split(DATE_OR_CITATION)
  .map((part, i) => (i % 2 === 1 ? part : part.replace(NUMBER_PATTERN, (m) => (
    /\d/.test(m) && m.trim().length > 1
      ? `<span style="font-weight:bold;color:#0066cc;background-color:#0066cc15;padding:2px 4px;border-radius:3px">${m}</span>`
      : m
  ))))
  .join('');

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
        // Only offer "See more" when the rendered content is long and has
        // more than one block (paragraph, heading, list item)
        const blockCount = contentRef.current.querySelectorAll('p, li, h1, h2, h3, h4').length;
        setNeedsExpansion(contentHeight > maxCollapsedHeight && blockCount >= 2);
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
      if (typeof content.text === 'string') return content.text;
      if (typeof content.html === 'string') return content.html;
      if (typeof content.content === 'string') return content.content;
      // An object with no readable text is never dumped as JSON
      return '';
    }
    
    // For any other type, convert to string
    return String(content);
  };
  
  const processedContent = processContent();
  
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
        dangerouslySetInnerHTML={{ __html: renderSafeHtml(processedContent) }} 
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
const debugLog = () => {};

// The article's own headline is the row label (publisher is secondary text)
const createArticleTitle = (result, index) => {
  const title = String(result.title || '').replace(/^File Source:\s*/, '').replace(/\s+/g, ' ').trim();
  if (title) return title.length > 110 ? `${title.slice(0, 107).trim()}…` : title;
  return createDescriptiveTitle(result, index);
};

// Publisher / site label for a source ("Sifted", "techcrunch.com")
const createDescriptiveTitle = (result, index) => {
  if (result.source === 'file') return 'Your file';
  // Curated registry results carry the source's own name ("Sifted Funding Feed")
  if (result.sourceName) {
    return String(result.sourceName).replace(/\s+(Feed|RSS)$/i, '');
  }

  // First try to extract domain name if URL exists
  if (result.url) {
    try {
      const url = new URL(String(result.url));
      const domain = url.hostname.replace('www.', '');
      // Extract main domain name and capitalize
      const siteName = domain.split('.')[0];
      return siteName.charAt(0).toUpperCase() + siteName.slice(1);
    } catch {}
  }
  
  // If title exists, extract a clean, short phrase
  if (result.title) {
    const title = String(result.title);
    // Clean up title
    const cleaned = title.replace(/^(https?:\/\/)?([\w\.-]+\.[a-z]{2,})(\/.*)?(\s|\||-|:)/, '');
    
    // For short titles, just return as is
    if (cleaned.length < 20) return cleaned;
    
    // Filter out common words for a more meaningful phrase
    const words = cleaned.split(/\s+/).filter(word => {
      return word.length > 2 && 
            !['and', 'the', 'for', 'with', 'that', 'this', 'from', 'to'].includes(word.toLowerCase());
    });
    
    // Create a 3-5 word phrase that makes sense
    if (words.length >= 2) {
      return words.slice(0, Math.min(5, words.length)).join(' ');
    }
    
    // If no good phrase, use first 20 chars
    return cleaned.substring(0, 20);
  }
  
  // If snippet exists, extract a meaningful phrase
  if (result.snippet) {
    const snippet = String(result.snippet);
    
    // For short snippets, use as is
    if (snippet.length < 20) return snippet;
    
    // Try to find the most meaningful phrase
    const cleanWords = snippet.split(/\s+/).filter(word => {
      return word.length > 2 && 
            !['and', 'the', 'for', 'with', 'that', 'this', 'from', 'to'].includes(word.toLowerCase());
    });
    
    if (cleanWords.length >= 2) {
      return cleanWords.slice(0, Math.min(5, cleanWords.length)).join(' ');
    }
  }
  
  // Last resort - use the raw URL if available
  if (result.url) {
    const rawUrl = String(result.url);
    // Just show the domain + first path segment if possible
    try {
      const url = new URL(rawUrl);
      const domain = url.hostname.replace('www.', '');
      const pathSegment = url.pathname.split('/').filter(s => s.length > 0)[0] || '';
      const displayUrl = domain + (pathSegment ? '/' + pathSegment : '');
      return displayUrl.length > 25 ? displayUrl.substring(0, 25) : displayUrl;
    } catch {}
    
    // If URL parsing fails, use raw URL (shortened)
    return rawUrl.length > 25 ? rawUrl.substring(0, 25) : rawUrl;
  }
  
  // Absolute last resort - generic source reference
  return 'Source ' + (index + 1);
};

/**
 * Collect every real source object (url + title/snippet) from the results payload.
 */
const collectSources = (results, validResults) => {
  // Prefer the full search result objects (they carry dates, tiers and
  // source categories); the summary's sourceMap is only a stripped copy.
  if (results && !Array.isArray(results) && Array.isArray(results.results)) {
    const direct = results.results.filter((r) => r && typeof r === 'object' && (r.url || r.link) && (r.title || r.snippet));
    if (direct.length > 0) return direct.map((r) => ({ ...r, url: r.url || r.link }));
  }
    let allPossibleSources = [];
    
    // Function to recursively search for sources in objects
    const extractSourcesFromObject = (obj) => {
      // Guard clause for non-objects
      if (!obj || typeof obj !== 'object') return;
      
      // Direct source objects have URL and title or snippet
      if (obj.url && (obj.title || obj.snippet)) {
        allPossibleSources.push(obj);
      }
      
      // Check for sources array property
      if (obj.sources && Array.isArray(obj.sources)) {
        obj.sources.forEach(source => {
          if (source && typeof source === 'object' && source.url) {
            allPossibleSources.push(source);
          }
        });
      }
      
      // Check for data.sources path
      if (obj.data && obj.data.sources && Array.isArray(obj.data.sources)) {
        obj.data.sources.forEach(source => {
          if (source && typeof source === 'object' && source.url) {
            allPossibleSources.push(source);
          }
        });
      }
      
      // Special case: check for references/citations section
      if (obj.references && Array.isArray(obj.references)) {
        obj.references.forEach(ref => {
          if (ref && typeof ref === 'object' && ref.url) {
            allPossibleSources.push(ref);
          }
        });
      }
      
      // Recursively search nested objects but not arrays
      Object.keys(obj).forEach(key => {
        if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
          extractSourcesFromObject(obj[key]);
        }
      });
    };
    
    // First check direct source arrays
    if (results && results.sources && Array.isArray(results.sources)) {
      debugLog('Found sources array at top level');
      allPossibleSources = [...results.sources.filter(s => s && s.url)];
    }
    
    // Extract sources from raw results
    if (Array.isArray(results)) {
      debugLog('Searching array results for sources');
      results.forEach(result => {
        // Direct source objects
        if (result && typeof result === 'object' && result.url && !result.isLLMResults) {
          allPossibleSources.push(result);
        }
        
        // Recursively search in objects
        if (result && typeof result === 'object') {
          extractSourcesFromObject(result);
        }
      });
    } else if (results && typeof results === 'object') {
      // Single result object - search recursively
      debugLog('Searching single result object for sources');
      extractSourcesFromObject(results);
    }
    
    // Also check validResults
    if (validResults && validResults.length > 0) {
      debugLog('Searching validResults for sources');
      validResults.forEach(result => {
        if (result && typeof result === 'object') {
          if (result.url && !result.isLLMResults) {
            allPossibleSources.push(result);
          }
          extractSourcesFromObject(result);
        }
      });
    }
    

  return allPossibleSources.filter((source) => source.url && source.url !== '#' || source.source === 'file');
};

const CLAIM_STYLE = {
  corroborated: { label: 'Corroborated', color: '#0F9D58', background: '#E6F4EA' },
  'single-source': { label: 'Single source', color: '#B06000', background: '#FEF7E0' },
  conflict: { label: 'Sources disagree', color: '#DB4437', background: '#FCE8E6' },
};

const SimplifiedLLMResults = ({ 
  results = [],
  query = '',
  onFollowUpSearch = null,
  onSaveSource = null
}) => {
  const [savedUrls, setSavedUrls] = useState({});
  const [showLowerSources, setShowLowerSources] = useState(false);
  const claimCheck = results && !Array.isArray(results) ? results.claimCheck : null;
  const queryPlan = results && !Array.isArray(results) ? results.queryPlan : null;
  const handleSave = async (source) => {
    if (!onSaveSource) return;
    setSavedUrls((prev) => ({ ...prev, [source.url]: 'saving' }));
    const ok = await onSaveSource(source).catch(() => false);
    setSavedUrls((prev) => ({ ...prev, [source.url]: ok ? 'saved' : 'error' }));
  };
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
    if (!results) return [];
    // Response contract: an answer is a string in `content`; a fail-soft
    // or error payload has none and shows as "no results", never as JSON.
    if (!Array.isArray(results) && typeof results === 'object' && typeof results.content !== 'string' && typeof results.text !== 'string' && !results.llmResults) {
      return [];
    }
    
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
      
      // If content doesn't exist but text does, use text as content
      if (!results.content && results.text) {
        results.content = results.text;
      }
      
      // Ensure proper flags
      results.isLLMResult = true;
      results.__isImmutableLLMResult = true;
      return sanitizeResults([results]);
    }
    
    // If results is a plain array
    if (Array.isArray(results)) {
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
    
    // Anything else has no readable answer
    return [];
  }, [results]);

  // Score every real source once with the project's scoring engine
  // (MetricsCalculator via SearchResultScorer). Drives both Top Sources and
  // the Quality Assessment bars, so the numbers shown are always computed.
  const scoredSources = useMemo(() => {
    const sources = collectSources(results, validResults);
    if (sources.length === 0) return [];
    const queryContext = detectQueryContext(query);
    const scored = searchResultScorer.scoreResults(sources, query, {
      recalculateMetrics: true,
      context: queryContext,
      sourceType: 'llm'
    });
    const enhanced = scored
      .filter((result) => result.metrics)
      .map((result, index) => {
        const { relevance, accuracy, credibility, overall } = result.metrics;
        let reputation = null;
        let badge = null;
        try {
          // Only filings, official records and market data are "Verified";
          // curated blogs and feeds are scored like any other site.
          const rep = isVerifiedSource(result)
            ? { score: 95, tier: 'standard', category: 'official' }
            : scoreSourceReputation({ url: result.url, title: result.title });
          reputation = rep?.score ?? rep?.reputation ?? null;
          badge = getSourceBadge(rep);
          if (badge && badge.label === 'Verified Source' && !isVerifiedSource(result)) {
            badge = { ...badge, icon: '✓', label: 'Reputable Source' };
          }
          // Keep the badge consistent with the source tier shown next to it:
          // a "Reputable press" site is never a "Basic Source".
          const tier = result.sourceTier || null;
          if (badge && /Basic/i.test(badge.label)) {
            if (tier === 'press') badge = { ...badge, icon: '✓', label: 'Reputable Source' };
            else if (tier === 'forum') badge = { ...badge, icon: '⚠️', label: 'Community Source' };
            else badge = { ...badge, icon: '•', label: 'Unrated Source' };
          }
        } catch {
          badge = null;
        }
        return {
          ...result,
          url: result.url || '#',
          relevanceScore: relevance,
          accuracyScore: accuracy,
          credibilityScore: credibility,
          combinedScore: overall,
          reputation,
          badge,
          displayTitle: createArticleTitle(result, index),
          displayPublisher: createDescriptiveTitle(result, index)
        };
      });
    const unique = enhanced.filter((item, index, self) => index === self.findIndex((t) => t.url === item.url));
    // Display all available high-quality sources (same threshold as before)
    // Every source that could be measured, best first (scores are measured,
    // so a source with no measurable evidence has no score and is left out)
    return unique.filter((source) => source.combinedScore != null).sort((a, b) => b.combinedScore - a.combinedScore);
  }, [results, validResults, query]);

  // Original display threshold for Top Sources (scores above 60%); the rest
  // stay available under "lower-scoring sources" instead of disappearing.
  const topSources = useMemo(() => scoredSources.filter((s) => s.combinedScore > 0.6), [scoredSources]);
  const lowerSources = useMemo(() => scoredSources.filter((s) => s.combinedScore <= 0.6), [scoredSources]);

  // Aggregate quality = mean of the scored sources (null when nothing scored)
  // Aggregate quality: mean of each metric over the sources where that
  // metric was measured; overall is the mean of the sources' overall scores
  // (each already context-weighted per docs/METRICS_SYSTEM.md).
  const qualityMetrics = useMemo(() => {
    if (scoredSources.length === 0) return null;
    const mean = (key) => {
      const vals = scoredSources.map((src) => src[key]).filter((v) => v != null);
      return vals.length ? { value: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length } : { value: null, n: 0 };
    };
    const relevance = mean('relevanceScore');
    const accuracy = mean('accuracyScore');
    const credibility = mean('credibilityScore');
    const overall = mean('combinedScore');
    const measuredCount = scoredSources.reduce((sum, src) => sum + (src.metrics?.coverage?.measuredComponents || 0), 0);
    const totalCount = scoredSources.reduce((sum, src) => sum + (src.metrics?.coverage?.totalComponents || 0), 0);
    return {
      relevance: relevance.value, accuracy: accuracy.value, credibility: credibility.value, overall: overall.value,
      n: { relevance: relevance.n, accuracy: accuracy.n, credibility: credibility.n, overall: overall.n },
      sources: scoredSources.length,
      componentCoverage: totalCount ? measuredCount / totalCount : 0,
    };
  }, [scoredSources]);

  const METRIC_HELP = {
    relevance: 'Relevance = query match 40%, recency 35%, content quality 15%, domain fit 10%',
    accuracy: 'Accuracy = data verification 30%, source reliability 30%, factual consistency 25%, external validation 15%',
    credibility: 'Credibility = source reputation 40%, author expertise 25%, citation quality 20%, verification factors 15%',
  };
  const aggregateTitle = (metric) => (qualityMetrics
    ? `${METRIC_HELP[metric]}\nMeasured on ${qualityMetrics.n[metric]} of ${qualityMetrics.sources} sources. Components with no evidence are not counted (no default values).`
    : 'No measurable sources');
  // ScoreVisualizer bands: >=80 green, >=60 blue, >=40 amber, else red
  const scoreColor = (v) => (v == null ? '#9CA3AF' : v >= 0.8 ? '#10B981' : v >= 0.6 ? '#3B82F6' : v >= 0.4 ? '#F59E0B' : '#EF4444');
  const sourceTitle = (src) => [
    `Overall ${Math.round(src.combinedScore * 100)}% · ${src.metrics?.coverage?.measuredComponents}/${src.metrics?.coverage?.totalComponents} components measured`,
    '', 'RELEVANCE', describeMetric(src.metrics, 'relevance'),
    '', 'ACCURACY', describeMetric(src.metrics, 'accuracy'),
    '', 'CREDIBILITY', describeMetric(src.metrics, 'credibility'),
  ].join('\n');
  const pct = (value) => (value == null ? null : Math.round(value * 100));

  // Process results to create comprehensive, visually appealing Key Insights
  const keyInsightsContent = useMemo(() => {
    if (validResults.length === 0) return [];
    
    try {
      // Calculate average scores across all sources
      const aggregateScores = {
        relevance: 0,
        accuracy: 0, 
        credibility: 0,
        count: 0
      };
      
      // Extract all content and scores from validResults
      let allContent = '';
      validResults.forEach(result => {
        // Handle different result structures to extract metrics if available
        if (result?.metrics) {
          aggregateScores.relevance += parseFloat(result.metrics.relevance || 0);
          aggregateScores.accuracy += parseFloat(result.metrics.accuracy || 0);
          aggregateScores.credibility += parseFloat(result.metrics.credibility || 0);
          aggregateScores.count++;
        } else if (result?.scores) {
          aggregateScores.relevance += parseFloat(result.scores.relevance || 0);
          aggregateScores.accuracy += parseFloat(result.scores.accuracy || 0);
          aggregateScores.credibility += parseFloat(result.scores.credibility || 0);
          aggregateScores.count++;
        } else if (result?.score) {
          // If there's just a general score, use it for all metrics
          const score = parseFloat(result.score || 0);
          aggregateScores.relevance += score;
          aggregateScores.accuracy += score;
          aggregateScores.credibility += score;
          aggregateScores.count++;
        } else if (typeof result === 'object') {
          // Look for any properties that might contain scores
          Object.keys(result).forEach(key => {
            if (typeof result[key] === 'number' && key.match(/score|quality|relevance|accuracy|credibility/i)) {
              const value = parseFloat(result[key] || 0);
              if (key.match(/relevance/i)) aggregateScores.relevance += value;
              else if (key.match(/accuracy/i)) aggregateScores.accuracy += value;
              else if (key.match(/credibility/i)) aggregateScores.credibility += value;
              else {
                // Generic score, apply to all metrics
                aggregateScores.relevance += value;
                aggregateScores.accuracy += value;
                aggregateScores.credibility += value;
              }
              if (!aggregateScores.count) aggregateScores.count = 1;
            }
          });
        }
        
        
        // Extract content
        const resultContent = typeof result === 'string' ? result
          : [result.content, result.text, result.summary].find((v) => typeof v === 'string') || '';
        allContent += resultContent + '\n';
      });
      
      // Calculate averages - ensure values are between 0 and 1
      const avgScores = {
        relevance: aggregateScores.count ? 
          Math.min(Math.max(aggregateScores.relevance / aggregateScores.count, 0), 1) : 0.75,
        accuracy: aggregateScores.count ? 
          Math.min(Math.max(aggregateScores.accuracy / aggregateScores.count, 0), 1) : 0.8,
        credibility: aggregateScores.count ? 
          Math.min(Math.max(aggregateScores.credibility / aggregateScores.count, 0), 1) : 0.85
      };
      
      // Not using text-based quality metrics anymore - quality metrics are now shown only in the progress bar visualization
      
      // The header follows what the query asked for (the API's query plan),
      // not substrings of the query ("ai" inside "open ai" is not "technical")
      const intents = Array.isArray(queryPlan?.intents) ? queryPlan.intents : [];
      const isFinancialQuery = intents.includes('funding') || intents.includes('financials');
      const isTechnicalQuery = intents.includes('product');
      const isHealthQuery = /\b(health|medical|doctor|patient|disease|treatment|symptom|therapy|wellness)\b/i.test(query);
      
      // Format content for dashboard appearance
      let formattedHTML = '';
      
      // Create a summary section with appropriate styling
      formattedHTML += `<div class="insight-summary">`;
      
      // Add appropriate header based on context
      if (isFinancialQuery) {
        formattedHTML += `<h2>📈 Financial Analysis</h2>`;
      } else if (intents.includes('competitors')) {
        formattedHTML += `<h2>🏁 Competitive Landscape</h2>`;
      } else if (intents.includes('team')) {
        formattedHTML += `<h2>👥 Team and Leadership</h2>`;
      } else if (intents.includes('legal')) {
        formattedHTML += `<h2>⚖️ Legal and Regulatory</h2>`;
      } else if (isTechnicalQuery) {
        formattedHTML += `<h2>🔧 Product Overview</h2>`;
      } else if (isHealthQuery) {
        formattedHTML += `<h2>🧪 Health Assessment</h2>`;
      } else {
        formattedHTML += `<h2>🔍 Key Insights</h2>`;
      }
      
      // Extract and clean sentences for insights
      // Strip markdown so sentences read cleanly: headings, bullets,
      // emphasis, and [title](url) links (keep the title).
      const plainContent = allContent
        .replace(/\\n/g, '\n')
        .replace(/^#{1,6}\s.*$/gm, ' ')
        .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
        .replace(/^\s*(?:[-•*]|\d+\.)\s+/gm, '')
        .replace(/[*_`]+/g, '');
      // Split on line breaks and on sentence ends followed by a capital or a
      // bullet, so "$1.25 trillion" and "Inc." never split a sentence
      const sentences = plainContent.split(/\n+|(?<=[.!?])\s+(?=[\p{Lu}•]|\d)/u);
      const cleanedSentences = sentences
        .map(s => s.trim())
        .filter(s => s.length > 25 && s.length < 500) // Filter out very short or very long sentences
        .filter(s => !/^Based on \d+ sources?\b/i.test(s)) // coverage line, not an insight
        .filter(s => !/^(\*?Note:|Results synthesized from \d+ sources|---)/i.test(s)) // digest footer
        .filter(s => !/verify (claims )?(with|in) (the )?original sources|so every statement above is quoted|contain no further detail|Only one kind of source covers|Add sources \(Web, Verified/i.test(s))
        .filter(s => !/\?\s*$/.test(s)) // questions belong to FOLLOW-UP, not insights
        // Drop perspective labels ("Company Announcements: ...") before comparing
        .map(s => s.replace(/^(Company Announcements|Investor View|Press Coverage|Analyst Commentary|Community Discussion|Your Documents):\s*/, ''))
        // Remove duplicates by core sentence (ignore citations, dates and end punctuation)
        .filter((s, i, arr) => {
          const core = (x) => x.replace(/\s*\([^)]*\)\s*(\[Source[^\]]*\])?[.!?]*\s*$/, '').replace(/[.!?]+$/, '').trim().toLowerCase();
          return arr.findIndex(t => core(t) === core(s)) === i;
        });
      
      // Sentences with figures or funding facts first (stable order otherwise)
      const isFactual = (s) => /[$€£]\s?\d|\d+(\.\d+)?\s?(%|million|billion|[MBK]\b)|\b(raised|funding|series [a-e]|seed|valuation|led by|ARR|revenue)\b/i.test(s);
      const keyPoints = [...cleanedSentences.filter(isFactual), ...cleanedSentences.filter(s => !isFactual(s))].slice(0, 12);
      
      // Create an attractive bullet point list of key insights
      formattedHTML += `<ul class="key-points">`;
      keyPoints.slice(0, 5).forEach(point => {
        formattedHTML += `<li>${highlightNumbers(point.trim())}</li>`;
      });
      formattedHTML += `</ul>`;
      
      // No longer displaying quality metrics in the text content area
      
      // Add detailed analysis section if we have more points
      if (keyPoints.length > 5) {
        formattedHTML += `<h3>Additional Context</h3><p class="detailed-analysis">`;
        keyPoints.slice(5).forEach(point => {
          formattedHTML += highlightNumbers(point.trim()) + ' ';
        });
        formattedHTML += `</p>`;
      }
      
      // Add context-specific visualizations
      if (isFinancialQuery) {
        // Financial dashboard components
        formattedHTML += `
          <h3>Financial Indicators</h3>
          <div class="financial-indicators">
            <div class="indicator">
              <div class="indicator-icon growth">📈</div>
              <div class="indicator-label">Growth Potential</div>
            </div>
            <div class="indicator">
              <div class="indicator-icon market">🌐</div>
              <div class="indicator-label">Market Presence</div>
            </div>
            <div class="indicator">
              <div class="indicator-icon risk">⚖️</div>
              <div class="indicator-label">Risk Assessment</div>
            </div>
          </div>
        `;
      } else if (isTechnicalQuery) {
        // Technical overview - no header needed as it's handled by the TabNavigation component
        formattedHTML += `
          <div class="business-focused-content">
          </div>
        `;
      } else if (isHealthQuery) {
        // Health dashboard components
        formattedHTML += `
          <h3>Health Indicators</h3>
          <div class="tech-stack">
            <div class="stack-component">
              <div class="stack-icon">🩺</div>
              <div class="stack-label">Diagnosis</div>
            </div>
            <div class="stack-component">
              <div class="stack-icon">💊</div>
              <div class="stack-label">Treatment</div>
            </div>
            <div class="stack-component">
              <div class="stack-icon">🧠</div>
              <div class="stack-label">Wellness</div>
            </div>
          </div>
        `;
      }
      
      formattedHTML += `</div>`; // Close insight-summary div
      
      return [formattedHTML];
    } catch (e) {
      console.error('Error creating key insights:', e);
      console.error(e.stack);
      // Return a minimal dashboard with error info
      return [`
        <div class="insight-summary">
          <h2>🔍 Key Insights</h2>
          <p class="detailed-analysis">Unable to generate insights for this query. Please try a different search term.</p>
        </div>
      `];
    }
  }, [validResults, query, queryPlan]);

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
                  typeof result.text === 'string' ? result.text : ''
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

  // Create the Key Insights tab - make sure it's always populated
  const keyInsightsTab = {
    id: 'key-insights',
    label: 'Key Insights',
    content: (
      <div className={styles.tabContentContainer}>
        {keyInsightsContent && keyInsightsContent.length > 0 ? (
          <div className={styles.keyInsightsContainer}>
            <div className={styles.responsiveLayout}>
              {/* Right column with metrics - Always at the top */}
              <div className={styles.metricsColumn}>
                <div className={styles.metricsCard}>
                  <h3>Quality Assessment</h3>
                  <div className={styles.metricItem} title={aggregateTitle('relevance')}>
                    <div className={styles.metricLabel}>Relevance</div>
                    <div className={styles.metricBarContainer}>
                      <div className={styles.metricBar} style={{width: `${pct(qualityMetrics?.relevance) ?? 0}%`, backgroundColor: scoreColor(qualityMetrics?.relevance)}}></div>
                    </div>
                    <div className={styles.metricValue}>{qualityMetrics ? `${pct(qualityMetrics.relevance)}%` : 'N/A'}</div>
                  </div>
                  <div className={styles.metricItem} title={aggregateTitle('accuracy')}>
                    <div className={styles.metricLabel}>Accuracy</div>
                    <div className={styles.metricBarContainer}>
                      <div className={styles.metricBar} style={{width: `${pct(qualityMetrics?.accuracy) ?? 0}%`, backgroundColor: scoreColor(qualityMetrics?.accuracy)}}></div>
                    </div>
                    <div className={styles.metricValue}>{qualityMetrics ? `${pct(qualityMetrics.accuracy)}%` : 'N/A'}</div>
                  </div>
                  <div className={styles.metricItem} title={aggregateTitle('credibility')}>
                    <div className={styles.metricLabel}>Credibility</div>
                    <div className={styles.metricBarContainer}>
                      <div className={styles.metricBar} style={{width: `${pct(qualityMetrics?.credibility) ?? 0}%`, backgroundColor: scoreColor(qualityMetrics?.credibility)}}></div>
                    </div>
                    <div className={styles.metricValue}>{qualityMetrics ? `${pct(qualityMetrics.credibility)}%` : 'N/A'}</div>
                  </div>
                  <div className={styles.overallMetric} title={qualityMetrics ? `Overall = context-weighted average of relevance, accuracy and credibility per source (weights from docs/METRICS_SYSTEM.md), averaged over ${qualityMetrics.n.overall} measured sources.` : 'No measurable sources'}>
                    <div className={styles.overallLabel}>Overall</div>
                    <div className={styles.overallScore}>
                      {qualityMetrics ? `${pct(qualityMetrics.overall)}%` : 'N/A'}
                    </div>
                  </div>
                </div>
                
                {/* Claim check: do independent sources agree on the figures? */}
                {claimCheck && claimCheck.claims && claimCheck.claims.length > 0 && (
                  <div className={styles.sourcesCard}>
                    <h3>Claim Check</h3>
                    <div className={styles.sourcesList}>
                      {claimCheck.claims.slice(0, 6).map((claim, index) => {
                        const st = CLAIM_STYLE[claim.status] || CLAIM_STYLE['single-source'];
                        return (
                          <div key={`claim-${index}`} className={styles.sourceItem} style={{ display: 'block' }} title={claim.quote}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                              <span>{claim.label}: <strong style={{ color: '#0066cc' }}>{claim.value}</strong></span>
                              <span style={{ fontSize: 11, color: st.color, backgroundColor: st.background, padding: '1px 6px', borderRadius: 10, whiteSpace: 'nowrap' }}>{st.label}</span>
                            </div>
                            <div style={{ fontSize: 11, color: '#6b7280' }}>
                              {(claim.sourceRefs || []).map((ref) => ref.site).join(', ')}
                              {(claim.alternatives || []).slice(0, 3).map((alt) => ` · ${alt.speculative ? 'reported target' : alt.prior ? 'earlier' : claim.status === 'conflict' && alt.sameRound !== false ? 'vs' : 'also reported'} ${alt.value}${alt.when ? ` (${alt.when})` : ''} (${(alt.sourceRefs || []).map((r) => r.site).join(', ')})`).join('')}{(claim.alternatives || []).length > 3 ? ` · +${claim.alternatives.length - 3} more` : ''}
                              {claim.note ? ` · ${claim.note}` : ''}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Top Performing Sources Section */}
                <div className={styles.sourcesCard}>
                  <h3>Top Sources</h3>
                  <div className={styles.sourcesList}>
                    {/* Extract and sort sources by score */}
                    {scoredSources.length > 0 ? (
                      [...topSources, ...lowerSources].map((result, index) => {
                        const score = Math.round(result.combinedScore * 100);
                        const isLower = index >= topSources.length;
                        if (isLower && !showLowerSources) return null;
                        return (
                          <div key={`source-${index}`} className={styles.sourceItem} style={isLower ? { opacity: 0.75 } : undefined}>
                            <a href={result.url} target="_blank" rel="noopener noreferrer" className={styles.sourceLink} title={result.title || result.displayTitle}>
                              {result.displayTitle}
                            </a>
                            {result.displayPublisher && result.displayPublisher !== result.displayTitle && (
                              <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 6, whiteSpace: 'nowrap' }}>{result.displayPublisher}</span>
                            )}
                            {result.undated && (
                              <span title="This source has no publication date, so the date filter could not be applied to it" style={{ fontSize: 11, color: '#92400e', backgroundColor: '#FEF3C7', padding: '1px 6px', borderRadius: 10, marginLeft: 6, whiteSpace: 'nowrap' }}>undated</span>
                            )}
                            {result.badge && (
                              <span
                                title={`${result.badge.label}${result.reputation ? ` (reputation ${result.reputation}/100)` : ''}`}
                                style={{ color: result.badge.color, backgroundColor: result.badge.background || result.badge.backgroundColor, fontSize: 11, padding: '1px 6px', borderRadius: 10, marginLeft: 6, whiteSpace: 'nowrap' }}
                              >
                                {result.badge.icon} {result.badge.label}
                              </span>
                            )}
                            {result.sourceTierLabel && (
                              <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 6, whiteSpace: 'nowrap' }}>{result.sourceTierLabel}</span>
                            )}
                            <span className={styles.sourceScore} title={sourceTitle(result)} style={{ color: scoreColor(result.combinedScore), cursor: 'help' }}>{score}%</span>
                            {onSaveSource && result.url && result.url !== '#' && (
                              <button
                                type="button"
                                onClick={() => handleSave(result)}
                                disabled={savedUrls[result.url] === 'saving' || savedUrls[result.url] === 'saved'}
                                title="Save this source to the selected workspace"
                                style={{ fontSize: 11, marginLeft: 6, color: savedUrls[result.url] === 'error' ? '#DB4437' : '#2563eb', background: 'none', border: 'none', cursor: 'pointer' }}
                              >
                                {savedUrls[result.url] === 'saved' ? '✓ Saved' : savedUrls[result.url] === 'error' ? 'Retry' : savedUrls[result.url] === 'saving' ? '…' : '+ Save'}
                              </button>
                            )}
                          </div>
                        );
                      })
                    ) : (
                      // No placeholders - only show real sources
                      <div className={styles.noSourcesMessage}>
                        No sources available for this search.
                      </div>
                    )}
                    {lowerSources.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowLowerSources((v) => !v)}
                        style={{ fontSize: 12, color: '#2563eb', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0' }}
                      >
                        {showLowerSources ? 'Hide' : 'Show'} {lowerSources.length} lower-scoring source{lowerSources.length === 1 ? '' : 's'} (60% or below)
                      </button>
                    )}
                    {qualityMetrics && (
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                        Scores are measured from each source's evidence ({Math.round(qualityMetrics.componentCoverage * 100)}% of scoring components had evidence). Hover a score for the breakdown.
                      </div>
                    )}
                  </div>
                </div>
              </div>
              
              {/* Main content area - Flexible based on content */}
              <div className={styles.mainInsightColumn}>
                {!Array.isArray(keyInsightsContent) ? (
                  <div className={styles.insightContainer}>
                    <div 
                      className={styles.formattedKeyInsights} 
                      dangerouslySetInnerHTML={{ __html: renderSafeHtml(keyInsightsContent) }} 
                    />
                  </div>
                ) : (
                  <div className={styles.multiInsightContainer}>
                    {keyInsightsContent.map((item, index) => {
                      // Determine layout pattern based on content length and position
                      const insightClass = index === 0 ? styles.primaryInsight : 
                                           (index % 3 === 0) ? styles.fullWidthInsight : styles.standardInsight;
                      return (
                        <div key={`insight-${index}`} className={`${styles.insightItem} ${insightClass}`}>
                          <div 
                            className={styles.formattedKeyInsights} 
                            dangerouslySetInnerHTML={{ __html: renderSafeHtml(item) }} 
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className={styles.keyInsightsContainer}>
            <div className={styles.responsiveLayout}>
              {/* Right column with metrics - Always at the top */}
              <div className={styles.metricsColumn}>
                <div className={styles.metricsCard}>
                  <h3>Quality Assessment</h3>
                  <div className={styles.metricItem}>
                    <div className={styles.metricLabel}>Relevance</div>
                    <div className={styles.metricBarContainer}>
                      <div className={styles.metricBar} style={{width: '0%'}}></div>
                    </div>
                    <div className={styles.metricValue}>N/A</div>
                  </div>
                  <div className={styles.metricItem}>
                    <div className={styles.metricLabel}>Accuracy</div>
                    <div className={styles.metricBarContainer}>
                      <div className={styles.metricBar} style={{width: '0%'}}></div>
                    </div>
                    <div className={styles.metricValue}>N/A</div>
                  </div>
                  <div className={styles.metricItem}>
                    <div className={styles.metricLabel}>Credibility</div>
                    <div className={styles.metricBarContainer}>
                      <div className={styles.metricBar} style={{width: '0%'}}></div>
                    </div>
                    <div className={styles.metricValue}>N/A</div>
                  </div>
                  <div className={styles.overallMetric}>
                    <div className={styles.overallLabel}>Overall</div>
                    <div className={styles.overallScore}>N/A</div>
                  </div>
                </div>
              </div>
              
              {/* Main content area */}
              <div className={styles.mainInsightColumn}>
                <div className={styles.placeholderInsight}>
                  <h2><span className={styles.insightIcon}>🔍</span> Key Insights</h2>
                  <p className={styles.analysisMessage}>
                    Analyzing search results to generate insights...
                  </p>
                  <div className={styles.insightLoading}>
                    <div className={styles.loadingBar}></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
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
          {scoredSources.length > 0
            ? `${scoredSources.length} source${scoredSources.length === 1 ? '' : 's'}`
            : `${validResults?.length || 0} result${validResults?.length === 1 ? '' : 's'}`}
        </div>
      </div>
      
      {/* Alert box for API errors if detected */}
      {hasErrorResults && validResults.length === 0 && (
        <div className={styles.errorAlert}>
          <h4 className={styles.errorTitle}>API Error</h4>
          <p className={styles.errorMessage}>
            The search service returned an error and no answer could be shown.
            Please try again; if it keeps failing, check the server logs and provider configuration.
          </p>
        </div>
      )}
      {hasAuthError && validResults.length > 0 && (
        <div className={styles.errorAlert}>
          <h4 className={styles.errorTitle}>Provider Warning</h4>
          <p className={styles.errorMessage}>
            The AI provider rejected the request. Showing the available search results with a quoted digest instead.
          </p>
        </div>
      )}

      {/* Tab Navigation - moved outside of scrollable area */}
      <TabNavigation 
        tabs={tabsToShow} 
        defaultTabId="all-results"
        onTabChange={null}
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
