/**
 * RecencyCalculator.js
 * Calculates recency score for search results based on publication date.
 */

import { normalizeScore } from '../../utils/calculatorUtils';

/**
 * Calculate recency score for a search result
 * @param {Object} result - The search result
 * @param {Object} options - Additional options
 * @returns {number} - Recency score between 0-100
 */
const calculateRecency = (result, options = {}) => {
  if (!result) return 0;
  
  // Default recency score if no date information
  let score = 0.5;
  
  try {
    // Extract date information from result
    const dateStr = result.date || result.publishedDate || result.publishedAt || result.timestamp || result.metadata?.date || '';
    
    if (dateStr) {
      const date = new Date(dateStr);
      
      // Check if date is valid
      if (!isNaN(date.getTime())) {
        const now = new Date();
        const ageInDays = (now - date) / (1000 * 60 * 60 * 24);
        
        // Score based on age:
        // - Very recent (< 7 days): 0.9 - 1.0
        // - Recent (< 30 days): 0.8 - 0.9
        // - Fairly recent (< 90 days): 0.7 - 0.8
        // - This year: 0.5 - 0.7
        // - Older: 0.1 - 0.5 (scaled)
        
        if (ageInDays < 7) {
          score = 0.9 + (0.1 * (1 - ageInDays / 7));
        } else if (ageInDays < 30) {
          score = 0.8 + (0.1 * (1 - (ageInDays - 7) / 23));
        } else if (ageInDays < 90) {
          score = 0.7 + (0.1 * (1 - (ageInDays - 30) / 60));
        } else if (ageInDays < 365) {
          score = 0.5 + (0.2 * (1 - (ageInDays - 90) / 275));
        } else {
          // Older content gets lower scores, but never below 0.1
          score = Math.max(0.1, 0.5 - (0.4 * Math.min(1, (ageInDays - 365) / 1095))); // 1095 days = 3 years
        }
      }
    }
    
    // Adjust score based on content freshness indicators
    if (result.content) {
      const content = typeof result.content === 'string' ? result.content.toLowerCase() : '';
      
      // Check for freshness indicators in content
      if (content.includes('latest') || 
          content.includes('new') || 
          content.includes('recent') || 
          content.includes('update') || 
          content.includes('current')) {
        score += 0.05; // Small boost for freshness indicators
      }
    }
    
    // 0-1 scale, like the other calculators
    return normalizeScore(score);
  } catch (error) {
    console.error('Error calculating recency score:', error);
    return 0.5; // Default middle score on error
  }
};

export default calculateRecency;