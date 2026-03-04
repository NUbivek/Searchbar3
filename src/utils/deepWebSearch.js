import axios from 'axios';
import { load } from 'cheerio';
import { logger } from './logger';

// Enhanced Serper API search with retry logic
export async function deepWebSearch(query, options = {}) {
  const { 
    maxResults = 10, 
    maxRetries = 3, 
    initialBackoff = 1000, // 1 second
    apiKey = process.env.SERPER_API_KEY 
  } = options;

  // Validate inputs
  if (!query) {
    console.error('ERROR: No query provided for deep web search');
    return [];
  }

  if (!apiKey) {
    console.error('ERROR: No API key provided for Serper API');
    return [];
  }

  console.log(`DEBUG: Starting deep web search for query: "${query}"`);
  
  // Initialize retry counter and backoff time
  let retries = 0;
  let backoffTime = initialBackoff;
  
  while (retries <= maxRetries) {
    try {
      console.log(`DEBUG: Attempt ${retries + 1}/${maxRetries + 1} for Serper API search`);
      
      // Make the API request
      const response = await axios.post('https://google.serper.dev/search', 
        { 
          q: query,
          gl: 'us',
          hl: 'en',
          autocorrect: true
        },
        { 
          headers: { 
            'X-API-KEY': apiKey,
            'Content-Type': 'application/json'
          },
          timeout: 30000, // 30 second timeout for Serper API requests
          timeoutErrorMessage: 'Search request to Serper API timed out'
        }
      );
      
      // Process the response
      const results = processSerperResponse(response.data, query);
      console.log(`DEBUG: Successfully retrieved ${results.length} results from Serper API`);
      
      return results;
    } catch (error) {
      retries++;
      
      // Log the error with more details
      console.error(`ERROR: Serper API search failed (attempt ${retries}/${maxRetries + 1}):`, error.message);
      if (error.response) {
        console.error(`ERROR: Response status: ${error.response.status}`);
        console.error(`ERROR: Response data:`, JSON.stringify(error.response.data));
      }
      
      // If we've reached max retries, fail soft and return an empty result set
      if (retries > maxRetries) {
        console.error('ERROR: Max retries reached for Serper API search');
        return [];
      }
      
      // Otherwise, wait and retry with exponential backoff
      console.log(`DEBUG: Retrying in ${backoffTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoffTime));
      
      // Increase backoff time for next retry (exponential backoff)
      backoffTime *= 2;
    }
  }
}

// Process the Serper API response
function processSerperResponse(data, originalQuery) {
  const results = [];
  
  try {
    // Process organic results
    if (data.organic && Array.isArray(data.organic)) {
      data.organic.forEach(item => {
        results.push({
          title: item.title || 'Untitled',
          url: item.link || '',
          snippet: item.snippet || '',
          source: 'web',
          type: 'organic',
          relevanceScore: calculateRelevance(item, originalQuery)
        });
      });
    }
    
    // Process knowledge graph if available
    if (data.knowledgeGraph) {
      const kg = data.knowledgeGraph;
      results.push({
        title: kg.title || 'Knowledge Graph',
        url: kg.website || '',
        snippet: kg.description || '',
        source: 'knowledge_graph',
        type: 'knowledge_graph',
        relevanceScore: 0.95 // Knowledge graph is usually highly relevant
      });
    }
    
    // Process answer box if available
    if (data.answerBox) {
      const answer = data.answerBox;
      results.push({
        title: answer.title || 'Answer',
        url: answer.link || '',
        snippet: answer.answer || answer.snippet || '',
        source: 'answer_box',
        type: 'answer_box',
        relevanceScore: 0.98 // Answer box is usually the most relevant
      });
    }
    
    // Process related searches if available
    if (data.relatedSearches && Array.isArray(data.relatedSearches)) {
      data.relatedSearches.forEach(item => {
        results.push({
          title: `Related: ${item.query}`,
          url: '',
          snippet: `Related search query: ${item.query}`,
          source: 'related_search',
          type: 'related_search',
          relevanceScore: 0.7
        });
      });
    }
    
    // Sort by relevance
    return results.sort((a, b) => b.relevanceScore - a.relevanceScore);
  } catch (error) {
    console.error('ERROR: Failed to process Serper API response:', error);
    
    // Return any results we managed to extract before the error
    if (results.length > 0) {
      console.log(`DEBUG: Returning ${results.length} partial results despite processing error`);
      return results;
    }
    
    // If we couldn't extract any results, fail soft
    return [];
  }
}

// Calculate relevance score based on result content and query
function calculateRelevance(result, query) {
  let score = 0.8; // Base score
  
  // Ensure query is a string before proceeding
  if (!query || typeof query !== 'string') {
    return score; // Return base score if query is invalid
  }
  
  const queryTerms = query.toLowerCase().split(/\s+/);
  
  // Check title for query terms
  if (result.title) {
    const titleLower = result.title.toLowerCase();
    queryTerms.forEach(term => {
      if (titleLower.includes(term)) {
        score += 0.05;
      }
    });
  }
  
  // Check snippet for query terms
  if (result.snippet) {
    const snippetLower = result.snippet.toLowerCase();
    queryTerms.forEach(term => {
      if (snippetLower.includes(term)) {
        score += 0.03;
      }
    });
  }
  
  // Adjust score based on position (if available)
  if (result.position) {
    score -= (result.position * 0.01); // Lower position is better
  }
  
  // Cap the score at 0.99
  return Math.min(score, 0.99);
}
