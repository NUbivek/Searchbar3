/**
 * SourceReputationScorer.js
 * 
 * Evaluates the reputation of sources based on domain, age, citations,
 * and other factors to enhance credibility assessment.
 */

import { debug, info, error, warn } from '../../../utils/logger';

// Create a log object for consistent logging
const log = { debug, info, error, warn };

// Source reputation database (simplified version)
// In a production environment, this could be loaded from an API or database
export const SOURCE_REPUTATION_DB = {
  // News sources
  'nytimes.com': { reputation: 90, category: 'news', tier: 'premium' },
  'wsj.com': { reputation: 88, category: 'news', tier: 'premium' },
  'reuters.com': { reputation: 92, category: 'news', tier: 'premium' },
  'ap.org': { reputation: 91, category: 'news', tier: 'premium' },
  'bloomberg.com': { reputation: 87, category: 'news', tier: 'premium' },
  'bbc.com': { reputation: 89, category: 'news', tier: 'premium' },
  'economist.com': { reputation: 88, category: 'news', tier: 'premium' },
  'ft.com': { reputation: 87, category: 'news', tier: 'premium' },
  'washingtonpost.com': { reputation: 86, category: 'news', tier: 'premium' },
  'theatlantic.com': { reputation: 84, category: 'news', tier: 'premium' },
  'cnn.com': { reputation: 80, category: 'news', tier: 'standard' },
  'foxnews.com': { reputation: 75, category: 'news', tier: 'standard' },
  'msnbc.com': { reputation: 78, category: 'news', tier: 'standard' },
  'huffpost.com': { reputation: 72, category: 'news', tier: 'standard' },
  
  // Academic and educational
  '.edu': { reputation: 93, category: 'educational', tier: 'premium' },
  'scholar.google.com': { reputation: 95, category: 'educational', tier: 'premium' },
  'jstor.org': { reputation: 94, category: 'educational', tier: 'premium' },
  'researchgate.net': { reputation: 88, category: 'educational', tier: 'premium' },
  'academia.edu': { reputation: 87, category: 'educational', tier: 'premium' },
  'sciencedirect.com': { reputation: 93, category: 'educational', tier: 'premium' },
  'nature.com': { reputation: 95, category: 'educational', tier: 'premium' },
  'science.org': { reputation: 95, category: 'educational', tier: 'premium' },
  'ieee.org': { reputation: 92, category: 'educational', tier: 'premium' },
  'acm.org': { reputation: 92, category: 'educational', tier: 'premium' },
  'mitopencourseware.org': { reputation: 93, category: 'educational', tier: 'premium' },
  
  // Government
  '.gov': { reputation: 92, category: 'government', tier: 'premium' },
  'whitehouse.gov': { reputation: 90, category: 'government', tier: 'premium' },
  'congress.gov': { reputation: 91, category: 'government', tier: 'premium' },
  'nasa.gov': { reputation: 95, category: 'government', tier: 'premium' },
  'nih.gov': { reputation: 94, category: 'government', tier: 'premium' },
  'cdc.gov': { reputation: 93, category: 'government', tier: 'premium' },
  'un.org': { reputation: 90, category: 'government', tier: 'premium' },
  'europa.eu': { reputation: 89, category: 'government', tier: 'premium' },
  'who.int': { reputation: 88, category: 'government', tier: 'premium' },
  
  // Non-profit organizations
  '.org': { reputation: 82, category: 'organization', tier: 'standard' },
  'wikipedia.org': { reputation: 85, category: 'organization', tier: 'standard' },
  'amnesty.org': { reputation: 86, category: 'organization', tier: 'standard' },
  'redcross.org': { reputation: 88, category: 'organization', tier: 'standard' },
  'unicef.org': { reputation: 89, category: 'organization', tier: 'standard' },
  'oxfam.org': { reputation: 85, category: 'organization', tier: 'standard' },
  'greenpeace.org': { reputation: 83, category: 'organization', tier: 'standard' },
  'worldwildlife.org': { reputation: 85, category: 'organization', tier: 'standard' },
  
  // Tech and business
  'techcrunch.com': { reputation: 84, category: 'tech', tier: 'standard' },
  'wired.com': { reputation: 83, category: 'tech', tier: 'standard' },
  'theverge.com': { reputation: 82, category: 'tech', tier: 'standard' },
  'cnet.com': { reputation: 80, category: 'tech', tier: 'standard' },
  'zdnet.com': { reputation: 81, category: 'tech', tier: 'standard' },
  'forbes.com': { reputation: 84, category: 'business', tier: 'standard' },
  'marketwatch.com': { reputation: 85, category: 'business', tier: 'standard' },
  'businessinsider.com': { reputation: 82, category: 'business', tier: 'standard' },
  'hbr.org': { reputation: 89, category: 'business', tier: 'premium' },
  
  // Blogs, social media, and user-generated content
  'medium.com': { reputation: 75, category: 'blog', tier: 'standard' },
  'substack.com': { reputation: 73, category: 'blog', tier: 'standard' },
  'wordpress.com': { reputation: 70, category: 'blog', tier: 'standard' },
  'blogger.com': { reputation: 65, category: 'blog', tier: 'basic' },
  'tumblr.com': { reputation: 60, category: 'blog', tier: 'basic' },
  'twitter.com': { reputation: 60, category: 'social', tier: 'basic' },
  'facebook.com': { reputation: 55, category: 'social', tier: 'basic' },
  'reddit.com': { reputation: 65, category: 'social', tier: 'basic' },
  'linkedin.com': { reputation: 75, category: 'social', tier: 'standard' },
  'quora.com': { reputation: 70, category: 'social', tier: 'basic' },
  'stackoverflow.com': { reputation: 80, category: 'social', tier: 'standard' },
  'github.com': { reputation: 85, category: 'tech', tier: 'standard' }
};

/**
 * Score the reputation of a source based on URL and metadata
 * @param {Object} source Source object with url and metadata
 * @param {Object} options Scoring options
 * @returns {Object} Reputation score and metadata
 */
export const scoreSourceReputation = (source, options = {}) => {
  if (!source || !source.url) {
    return {
      score: 70,
      tier: 'unknown',
      category: 'unknown',
      confidence: 'low'
    };
  }
  
  try {
    const url = source.url.toLowerCase();
    let domainMatch = null;
    let reputation = null;
    
    // Extract domain
    let domain = '';
    try {
      const urlObj = new URL(url);
      domain = urlObj.hostname;
    } catch (e) {
      // Couldn't parse URL, try to extract domain with regex
      const match = url.match(/^(?:https?:\/\/)?(?:[^@\n]+@)?(?:www\.)?([^:\/\n]+)/im);
      domain = match ? match[1] : url;
    }
    
    // Look for exact domain matches
    if (SOURCE_REPUTATION_DB[domain]) {
      reputation = SOURCE_REPUTATION_DB[domain];
      domainMatch = domain;
    } else {
      // Look for domain suffix matches
      for (const key in SOURCE_REPUTATION_DB) {
        if (key.startsWith('.') && domain.endsWith(key)) {
          reputation = SOURCE_REPUTATION_DB[key];
          domainMatch = key;
          break;
        } else if (domain.includes(key)) {
          reputation = SOURCE_REPUTATION_DB[key];
          domainMatch = key;
          break;
        }
      }
    }
    
    // Default reputation if not found
    if (!reputation) {
      reputation = {
        reputation: 65,
        category: domain.endsWith('.com') ? 'commercial' : 'unknown',
        tier: 'basic'
      };
    }
    
    // Apply age adjustment if available
    let ageAdjustment = 0;
    if (source.date) {
      const sourceDate = new Date(source.date);
      const now = new Date();
      const ageInYears = (now - sourceDate) / (1000 * 60 * 60 * 24 * 365);
      
      // Recency bonus/penalty
      if (ageInYears < 1) {
        ageAdjustment = 5; // Bonus for very recent sources
      } else if (ageInYears < 2) {
        ageAdjustment = 2; // Small bonus for recent sources
      } else if (ageInYears > 5) {
        ageAdjustment = -5; // Penalty for old sources
      } else if (ageInYears > 3) {
        ageAdjustment = -2; // Small penalty for older sources
      }
    }
    
    // Calculate final score with adjustments
    const finalScore = Math.min(100, Math.max(0, reputation.reputation + ageAdjustment));
    
    return {
      score: finalScore,
      tier: reputation.tier,
      category: reputation.category,
      domainMatched: domainMatch,
      confidence: domainMatch ? 'high' : 'medium',
      originalDomain: domain
    };
  } catch (err) {
    log.error('Error scoring source reputation:', err);
    return {
      score: 60,
      tier: 'unknown',
      category: 'unknown',
      confidence: 'low',
      error: err.message
    };
  }
};

/**
 * Get an icon or badge for the source based on reputation
 * @param {Object} reputationData Reputation data from scoreSourceReputation
 * @returns {Object} Icon/badge information
 */
export const getSourceBadge = (reputationData) => {
  if (!reputationData) {
    return {
      icon: '🔍',
      label: 'Unknown',
      color: '#999999'
    };
  }
  
  // Determine badge based on tier and score
  if (reputationData.tier === 'premium') {
    return {
      icon: '✓✓',
      label: 'Premium Source',
      color: '#4285F4', // Blue
      background: 'rgba(66, 133, 244, 0.14)'
    };
  }
  
  if (reputationData.tier === 'standard') {
    return {
      icon: '✓',
      label: 'Verified Source',
      color: '#0F9D58', // Green
      background: 'rgba(15, 157, 88, 0.14)'
    };
  }
  
  if (reputationData.tier === 'basic') {
    if (reputationData.score > 70) {
      return {
        icon: 'ℹ️',
        label: 'Informational Source',
        color: '#F4B400', // Yellow
        background: 'rgba(244, 180, 0, 0.16)'
      };
    } else {
      return {
        icon: '⚠️',
        label: 'Basic Source',
        color: '#DB4437', // Red
        background: 'rgba(219, 68, 55, 0.14)'
      };
    }
  }
  
  return {
    icon: '🔍',
    label: 'Uncategorized Source',
    color: '#999999',
    background: 'rgba(148, 163, 184, 0.16)'
  };
};

/**
 * Get recommended sources based on a query and existing sources
 * @param {string} query The search query
 * @param {Array} existingSources Existing sources that have been found
 * @returns {Array} Recommended additional sources
 */
export const getRecommendedSources = (query, existingSources = []) => {
  // This is a simplified implementation
  // A real implementation would use a more sophisticated algorithm
  
  // Extract domains from existing sources
  const existingDomains = new Set();
  existingSources.forEach(source => {
    if (source.url) {
      try {
        const domain = new URL(source.url).hostname;
        existingDomains.add(domain);
      } catch (e) {
        // Invalid URL, skip
      }
    }
  });
  
  // Priority domains based on query keywords
  const queryLower = query.toLowerCase();
  const recommendedDomains = [];
  
  // Academic sources
  if (queryLower.includes('research') || 
      queryLower.includes('study') || 
      queryLower.includes('academic') ||
      queryLower.includes('science')) {
    recommendedDomains.push(
      'scholar.google.com',
      'jstor.org',
      'sciencedirect.com',
      'researchgate.net'
    );
  }
  
  // News sources
  if (queryLower.includes('news') || 
      queryLower.includes('current') || 
      queryLower.includes('today') ||
      queryLower.includes('recent')) {
    recommendedDomains.push(
      'nytimes.com',
      'reuters.com',
      'bbc.com',
      'ap.org'
    );
  }
  
  // Health sources
  if (queryLower.includes('health') || 
      queryLower.includes('medical') || 
      queryLower.includes('disease') ||
      queryLower.includes('treatment')) {
    recommendedDomains.push(
      'nih.gov',
      'cdc.gov',
      'who.int',
      'mayoclinic.org'
    );
  }
  
  // Tech sources
  if (queryLower.includes('technology') || 
      queryLower.includes('software') || 
      queryLower.includes('app') ||
      queryLower.includes('digital')) {
    recommendedDomains.push(
      'techcrunch.com',
      'wired.com',
      'theverge.com',
      'github.com'
    );
  }
  
  // Business sources
  if (queryLower.includes('business') || 
      queryLower.includes('company') || 
      queryLower.includes('market') ||
      queryLower.includes('finance')) {
    recommendedDomains.push(
      'wsj.com',
      'bloomberg.com',
      'forbes.com',
      'hbr.org'
    );
  }
  
  // If no specific domains were found, add some general high-quality sources
  if (recommendedDomains.length === 0) {
    recommendedDomains.push(
      'wikipedia.org',
      'reuters.com',
      'nytimes.com'
    );
  }
  
  // Filter out domains that are already in the results
  const filteredDomains = recommendedDomains.filter(
    domain => !existingDomains.has(domain)
  );
  
  // Return recommended sources
  return filteredDomains.map(domain => {
    const reputation = SOURCE_REPUTATION_DB[domain] || {
      reputation: 80,
      category: 'general',
      tier: 'standard'
    };
    
    return {
      domain,
      title: domain.charAt(0).toUpperCase() + domain.slice(1).replace('.com', ''),
      reputation: reputation.reputation,
      category: reputation.category,
      tier: reputation.tier,
      recommended: true
    };
  });
};

export default {
  scoreSourceReputation,
  getSourceBadge,
  getRecommendedSources,
  SOURCE_REPUTATION_DB
};
