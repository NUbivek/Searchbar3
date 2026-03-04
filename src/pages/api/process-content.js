/**
 * API endpoint for processing search results through LLM
 * Enhances search results with business-focused categorization and insights
 */

import { getDefaultCategories } from '../../components/search/categories/types/DefaultCategories';
import { detectQueryContext } from '../../components/search/metrics/utils/contextDetector';
import MetricsCalculator from '../../components/search/metrics/MetricsCalculator';
import { debug, info, error, warn } from '../../utils/logger';

// Create a log object for consistent logging
const log = { debug, info, error, warn };

/**
 * Process search results through LLM for enhanced categorization and insights
 * @param {Object} req - Next.js API request
 * @param {Object} res - Next.js API response
 */
export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { query, results, options = {} } = req.body;

    // Validate inputs
    if (!query || !results || !Array.isArray(results)) {
      return res.status(400).json({ 
        error: 'Invalid request. Query and results array are required.' 
      });
    }

    log.info(`Processing content for query: "${query}" with ${results.length} results`);

    // Process the content
    const processedContent = await processContentWithLLM(query, results, options);

    // Return the processed content
    return res.status(200).json({ 
      success: true,
      processedContent 
    });
  } catch (error) {
    log.error('Error processing content:', error);
    return res.status(200).json({
      status: 'fail-soft',
      success: false,
      processedContent: [],
      degradedSources: ['process-content'],
      error: 'Failed to process content',
      message: error.message
    });
  }
}

/**
 * Process content with LLM to enhance categorization and insights
 * @param {string} query - The search query
 * @param {Array} results - The search results to process
 * @param {Object} options - Processing options
 * @returns {Array} - Enhanced and categorized content
 */
async function processContentWithLLM(query, results, options) {
  try {
    // Ensure query is a string
    const safeQuery = typeof query === 'string' ? query : '';
    
    // Validate results array
    if (!Array.isArray(results) || results.length === 0) {
      log.warn('No valid results to process');
      return [];
    }
    
    // Detect query context
    const queryContexts = detectQueryContext(safeQuery);
    const isBusinessQuery = queryContexts.includes('business') || 
                          queryContexts.includes('financial') || 
                          queryContexts.includes('market') ||
                          queryContexts.includes('investment');

    log.debug('Query contexts detected:', queryContexts);
    log.debug('Is business query:', isBusinessQuery);

    // Get default categories based on query
    const categories = getDefaultCategories(safeQuery);
    
    // Initialize category content
    const categorizedResults = categories.map(category => ({
      ...category,
      content: [],
      insights: generateCategoryInsights(category, safeQuery)
    }));

    // Process each result to enhance with LLM insights
    const enhancedResults = results.map(result => {
      // Skip if no content
      if (!result || (!result.content && !result.title && !result.snippet && !result.description)) {
        return null;
      }

      try {
        // Calculate metrics for this result
        const metrics = MetricsCalculator.calculateMetrics(result, safeQuery, {
          businessFocus: isBusinessQuery || options.enhanceWithBusinessContext,
          enhancedBusinessMetrics: isBusinessQuery || options.enhanceWithBusinessContext
        });

        // Enhance the result with metrics and additional fields
        return {
          ...result,
          _metrics: metrics,
          _relevanceScore: metrics.relevance,
          _accuracyScore: metrics.accuracy,
          _credibilityScore: metrics.credibility,
          _overallScore: metrics.overall,
          _recencyScore: metrics.recency,
          _enhancedByLLM: true
        };
      } catch (err) {
        log.error('Error enhancing result:', err);
        // Return the original result with a flag indicating it wasn't enhanced
        return {
          ...result,
          _enhancedByLLM: false,
          _error: err.message
        };
      }
    }).filter(Boolean); // Remove null items

    log.debug(`Enhanced ${enhancedResults.length} results with metrics`);
    
    // If no results were enhanced, return empty array
    if (enhancedResults.length === 0) {
      log.warn('No results were successfully enhanced');
      return [];
    }

    // Categorize the enhanced results
    enhancedResults.forEach(result => {
      // Extract content text for matching
      const contentText = extractContentText(result);
      
      // Track categories and their scores
      const categoryScores = [];

      // Calculate match scores for each category
      categorizedResults.forEach(category => {
        // Skip "All Results" category for now
        if (category.name === 'All Results') return;

        // Calculate match score for this category
        let matchScore = calculateCategoryMatchScore(category, result, contentText, safeQuery);
        
        // Store the score
        categoryScores.push({
          category,
          score: matchScore
        });
      });

      // Sort categories by score (highest first)
      categoryScores.sort((a, b) => b.score - a.score);
      
      // Add to top categories if score is good enough (allow multiple categories)
      const topCategories = categoryScores.filter(item => item.score > 40);
      
      // Ensure at least one category (other than All Results) gets the result
      if (topCategories.length === 0 && categoryScores.length > 0) {
        topCategories.push(categoryScores[0]);
      }
      
      // Add to each matching category
      topCategories.forEach(({ category, score }) => {
        category.content.push({
          ...result,
          _categoryId: category.id,
          _categoryScore: score
        });
      });

      // Always add to "All Results" category
      const allResultsCategory = categorizedResults.find(c => c.name === 'All Results');
      if (allResultsCategory) {
        allResultsCategory.content.push({
          ...result,
          _categoryId: allResultsCategory.id,
          _categoryScore: 100
        });
      }
    });

    // Sort content within each category by overall score
    categorizedResults.forEach(category => {
      category.content.sort((a, b) => {
        return (b._overallScore || 0) - (a._overallScore || 0);
      });
    });

    // Filter out empty categories and sort by priority
    const finalCategories = categorizedResults
      .filter(category => category.content.length > 0)
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));

    log.info(`Categorized results into ${finalCategories.length} categories`);
    
    return finalCategories;
  } catch (err) {
    log.error('Error processing content:', err);
    return [];
  }
}

/**
 * Extract text content from a result for matching
 * @param {Object} result - The result object
 * @returns {string} - Extracted text content
 */
function extractContentText(result) {
  return [
    result.title || '',
    result.content || '',
    result.description || '',
    result.snippet || '',
    result.source || '',
    result.domain || '',
    result.url || result.link || ''
  ].filter(Boolean).join(' ').toLowerCase();
}

/**
 * Calculate match score between a category and a result
 * @param {Object} category - The category object
 * @param {Object} result - The result object
 * @param {string} contentText - Extracted content text
 * @param {string} query - The search query
 * @returns {number} - Match score
 */
function calculateCategoryMatchScore(category, result, contentText, query) {
  let matchScore = 0;
  
  // If category has keywords, check for matches
  if (category.keywords && category.keywords.length > 0) {
    // Count keyword matches with different weights
    category.keywords.forEach(keyword => {
      const lowerKeyword = keyword.toLowerCase();
      
      // Exact match has higher weight
      if (contentText.includes(lowerKeyword)) {
        matchScore += 15;
        
        // Even higher if it's in the title
        if ((result.title || '').toLowerCase().includes(lowerKeyword)) {
          matchScore += 10;
        }
      }
      
      // Partial matches (for multi-word keywords)
      if (lowerKeyword.includes(' ')) {
        const parts = lowerKeyword.split(' ');
        let partMatches = 0;
        
        parts.forEach(part => {
          if (contentText.includes(part)) {
            partMatches++;
          }
        });
        
        // Add partial score based on percentage of parts matched
        if (partMatches > 0) {
          matchScore += (partMatches / parts.length) * 10;
        }
      }
    });
  }
  
  // Add relevance score to match score
  matchScore += (result._relevanceScore || 0) * 0.5;
  
  // Add category-specific scoring
  switch (category.id) {
    case 'business':
      // Boost business category for business metrics
      if (result._metrics && result._metrics.business > 70) {
        matchScore += 20;
      }
      break;
    case 'technical':
      // Boost technical category for technical content
      if (contentText.includes('technology') || 
          contentText.includes('software') || 
          contentText.includes('hardware') ||
          contentText.includes('code') ||
          contentText.includes('programming')) {
        matchScore += 15;
      }
      break;
    case 'news':
      // Boost news category for recent content
      if (result._recencyScore > 80) {
        matchScore += 15;
      }
      break;
  }
  
  return matchScore;
}

/**
 * Generate insights for a category
 * @param {Object} category - The category object
 * @param {string} query - The search query
 * @returns {Array} - Array of insight strings
 */
function generateCategoryInsights(category, query) {
  const insights = [];
  
  // Generate category-specific insights
  switch (category.id) {
    case 'business':
      insights.push(`Business analysis for "${query}"`);
      insights.push(`Market trends related to ${query}`);
      break;
    case 'technical':
      insights.push(`Technical details about ${query}`);
      insights.push(`Implementation considerations for ${query}`);
      break;
    case 'news':
      insights.push(`Latest developments regarding ${query}`);
      insights.push(`Recent updates about ${query}`);
      break;
    case 'academic':
      insights.push(`Research findings about ${query}`);
      insights.push(`Academic perspectives on ${query}`);
      break;
  }
  
  return insights;
}
