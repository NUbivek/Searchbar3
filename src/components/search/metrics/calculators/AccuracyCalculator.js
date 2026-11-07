/**
 * AccuracyCalculator.js
 * Calculates the accuracy score for search results based on data verification, source reliability, and factual consistency.
 * Enhanced with more sophisticated scoring algorithms and additional factors.
 * 
 * IMPORTANT: This enhanced version preserves all the original algorithm functionality while adding new features:
 * - Original: Data verification score based on verifiable data points and recency
 * - Original: Source reliability score based on source categorization
 * - Original: Factual consistency score based on internal consistency and citations
 * - Enhanced: More comprehensive source categorization with three reliability tiers
 * - Enhanced: More granular recency scoring and data precision detection
 * - Enhanced: Improved citation quality assessment and contradiction detection
 * - NEW: External fact-checking integration
 * - NEW: Citation validation and verification
 * - NEW: Cross-reference verification with multiple sources
 * - NEW: Statistical significance assessment
 */

import { 
  containsSpecificDetails,
  containsPreciseData,
  normalizeScore,
  matchesDomain
} from '../../utils/calculatorUtils';

import {
  DISPLAY_THRESHOLD,
  FACT_CHECKING_SOURCES
} from '../data/accuracyData';

import {
  SOURCE_CATEGORIES
} from '../utils/calculatorData';

// Constants for weighting different factors
const WEIGHTS = {
  DATA_VERIFICATION: 0.30,
  SOURCE_RELIABILITY: 0.30,
  FACTUAL_CONSISTENCY: 0.25,
  EXTERNAL_VALIDATION: 0.15, // New factor
};

// Minimum threshold for accuracy score (70%)
const ACCURACY_THRESHOLD = DISPLAY_THRESHOLD;

/**
 * Calculate the accuracy score for a search result
 * @param {Object} result - Search result to calculate accuracy for
 * @param {Array} allResults - All search results for cross-reference
 * @returns {number} - Accuracy score (0-100)
 */
export const calculateAccuracyScore = (result, options = {}) => {
  if (!result) return 0;
  
  // Initialize scores for each factor
  let dataVerificationScore = calculateDataVerificationScore(result);
  let sourceReliabilityScore = calculateSourceReliabilityScore(result, options);
  let factualConsistencyScore = calculateFactualConsistencyScore(result, options);
  let externalValidationScore = calculateExternalValidationScore(result, options);
  
  // Apply weights to each factor
  const weightedScore = (
    (dataVerificationScore * WEIGHTS.DATA_VERIFICATION) +
    (sourceReliabilityScore * WEIGHTS.SOURCE_RELIABILITY) +
    (factualConsistencyScore * WEIGHTS.FACTUAL_CONSISTENCY) +
    (externalValidationScore * WEIGHTS.EXTERNAL_VALIDATION)
  );
  
  // 0-1 scale, like the other calculators (this returned 0-100, which
  // MetricsCalculator treated as 0-1 and capped at 0.95)
  const finalScore = Math.min(Math.max(weightedScore, 0), 1);
  
  // Apply threshold (DISPLAY_THRESHOLD is a percentage)
  const floor = ACCURACY_THRESHOLD / 100;
  return finalScore < floor ? floor : finalScore;
};

/**
 * Calculate data verification score based on verifiable data points
 * @param {Object} result - Search result to calculate score for
 * @returns {number} - Score between 0-1
 */
const calculateDataVerificationScore = (result) => {
  let score = 0.5; // Base score
  
  // Factor 1: Contains numbers or statistics
  if (result.content) {
    if (/\d+([.,]\d+)?%?/.test(result.content)) {
      score += 0.1;
    }
  }
  
  // Factor 2: Contains dates
  if (result.content) {
    if (/\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2},? \d{4}\b|\b\d{4}\b|\b(yesterday|today|last week|last month|last year)\b/i.test(result.content)) {
      score += 0.1;
    }
  }
  
  // Factor 3: Contains citations or references
  if (result.content && /\[\d+\]|\(\d{4}\)|\bcited\b|\breference\b/i.test(result.content)) {
    score += 0.1;
  }
  
  // Factor 4: Contains specific details and precision
  if (result.content) {
    if (containsSpecificDetails(result.content)) {
      score += 0.05;
    }
    if (containsPreciseData(result.content)) {
      score += 0.05;
    }
  }
  
  // Factor 5: Data is from primary research or official reports
  if (result.source && isPrimaryDataSource(result.source)) {
    score += 0.1;
  }
  
  // Normalize score to 0-1 range
  return normalizeScore(score);
};

/**
 * Calculate source reliability score
 * @param {string} source - The source of the result
 * @param {Object} options - Additional options
 * @returns {number} - Score between 0-1
 */
const calculateSourceReliabilityScore = (source, options = {}) => {
  if (!source) return 0.5; // Default middle score if no source
  
  // Ensure source is a string before calling toLowerCase
  const sourceLower = typeof source === 'string' ? source.toLowerCase() : String(source).toLowerCase();
  
  // Check for verified badge or official status
  if (options.isVerified || options.isOfficial) {
    return 0.95; // Highest reliability for verified sources
  }
  
  // Check source against our categorized lists
  for (const reliableSource of SOURCE_CATEGORIES.HIGHLY_RELIABLE) {
    if (sourceLower.includes(reliableSource)) {
      // Adjust for domain specificity (e.g., .edu, .gov, .org)
      if (sourceLower.endsWith('.edu') || sourceLower.endsWith('.gov')) {
        return 0.95; // Highest reliability for educational and government sources
      }
      return 0.9; // High reliability score
    }
  }
  
  for (const moderateSource of SOURCE_CATEGORIES.MODERATELY_RELIABLE) {
    if (sourceLower.includes(moderateSource)) {
      return 0.75; // Moderate reliability score
    }
  }
  
  for (const lessReliableSource of SOURCE_CATEGORIES.LESS_RELIABLE) {
    if (sourceLower.includes(lessReliableSource)) {
      // Social media can still be reliable if it's from a verified account
      if (options.isVerifiedAccount && (
          sourceLower.includes('twitter') || 
          sourceLower.includes('linkedin') || 
          sourceLower.includes('facebook'))) {
        return 0.7; // Higher score for verified social accounts
      }
      return 0.4; // Lower reliability score
    }
  }
  
  // Check for domain extensions that generally indicate higher reliability
  if (sourceLower.endsWith('.edu') || sourceLower.endsWith('.gov')) {
    return 0.85;
  }
  if (sourceLower.endsWith('.org')) {
    return 0.7;
  }
  
  // Default score for unknown sources
  return 0.5;
};

/**
 * Calculate factual consistency score
 * @param {Object} result - The search result
 * @param {Object} options - Additional options
 * @returns {number} - Score between 0-1
 */
const calculateFactualConsistencyScore = (result, options) => {
  let score = 0.5; // Start with a baseline score
  
  // Factor 1: Internal consistency (no contradictions)
  if (result.content && !containsContradictions(result.content)) {
    score += 0.1;
  }
  
  // Factor 2: Cites primary sources
  if (result.citesPrimarySources || (result.citations && result.citations.length > 0)) {
    // More granular scoring based on citation quality
    const citationQuality = assessCitationQuality(result.citations);
    score += citationQuality * 0.2;
  }
  
  // Factor 3: Fact-checking status (if available)
  if (options.factCheckStatus) {
    if (options.factCheckStatus === 'verified') score += 0.15;
    else if (options.factCheckStatus === 'mostly_true') score += 0.1;
    else if (options.factCheckStatus === 'mixed') score += 0.0;
    else if (options.factCheckStatus === 'mostly_false') score -= 0.1;
    else if (options.factCheckStatus === 'disputed') score -= 0.15;
    else if (options.factCheckStatus === 'false') score -= 0.25;
  }
  
  // Factor 4: Consensus alignment (if available)
  if (options.consensusAlignment) {
    if (options.consensusAlignment === 'high') score += 0.15;
    else if (options.consensusAlignment === 'moderate') score += 0.05;
    else if (options.consensusAlignment === 'low') score -= 0.1;
  }
  
  // Factor 5: Presence of qualifying language and nuance
  if (result.content && containsNuancedLanguage(result.content)) {
    score += 0.05;
  }
  
  // Cap between 0 and 1
  return Math.min(Math.max(score, 0), 1.0);
};

/**
 * Calculate external validation score
 * @param {Object} result - The search result
 * @param {Object} options - Additional options
 * @returns {number} - Score between 0-1
 */
const calculateExternalValidationScore = (result, options = {}) => {
  if (!result.content) return 0.5;
  
  let score = 0.5; // Start with neutral score
  
  // Check if content has been fact-checked
  const factCheckScore = calculateFactCheckScore(result);
  
  // Check if citations are valid and verifiable
  const citationValidationScore = validateCitations(result.citations || []);
  
  // Check for cross-reference verification
  const crossReferenceScore = calculateCrossReferenceScore(result, options);
  
  // Check for statistical significance in data
  const statisticalSignificanceScore = assessStatisticalSignificance(result.content);
  
  // Combine scores with weights
  score = (factCheckScore * 0.35) + 
          (citationValidationScore * 0.25) + 
          (crossReferenceScore * 0.25) + 
          (statisticalSignificanceScore * 0.15);
  
  return score;
};

/**
 * Calculate fact-check score
 * @param {Object} result - The search result
 * @returns {number} - Score between 0-1
 */
const calculateFactCheckScore = (result) => {
  // Default score if no fact-checking information is available
  let score = 0.5;
  
  // Check if the source itself is a fact-checking organization
  if (result.source) {
    const sourceLower = typeof result.source === 'string' ? result.source.toLowerCase() : String(result.source).toLowerCase();
    if (FACT_CHECKING_SOURCES.some(factChecker => sourceLower.includes(factChecker))) {
      score = 0.9; // High score for fact-checking sources
    }
  }
  
  // Check if the content references fact-checking
  if (result.content) {
    const contentLower = result.content.toLowerCase();
    
    // Check for references to fact-checking organizations
    const hasFactCheckReference = FACT_CHECKING_SOURCES.some(
      factChecker => contentLower.includes(factChecker)
    );
    
    // Check for fact-checking terminology
    const hasFactCheckTerminology = [
      'fact check', 'fact-check', 'verified', 'debunked', 'confirmed',
      'rated false', 'rated true', 'pants on fire', 'four pinocchios'
    ].some(term => contentLower.includes(term));
    
    if (hasFactCheckReference) score += 0.2;
    if (hasFactCheckTerminology) score += 0.1;
  }
  
  // Cap score at 1.0
  return Math.min(score, 1.0);
};

/**
 * Validate citations
 * @param {Array} citations - List of citations
 * @returns {number} - Score between 0-1
 */
const validateCitations = (citations) => {
  if (!citations || citations.length === 0) return 0.3;
  
  let validCount = 0;
  let totalScore = 0;
  
  for (const citation of citations) {
    let citationScore = 0.5;
    
    // Check if citation has a verifiable source
    if (citation.source) {
      const sourceLower = typeof citation.source === 'string' ? citation.source.toLowerCase() : String(citation.source).toLowerCase();
      
      // Higher score for academic or institutional sources
      if (/\.edu|\.gov|\.org/.test(sourceLower)) {
        citationScore += 0.2;
      }
      
      // Check if source is in our reliability categories
      if (SOURCE_CATEGORIES.HIGHLY_RELIABLE.some(s => sourceLower.includes(s))) {
        citationScore += 0.2;
      } else if (SOURCE_CATEGORIES.MODERATELY_RELIABLE.some(s => sourceLower.includes(s))) {
        citationScore += 0.1;
      }
    }
    
    // Check if citation has a date
    if (citation.date || citation.year) {
      citationScore += 0.1;
    }
    
    // Check if citation has an author
    if (citation.author) {
      citationScore += 0.1;
    }
    
    // Check if citation has a title
    if (citation.title) {
      citationScore += 0.1;
    }
    
    // Check if citation has a URL or DOI
    if (citation.url || citation.doi) {
      citationScore += 0.1;
    }
    
    totalScore += Math.min(citationScore, 1.0);
    validCount++;
  }
  
  return validCount > 0 ? totalScore / validCount : 0.3;
};

/**
 * Calculate cross-reference verification score
 * @param {Object} result - The search result
 * @param {Object} options - Additional options
 * @returns {number} - Score between 0-1
 */
const calculateCrossReferenceScore = (result, options = {}) => {
  // Default score if no cross-reference information
  let score = 0.5;
  
  // If we have related results to compare with
  if (options.relatedResults && Array.isArray(options.relatedResults) && options.relatedResults.length > 0) {
    const consistencyScores = [];
    
    // Extract key claims or facts from our result
    const keyClaims = extractKeyClaims(result.content);
    
    // Compare each key claim with related results
    for (const claim of keyClaims) {
      let claimConsistencyCount = 0;
      
      for (const relatedResult of options.relatedResults) {
        if (relatedResult.content && relatedResult.content.includes(claim)) {
          claimConsistencyCount++;
        }
      }
      
      // Calculate consistency percentage for this claim
      const consistencyScore = claimConsistencyCount / options.relatedResults.length;
      consistencyScores.push(consistencyScore);
    }
    
    // Average the consistency scores if we have any
    if (consistencyScores.length > 0) {
      score = consistencyScores.reduce((sum, score) => sum + score, 0) / consistencyScores.length;
    }
  }
  
  // Boost score if the content cites multiple sources
  if (result.citations && result.citations.length > 2) {
    score += 0.1;
  }
  
  // Boost score if content references multiple perspectives
  if (result.content && containsMultiplePerspectives(result.content)) {
    score += 0.1;
  }
  
  return Math.min(score, 1.0);
};

/**
 * Extract key claims from content
 * @param {string} content - Content to analyze
 * @returns {Array} - List of key claims
 */
const extractKeyClaims = (content) => {
  if (!content) return [];
  
  const claims = [];
  
  // Simple extraction of sentences with claim indicators
  const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 0);
  
  const claimIndicators = [
    'according to', 'studies show', 'research indicates', 'data shows',
    'evidence suggests', 'report states', 'analysis found', 'survey indicates',
    'experts say', 'statistics show', 'findings reveal', 'concluded that'
  ];
  
  for (const sentence of sentences) {
    if (claimIndicators.some(indicator => sentence.toLowerCase().includes(indicator))) {
      claims.push(sentence.trim());
    }
  }
  
  // Also include sentences with numbers, which often contain factual claims
  for (const sentence of sentences) {
    if (/\d+([.,]\d+)?%?/.test(sentence) && !claims.includes(sentence.trim())) {
      claims.push(sentence.trim());
    }
  }
  
  return claims;
};

/**
 * Check if content contains multiple perspectives
 * @param {string} content - Content to analyze
 * @returns {boolean} - Whether content contains multiple perspectives
 */
const containsMultiplePerspectives = (content) => {
  if (!content) return false;
  
  const contentLower = content.toLowerCase();
  
  // Check for perspective indicators
  const perspectiveIndicators = [
    'however', 'on the other hand', 'in contrast', 'alternatively',
    'critics argue', 'proponents suggest', 'some argue', 'others believe',
    'different perspective', 'opposing view', 'debate', 'controversy',
    'while some', 'whereas', 'conversely', 'despite this'
  ];
  
  return perspectiveIndicators.some(indicator => contentLower.includes(indicator));
};

/**
 * Assess statistical significance in content
 * @param {string} content - Content to analyze
 * @returns {number} - Score between 0-1
 */
const assessStatisticalSignificance = (content) => {
  if (!content) return 0.5;
  
  const contentLower = content.toLowerCase();
  let score = 0.5;
  
  // Check for statistical terminology
  const statisticalTerms = [
    'statistically significant', 'p-value', 'confidence interval',
    'margin of error', 'sample size', 'standard deviation', 'correlation',
    'regression', 'chi-square', 't-test', 'anova', 'statistical analysis',
    'confidence level', '95% confidence', 'statistically meaningful'
  ];
  
  const hasStatisticalTerminology = statisticalTerms.some(term => contentLower.includes(term));
  
  if (hasStatisticalTerminology) {
    score += 0.2;
  }
  
  // Check for precise percentages and numbers
  const hasPreciseNumbers = /\d+\.\d+%|\d+\.\d+/.test(content);
  
  if (hasPreciseNumbers) {
    score += 0.1;
  }
  
  // Check for sample size mentions
  const hasSampleSize = /sample (size|of) (\d+|n=\d+)/i.test(content);
  
  if (hasSampleSize) {
    score += 0.1;
  }
  
  // Check for methodology descriptions
  const hasMethodology = /(methodology|method|approach|procedure|protocol|study design)/i.test(content);
  
  if (hasMethodology) {
    score += 0.1;
  }
  
  return Math.min(score, 1.0);
};

// Helper functions

/**
 * Check if text contains contradictions
 * @param {string} text - Text to analyze
 * @returns {boolean} - Whether text contains contradictions
 */
const containsContradictions = (text) => {
  // Look for contradictory statements
  const contradictionPatterns = [
    /\bbut\b.*\bhowever\b/i,
    /\bnot\b.*\bbut\b/i,
    /\bcontrary\b/i,
    /\bcontradict\b/i,
    /\boppose\b/i,
    /\bdespite\b/i,
    /\balthough\b/i,
    /\bwhile\b.*\bin contrast\b/i,
    /\bon the other hand\b/i,
    /\bnevertheless\b/i
  ];
  
  return contradictionPatterns.some(pattern => pattern.test(text));
};

/**
 * Check if a data source is primary
 * @param {string} source - Data source to check
 * @returns {boolean} - Whether source is primary
 */
const isPrimaryDataSource = (source) => {
  if (!source) return false;
  
  // Check if source is a government or educational institution
  if (/\.gov|\.edu|\.org/.test(source)) {
    return true;
  }
  
  // Check if source is a known primary research institution
  const primarySources = [
    'research', 'study', 'report', 'data', 'statistics',
    'survey', 'analysis', 'findings', 'results', 'publication'
  ];
  
  return primarySources.some(term => source.toLowerCase().includes(term));
};

/**
 * Assess the quality of citations
 * @param {Array} citations - List of citations
 * @returns {number} - Citation quality score (0-1)
 */
const assessCitationQuality = (citations) => {
  if (!citations || citations.length === 0) return 0;
  
  // Convert to array if it's not already
  const citationArray = Array.isArray(citations) ? citations : [citations];
  
  // Count high-quality citations (from reliable sources)
  let highQualityCount = 0;
  
  for (const citation of citationArray) {
    const source = typeof citation === 'string' ? citation : citation.source;
    if (!source) continue;
    
    const sourceLower = typeof source === 'string' ? source.toLowerCase() : String(source).toLowerCase();
    
    // Check against highly reliable sources
    if (SOURCE_CATEGORIES.HIGHLY_RELIABLE.some(reliable => sourceLower.includes(reliable))) {
      highQualityCount++;
    }
    // Check for academic citations
    else if (/doi\.org|pmid|isbn|issn/.test(sourceLower)) {
      highQualityCount++;
    }
  }
  
  // Calculate quality ratio
  return Math.min(highQualityCount / citationArray.length, 1);
};

/**
 * Check if text contains nuanced language
 * @param {string} text - Text to analyze
 * @returns {boolean} - Whether text contains nuanced language
 */
const containsNuancedLanguage = (text) => {
  const nuancePatterns = [
    /however/i,
    /although/i,
    /nevertheless/i,
    /on the other hand/i,
    /according to/i,
    /suggests/i,
    /indicates/i,
    /may/i,
    /might/i,
    /could/i,
    /possibly/i,
    /approximately/i,
    /estimated/i,
    /reportedly/i
  ];
  
  return nuancePatterns.some(pattern => pattern.test(text));
};

export const calculateAccuracy = calculateAccuracyScore;
export default calculateAccuracyScore;