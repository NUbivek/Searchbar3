/**
 * SearchResultScorer.js
 * A dedicated utility for scoring search results with enhanced metrics
 * 
 * This utility centralizes the scoring logic for search results and provides
 * methods for scoring individual results, filtering based on scores,
 * and enhancing existing metrics based on query context.
 */

import MetricsCalculator from '../../components/search/metrics/MetricsCalculator';
import CategoryMetricsCalculator from '../../components/search/categories/processors/CategoryMetricsCalculator';
import { detectQueryContext } from '../../components/search/utils/contextDetector';
import { buildCorpus } from '../../components/search/metrics/MeasuredMetrics';

/**
 * Enhanced Search Result Scorer class
 */
class SearchResultScorer {
  /**
   * Score search results based on the query and additional options
   * @param {Array} results - The search results to score
   * @param {string} query - The search query
   * @param {Object} options - Additional scoring options
   * @returns {Array} - The scored search results
   */
  scoreResults(results, query, options = {}) {
    if (!results || !Array.isArray(results) || results.length === 0) {
      console.warn('No results to score');
      return [];
    }

    console.log(`Scoring ${results.length} results for query: "${query}"`);
    
    // Detect query context if not provided
    const context = options.context || detectQueryContext(query);
    // Cross-source evidence (claim agreement, same-story coverage), built once
    const corpus = options.corpus || buildCorpus(results);
    
    // Process each result with metrics
    const scoredResults = results.map(result => {
      // Check if the result already has metrics
      if (result.metrics && !options.recalculateMetrics) {
        return result;
      }
      
      // Calculate metrics using MetricsCalculator
      const metrics = MetricsCalculator.calculateMetrics(result, query, { 
        isBusinessQuery: context.isBusinessQuery,
        isTechnicalQuery: context.isTechnicalQuery,
        isFinancialQuery: context.isFinancialQuery,
        isMedicalQuery: context.isMedicalQuery,
        ...options,
        context,
        corpus
      });
      
      return {
        ...result,
        metrics
      };
    });
    
    // Log scoring results
    console.log('Scoring completed with details:', {
      totalScored: scoredResults.length,
      sampleMetrics: scoredResults.length > 0 ? {
        relevance: scoredResults[0].metrics?.relevance,
        accuracy: scoredResults[0].metrics?.accuracy,
        credibility: scoredResults[0].metrics?.credibility,
        overall: scoredResults[0].metrics?.overall
      } : 'No results'
    });
    
    return scoredResults;
  }

  /**
   * Filter results based on metrics thresholds
   * @param {Array} results - The search results with metrics
   * @param {Object} thresholds - Custom thresholds for filtering
   * @returns {Array} - Filtered search results
   */
  filterByMetrics(results, thresholds = {}) {
    if (!results || !Array.isArray(results) || results.length === 0) {
      return [];
    }
    
    // Get filtered results from MetricsCalculator
    const filteredResults = MetricsCalculator.filterResultsByMetrics(results, thresholds);
    
    console.log(`Filtered ${results.length} results down to ${filteredResults.length} based on metric thresholds`);
    
    return filteredResults;
  }

  /**
   * Sort results by a specific metric
   * @param {Array} results - The search results with metrics
   * @param {string} sortBy - The metric to sort by ('overall', 'relevance', 'accuracy', 'credibility')
   * @returns {Array} - Sorted search results
   */
  sortByMetric(results, sortBy = 'overall') {
    if (!results || !Array.isArray(results) || results.length === 0) {
      return [];
    }
    
    // Get sorted results from MetricsCalculator
    return MetricsCalculator.sortResultsByMetrics(results, sortBy);
  }

  /**
   * Score categories based on contained results
   * @param {Array} categories - The categories to score
   * @param {string} query - The search query
   * @param {Object} options - Additional scoring options
   * @returns {Array} - The scored categories
   */
  scoreCategories(categories, query, options = {}) {
    if (!categories || !Array.isArray(categories) || categories.length === 0) {
      return [];
    }
    
    console.log(`Scoring ${categories.length} categories for query: "${query}"`);
    
    // Process each category with metrics
    const scoredCategories = categories.map(category => {
      // Skip if already has metrics and not forcing recalculation
      if (category.metrics && !options.recalculateMetrics) {
        return category;
      }
      
      // Calculate metrics using CategoryMetricsCalculator
      const metrics = CategoryMetricsCalculator.calculateCategoryMetrics(category, query);
      
      return {
        ...category,
        metrics
      };
    });
    
    return scoredCategories;
  }

  /**
   * Prioritize categories based on metrics and query context
   * @param {Array} categories - The categories with metrics
   * @param {Object} context - The query context
   * @returns {Array} - Prioritized categories
   */
  prioritizeCategories(categories, context) {
    if (!categories || !Array.isArray(categories) || categories.length === 0) {
      return [];
    }
    
    // Sort categories by overall score by default
    let prioritized = [...categories].sort((a, b) => {
      const scoreA = (a.metrics?.overall || 0);
      const scoreB = (b.metrics?.overall || 0);
      return scoreB - scoreA;
    });
    
    // Apply context-based prioritization
    if (context) {
      // Boost categories based on context
      if (context.isBusinessQuery) {
        prioritized = this.boostCategoriesByType(prioritized, ['business', 'financial', 'market']);
      } else if (context.isTechnicalQuery) {
        prioritized = this.boostCategoriesByType(prioritized, ['technical', 'technology', 'development']);
      } else if (context.isFinancialQuery) {
        prioritized = this.boostCategoriesByType(prioritized, ['financial', 'investment', 'economic']);
      } else if (context.isMedicalQuery) {
        prioritized = this.boostCategoriesByType(prioritized, ['medical', 'health', 'clinical']);
      }
    }
    
    return prioritized;
  }
  
  /**
   * Boost categories by type
   * @param {Array} categories - Categories to boost
   * @param {Array} typeKeywords - Keywords for types to boost
   * @returns {Array} - Categories with boosted types at the top
   */
  boostCategoriesByType(categories, typeKeywords) {
    // Extract categories matching the keywords
    const boostedCategories = categories.filter(category => {
      const type = (category.type || '').toLowerCase();
      const name = (category.name || '').toLowerCase();
      
      return typeKeywords.some(keyword => 
        type.includes(keyword) || name.includes(keyword)
      );
    });
    
    // Get remaining categories
    const remainingCategories = categories.filter(category => {
      const type = (category.type || '').toLowerCase();
      const name = (category.name || '').toLowerCase();
      
      return !typeKeywords.some(keyword => 
        type.includes(keyword) || name.includes(keyword)
      );
    });
    
    // Combine with boosted categories first
    return [...boostedCategories, ...remainingCategories];
  }
}

// Create and export a singleton instance
const searchResultScorer = new SearchResultScorer();
export default searchResultScorer;
