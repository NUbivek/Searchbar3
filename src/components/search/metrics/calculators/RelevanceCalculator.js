/**
 * RelevanceCalculator.js
 * Calculates the relevance score for search results based on query match, recency, and content quality.
 * Enhanced with domain-specific boosting, personalization, and improved topic detection.
 */

import { 
  containsNumbers, 
  containsDates, 
  containsSpecificDetails, 
  containsPreciseData,
  matchesDomain,
  normalizeScore
} from '../../utils/calculatorUtils';

import {
  DISPLAY_THRESHOLD,
  TOPIC_CATEGORIES
} from '../../utils/calculatorData';

// Define domain specific sources since they're not in calculatorData
const DOMAIN_SPECIFIC_SOURCES = {
  'finance': ['bloomberg.com', 'wsj.com', 'ft.com', 'cnbc.com', 'reuters.com'],
  'tech': ['techcrunch.com', 'wired.com', 'theverge.com', 'cnet.com', 'arstechnica.com'],
  'business': ['hbr.org', 'forbes.com', 'inc.com', 'entrepreneur.com', 'businessinsider.com']
};

// Define recency score calculation function
const calculateRecencyScore = (date) => {
  if (!date) return 0.5; // Default score if no date
  
  const now = new Date();
  const pubDate = new Date(date);
  const diffInDays = Math.floor((now - pubDate) / (1000 * 60 * 60 * 24));
  
  if (diffInDays < 7) return 1.0;       // Within a week
  if (diffInDays < 30) return 0.9;      // Within a month
  if (diffInDays < 90) return 0.8;      // Within 3 months
  if (diffInDays < 180) return 0.7;     // Within 6 months
  if (diffInDays < 365) return 0.6;     // Within a year
  if (diffInDays < 730) return 0.4;     // Within 2 years
  if (diffInDays < 1095) return 0.3;    // Within 3 years
  return 0.2;                           // Older than 3 years
};

// Constants for weighting different factors
const WEIGHTS = {
  QUERY_MATCH: 0.40,
  RECENCY: 0.35,    // Increased weight for recency
  CONTENT_QUALITY: 0.15,
  DOMAIN_RELEVANCE: 0.10, // New factor for domain-specific relevance
};

// Minimum threshold for relevance score (40%)
const RELEVANCE_THRESHOLD = 0.4; // Lowered from previous value

/**
 * Calculate the relevance score for a search result
 * @param {Object} result - The search result object
 * @param {string} query - The search query
 * @param {Object} options - Additional options for personalization
 * @returns {number} - Relevance score (0-100)
 */
const calculateRelevanceScore = (result, query, options = {}) => {
  if (!result) return 0;
  
  // Ensure query is a string
  const normalizedQuery = typeof query === 'string' ? query : String(query || '');
  
  // Special handling for generic queries (short, common terms)
  const isGenericQuery = normalizedQuery.length < 5 || 
                         ['ai', 'ml', 'tech', 'news', 'data', 'web', 'app', 'cloud']
                         .includes(normalizedQuery.toLowerCase());
  
  // Calculate query match score
  const queryMatchScore = calculateQueryMatchScore(result, normalizedQuery);
  
  // Calculate recency score
  const recencyScore = calculateRecencyScore(result.date);
  
  // Calculate content quality score
  const contentQualityScore = calculateContentQualityScore(result, normalizedQuery);
  
  // Calculate domain relevance score
  const domainRelevanceScore = calculateDomainRelevanceScore(result, normalizedQuery, options);
  
  // For generic queries, boost the base score
  const genericQueryBoost = isGenericQuery ? 0.15 : 0;
  
  // Calculate weighted score
  let weightedScore = 
    (queryMatchScore * WEIGHTS.QUERY_MATCH) +
    (recencyScore * WEIGHTS.RECENCY) +
    (contentQualityScore * WEIGHTS.CONTENT_QUALITY) +
    (domainRelevanceScore * WEIGHTS.DOMAIN_RELEVANCE) +
    genericQueryBoost;
  
  // Ensure score doesn't exceed 1.0
  weightedScore = Math.min(weightedScore, 1.0);
  
  // Apply personalization boost if applicable
  const personalizedScore = applyPersonalizationBoost(weightedScore, result, options);
  
  // 0-1 scale (callers such as MetricsCalculator and CategoryFinder expect
  // 0-1; normalizeScore clamps to 0-1, so passing score*100 made every
  // non-zero score 1.0)
  return normalizeScore(personalizedScore);
};

/**
 * Calculate how well the result matches the query
 * @param {Object} result - The search result
 * @param {string} query - The search query
 * @returns {number} - Score between 0-1
 */
const calculateQueryMatchScore = (result, query) => {
  // Ensure query is a string
  const normalizedQuery = typeof query === 'string' ? query.toLowerCase().trim() : String(query || '').toLowerCase().trim();
  const queryTerms = normalizedQuery.split(/\s+/);
  
  // Check title match
  const titleMatch = result.title ? 
    queryTerms.filter(term => {
      const title = typeof result.title === 'string' ? result.title.toLowerCase() : String(result.title || '').toLowerCase();
      return title.includes(term);
    }).length / queryTerms.length : 0;
  
  // Check content match
  const contentMatch = result.content ? 
    queryTerms.filter(term => {
      const content = typeof result.content === 'string' ? result.content.toLowerCase() : String(result.content || '').toLowerCase();
      return content.includes(term);
    }).length / queryTerms.length : 0;
  
  // Check exact phrase match (higher weight)
  const exactPhraseMatch = result.content ? 
    (typeof result.content === 'string' ? result.content.toLowerCase() : String(result.content || '').toLowerCase()).includes(normalizedQuery) ? 1 : 0 : 0;
  
  // Check topic relevance - if the query and content are in the same topic category
  const topicRelevance = calculateTopicRelevance(normalizedQuery, result);
  
  // Check source-topic alignment - if the source specializes in the query topic
  const sourceTopicAlignment = calculateSourceTopicAlignment(normalizedQuery, result.source, result.sourceType);
  
  // Enhanced: Check for semantic similarity using key phrases
  const semanticSimilarity = result.keyPhrases && queryTerms.length > 0 ? 
    calculateSemanticSimilarity(queryTerms, result.keyPhrases) : 0;
  
  // Weighted combination
  return (titleMatch * 0.20) + 
         (contentMatch * 0.20) + 
         (exactPhraseMatch * 0.15) + 
         (topicRelevance * 0.15) + 
         (sourceTopicAlignment * 0.15) +
         (semanticSimilarity * 0.15);
};

/**
 * Calculate semantic similarity between query terms and key phrases
 * @param {Array} queryTerms - Array of query terms
 * @param {Array} keyPhrases - Array of key phrases from the content
 * @returns {number} - Score between 0-1
 */
const calculateSemanticSimilarity = (queryTerms, keyPhrases) => {
  if (!queryTerms || !keyPhrases || queryTerms.length === 0 || keyPhrases.length === 0) {
    return 0;
  }
  
  // Count how many query terms appear in key phrases
  let matchCount = 0;
  
  for (const term of queryTerms) {
    for (const phrase of keyPhrases) {
      if (phrase.toLowerCase().includes(term)) {
        matchCount++;
        break; // Count each query term only once
      }
    }
  }
  
  return matchCount / queryTerms.length;
};

/**
 * Calculate topic relevance between query and content
 * @param {string} query - The search query
 * @param {Object} result - The search result
 * @returns {number} - Score between 0-1
 */
const calculateTopicRelevance = (query, result) => {
  if (!query || !result.content) {
    return 0.5; // Neutral score if missing data
  }
  
  const queryLower = query.toLowerCase();
  const contentLower = result.content.toLowerCase();
  
  // Check if query and content share topic categories
  let maxTopicScore = 0;
  
  for (const [topic, keywords] of Object.entries(TOPIC_CATEGORIES)) {
    // Check if query is related to this topic
    const queryTopicScore = keywords.some(keyword => queryLower.includes(keyword)) ? 1 : 0;
    
    if (queryTopicScore > 0) {
      // Check how many topic keywords appear in content
      let contentKeywordCount = 0;
      const keywords = TOPIC_CATEGORIES[topic];
      
      for (const keyword of keywords) {
        if (contentLower.includes(keyword)) {
          contentKeywordCount++;
        }
      }
      
      // Calculate content topic score based on keyword density
      const contentTopicScore = Math.min(contentKeywordCount / 5, 1); // Cap at 5 keywords
      
      // Combined score for this topic
      const topicScore = (queryTopicScore * 0.5) + (contentTopicScore * 0.5);
      
      // Keep track of highest topic score
      if (topicScore > maxTopicScore) {
        maxTopicScore = topicScore;
      }
    }
  }
  
  return maxTopicScore > 0 ? maxTopicScore : 0.5; // Default to neutral if no topic match
};

/**
 * Calculate source-topic alignment
 * @param {string} query - The search query
 * @param {string} source - The source of the result
 * @param {string} sourceType - The type of source
 * @returns {number} - Score between 0-1
 */
const calculateSourceTopicAlignment = (query, source, sourceType) => {
  // Ensure query is a string
  const normalizedQuery = typeof query === 'string' ? query.toLowerCase() : String(query || '').toLowerCase();
  
  // Ensure source is a string
  const normalizedSource = typeof source === 'string' ? source.toLowerCase() : String(source || '').toLowerCase();
  
  // Default score
  let score = 0.5;
  
  // Check if source is domain-specific for the query topic
  for (const [domain, sources] of Object.entries(DOMAIN_SPECIFIC_SOURCES)) {
    // Check if query is related to this domain
    if (TOPIC_CATEGORIES[domain] && 
        TOPIC_CATEGORIES[domain].some(keyword => normalizedQuery.includes(keyword))) {
      
      // Check if source is specialized in this domain
      if (sources.some(domainSource => normalizedSource.includes(domainSource))) {
        score += 0.3;
        break;
      }
    }
  }
  
  // Check if source type matches query intent
  if (sourceType) {
    // Ensure sourceType is a string
    const normalizedSourceType = typeof sourceType === 'string' ? sourceType.toLowerCase() : String(sourceType || '').toLowerCase();
    
    // News sources for current events
    if ((normalizedQuery.includes('latest') || 
         normalizedQuery.includes('news') || 
         normalizedQuery.includes('recent') || 
         normalizedQuery.includes('update')) && 
        (normalizedSourceType.includes('news') || normalizedSourceType.includes('media'))) {
      score += 0.2;
    }
    
    // Academic sources for research topics
    if ((normalizedQuery.includes('research') || 
         normalizedQuery.includes('study') || 
         normalizedQuery.includes('analysis') || 
         normalizedQuery.includes('paper')) && 
        (normalizedSourceType.includes('academic') || normalizedSourceType.includes('journal') || normalizedSourceType.includes('research'))) {
      score += 0.2;
    }
  }
  
  // Normalize score to 0-1 range
  return Math.min(Math.max(score, 0), 1);
};

/**
 * Calculate content quality score based on various factors
 * @param {Object} result - The search result
 * @param {string} query - The search query
 * @returns {number} - Score between 0-1
 */
const calculateContentQualityScore = (result, query) => {
  let score = 0.5; // Start with a neutral score
  
  // Factor 1: Contains specific details
  if (result.content) {
    if (containsSpecificDetails(result.content)) {
      score += 0.1;
    }
  }
  
  // Factor 2: Contains precise data
  if (result.content) {
    if (containsPreciseData(result.content)) {
      score += 0.1;
    }
  }
  
  // Factor 3: Has structured data
  if (result.hasStructuredData) {
    score += 0.1;
  }
  
  // Factor 4: Contains query-relevant data types
  if (query && result.content) {
    const queryLower = query.toLowerCase();
    const contentLower = result.content.toLowerCase();
    
    // Check for financial data in financial queries
    if (TOPIC_CATEGORIES.FINANCE.some(term => queryLower.includes(term))) {
      // Check for financial data patterns (numbers, percentages, ratios)
      if (/\$\d+|\d+%|\d+\.\d+x|\d+\s*\/\s*\d+/.test(contentLower)) {
        score += 0.1;
      }
    }
    
    // Check for dates/timeline in historical queries
    if (queryLower.includes('history') || queryLower.includes('timeline') || 
        queryLower.includes('trend') || queryLower.includes('over time')) {
      // Check for date patterns
      if (/\b(19|20)\d{2}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2},? \d{4}\b/i.test(contentLower)) {
        score += 0.1;
      }
    }
  }
  
  // Factor 5: Contains images or multimedia
  if (result.hasImages || result.hasMultimedia) {
    score += 0.05;
  }
  
  // Cap at 1.0
  return Math.min(score, 1.0);
};

/**
 * Calculate domain-specific relevance score
 * @param {Object} result - The search result
 * @param {string} query - The search query
 * @param {Object} options - Additional options
 * @returns {number} - Score between 0-1
 */
const calculateDomainRelevanceScore = (result, query, options = {}) => {
  if (!result.source) return 0.5;
  
  const sourceLower = typeof result.source === 'string' ? result.source.toLowerCase() : String(result.source).toLowerCase();
  const normalizedQuery = typeof query === 'string' ? query.toLowerCase() : String(query || '').toLowerCase();
  
  // Determine query topics
  const queryTopics = [];
  for (const [topic, keywords] of Object.entries(TOPIC_CATEGORIES)) {
    if (keywords.some(keyword => normalizedQuery.includes(keyword))) {
      queryTopics.push(topic);
    }
  }
  
  // If no specific topics detected, return neutral score
  if (queryTopics.length === 0) return 0.6;
  
  // Check if source is a domain-specific high-value source for any of the detected topics
  let domainScore = 0.5;
  
  for (const topic of queryTopics) {
    const domainSources = DOMAIN_SPECIFIC_SOURCES[topic] || [];
    if (domainSources.some(domain => sourceLower.includes(domain))) {
      domainScore = 0.9; // High score for domain-specific sources
      break;
    }
  }
  
  // Boost for specialized industry sources
  if (result.sourceType === 'industry_publication' || 
      result.sourceType === 'research_institution' ||
      result.sourceType === 'government') {
    domainScore += 0.1;
  }
  
  return Math.min(domainScore, 1.0);
};

/**
 * Apply personalization boost based on user preferences
 * @param {number} score - Base score
 * @param {Object} result - The search result
 * @param {Object} options - Personalization options
 * @returns {number} - Adjusted score
 */
const applyPersonalizationBoost = (score, result, options = {}) => {
  if (!options.userPreferences) return score;
  
  let boostFactor = 1.0;
  const { preferredSources, preferredTopics, preferredAuthors } = options.userPreferences;
  
  // Boost for preferred sources
  if (preferredSources && result.source) {
    const sourceLower = typeof result.source === 'string' ? result.source.toLowerCase() : String(result.source).toLowerCase();
    if (preferredSources.some(source => sourceLower.includes(source.toLowerCase()))) {
      boostFactor += 0.05;
    }
  }
  
  // Boost for preferred topics
  if (preferredTopics && result.topics) {
    const resultTopics = Array.isArray(result.topics) ? result.topics : [result.topics];
    const hasPreferredTopic = resultTopics.some(topic => 
      preferredTopics.some(preferred => preferred.toLowerCase() === topic.toLowerCase())
    );
    
    if (hasPreferredTopic) {
      boostFactor += 0.05;
    }
  }
  
  // Boost for preferred authors
  if (preferredAuthors && result.author) {
    const authorLower = typeof result.author === 'string' ? result.author.toLowerCase() : String(result.author).toLowerCase();
    if (preferredAuthors.some(author => authorLower.includes(author.toLowerCase()))) {
      boostFactor += 0.05;
    }
  }
  
  return Math.min(score * boostFactor, 1.0);
};

export default calculateRelevanceScore;
