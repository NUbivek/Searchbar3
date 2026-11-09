/**
 * MetricsCalculator.js
 * Integrates all individual metric calculators and provides overall scoring functionality.
 * Enhanced with improved weighting, context-aware scoring, and user preference integration.
 * Simplified to use only three scores: Relevance & Recency, Accuracy, and Credibility
 */

import calculateAccuracy from './calculators/AccuracyCalculator';
import calculateCredibility from './calculators/CredibilityCalculator';
import calculateRecency from './calculators/RecencyCalculator';
import calculateRelevanceBase from './calculators/RelevanceCalculator';
import { detectQueryContext } from './utils/contextDetector';
import { measureResult } from './MeasuredMetrics';


/**
 * Calculate combined relevance and recency score
 * @param {Object} result - The search result
 * @param {string} query - The search query
 * @returns {number} - Combined relevance & recency score
 */
const calculateRelevanceAndRecency = (result, query) => {
  if (!result) return 0;
  
  const relevanceScore = calculateRelevanceBase(result, query);
  const recencyScore = calculateRecency(result);
  
  // Combine relevance and recency with weighing towards relevance (70/30 split)
  return (relevanceScore * 0.7) + (recencyScore * 0.3);
};

/**
 * Calculate metrics for a search result
 * @param {Object} result - The search result
 * @param {string} query - The search query
 * @param {Object} options - Additional options
 * @returns {Object} - Object containing calculated metrics
 */
const calculateMetrics = (result, query, options = {}) => {
  if (!result) {
    return { relevance: null, accuracy: null, credibility: null, overall: null };
  }

  // Every component is measured from evidence in the result (see
  // MeasuredMetrics.js and docs/METRICS_SYSTEM.md). Scores are 0-1, or null
  // when nothing measurable was available. No default or flat boost is added.
  const measured = measureResult(result, query, {
    context: options.context || {
      isBusinessQuery: options.isBusinessQuery,
      isFinancialQuery: options.isFinancialQuery,
      isTechnicalQuery: options.isTechnicalQuery,
      isMedicalQuery: options.isMedicalQuery,
      isNewsQuery: options.isNewsQuery,
      isAcademicQuery: options.isAcademicQuery,
    },
    corpus: options.corpus || null,
    userPreferences: options.userPreferences || null,
  });

  // Ranking-only boost for verified sources (unchanged): applied to the
  // boosted* fields, never to the displayed scores.
  const isVerified = result.isVerified || false;
  const BOOST_FACTORS = { relevance: 0.25, accuracy: 0.40, credibility: 0.60 };
  const boost = (v, f) => (v == null ? null : Math.min(isVerified ? v + (f * v * (1 - v)) : v, 0.95));
  const boostedRelevance = boost(measured.relevance, BOOST_FACTORS.relevance);
  const boostedAccuracy = boost(measured.accuracy, BOOST_FACTORS.accuracy);
  const boostedCredibility = boost(measured.credibility, BOOST_FACTORS.credibility);
  const w = measured.weights;
  const parts = [[boostedRelevance, w.RELEVANCE], [boostedAccuracy, w.ACCURACY], [boostedCredibility, w.CREDIBILITY]].filter(([v]) => v != null);
  const wsum = parts.reduce((sum, [, x]) => sum + x, 0);

  return {
    relevance: measured.relevance,
    accuracy: measured.accuracy,
    credibility: measured.credibility,
    overall: measured.overall,
    boostedRelevance,
    boostedAccuracy,
    boostedCredibility,
    boostedOverall: wsum > 0 ? parts.reduce((sum, [v, x]) => sum + v * x, 0) / wsum : null,
    isVerified,
    coverage: measured.coverage,
    components: measured.components,
    weights: measured.weights,
  };
};

/**
 * Calculate overall score with appropriate weights
 * @param {number} relevance - Combined Relevance & Recency score
 * @param {number} accuracy - Accuracy score
 * @param {number} credibility - Credibility score
 * @returns {number} - Overall score
 */
const calculateOverall = (relevance, accuracy, credibility) => {
  // Ensure all scores are numbers between 0 and 1
  const r = Math.max(0, Math.min(1, Number(relevance) || 0));
  const a = Math.max(0, Math.min(1, Number(accuracy) || 0));
  const c = Math.max(0, Math.min(1, Number(credibility) || 0));
  
  // Apply weights to each score
  // Relevance gets higher weight as it's the most important factor
  const weights = {
    relevance: 0.5,  // 50% - Highest weight because it combines relevance & recency
    accuracy: 0.25,  // 25%
    credibility: 0.25 // 25%
  };
  
  // Calculate weighted score
  const weightedScore = (r * weights.relevance) + 
                       (a * weights.accuracy) + 
                       (c * weights.credibility);
  
  return weightedScore;
};

/**
 * Get color for a metric based on its score
 * @param {number} score - Metric score
 * @returns {string} - CSS color class
 */
const getMetricColor = (score) => {
  if (score >= 0.85) return 'metric-excellent';
  if (score >= 0.7) return 'metric-good';
  if (score >= 0.55) return 'metric-average';
  if (score >= 0.35) return 'metric-fair';
  return 'metric-poor';
};

/**
 * Get label for a metric based on its score
 * @param {number} score - Metric score
 * @returns {string} - Text label
 */
const getMetricLabel = (score) => {
  if (score >= 0.85) return 'Excellent';
  if (score >= 0.7) return 'Good';
  if (score >= 0.55) return 'Average';
  if (score >= 0.35) return 'Fair';
  return 'Poor';
};

/**
 * Filter results based on metric thresholds
 * @param {Array} results - Array of search results with metrics
 * @returns {Array} - Filtered results
 */
const filterResultsByMetrics = (results) => {
  if (!results || !Array.isArray(results)) return [];
  
  return results.filter(result => {
    if (!result.metrics) return false;
    
    // Use a much lower threshold (10%) for verified sources
    if (result.isVerified) {
      return result.metrics.overall >= 0.1; // Only 10% threshold for verified sources
    }
    
    // Standard threshold for normal sources
    return result.metrics.overall >= 0.5;
  });
};

/**
 * Normalize scores for display purposes
 * This ensures verified sources don't appear to have artificially inflated scores
 * @param {Object} metrics - The metrics object
 * @param {boolean} isVerified - Whether this is from a verified source
 * @returns {Object} - Normalized metrics for display
 */
const normalizeMetricsForDisplay = (metrics, isVerified = false) => {
  if (!metrics) return metrics;
  
  // For non-verified sources, return as is
  if (!isVerified) return metrics;
  
  // For verified sources, make a copy first
  const displayMetrics = { ...metrics };
  
  // Normalize the scores to appear consistent with non-verified sources
  // This makes the UI more consistent rather than showing artificially high scores
  if (displayMetrics.relevance) {
    displayMetrics.displayRelevance = Math.min(1, (displayMetrics.relevance / 1.4));
  }
  
  if (displayMetrics.accuracy) {
    displayMetrics.displayAccuracy = Math.min(1, (displayMetrics.accuracy / 1.4));
  }
  
  if (displayMetrics.credibility) {
    displayMetrics.displayCredibility = Math.min(1, (displayMetrics.credibility / 1.4));
  }
  
  if (displayMetrics.overall) {
    displayMetrics.displayOverall = Math.min(1, (displayMetrics.overall / 1.4));
  }
  
  // Add a flag to indicate this has normalized display metrics
  displayMetrics.hasDisplayMetrics = true;
  
  return displayMetrics;
};

/**
 * Sort results based on metrics
 * @param {Array} results - Array of search results with metrics
 * @param {string} sortBy - Metric to sort by ('overall', 'relevance', 'accuracy', 'credibility')
 * @returns {Array} - Sorted results
 */
const sortResultsByMetrics = (results, sortBy = 'overall') => {
  if (!results || !Array.isArray(results)) return [];
  
  const validMetrics = ['overall', 'relevance', 'accuracy', 'credibility'];
  const metricToSort = validMetrics.includes(sortBy) ? sortBy : 'overall';
  
  return [...results].sort((a, b) => {
    const scoreA = a.metrics ? (a.metrics[metricToSort] || 0) : 0;
    const scoreB = b.metrics ? (b.metrics[metricToSort] || 0) : 0;
    return scoreB - scoreA; // Descending order
  });
};

// Export all functions
export default {
  calculateMetrics,
  calculateRelevanceAndRecency,
  calculateAccuracy,
  calculateCredibility,
  calculateOverall,
  getMetricColor,
  getMetricLabel,
  filterResultsByMetrics,
  normalizeMetricsForDisplay,
  sortResultsByMetrics
};