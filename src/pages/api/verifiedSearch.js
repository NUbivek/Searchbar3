/**
 * DEPRECATED: This endpoint is kept for backward compatibility only.
 * 
 * All functionality has been moved to the main search API.
 * A copy of this file has been archived in /src/archived/api/verifiedSearch.js
 * 
 * This endpoint now simply redirects all requests to the main search API
 * with the appropriate parameters.
 */
import { logger } from '../../utils/logger';

export default async function handler(req, res) {
  // Set proper headers
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { query, options = {} } = req.body;
    
    // Validate query
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Query is required' });
    }
    
    // Log information about the deprecated endpoint being used
    logger.warn('Deprecated verifiedSearch endpoint being used', { query });
    
    // Forward the request to the main search API endpoint
    const searchApiResponse = await fetch(`${req.headers.origin}/api/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...req.body,
        // Always set mode to verified for backward compatibility
        mode: 'verified',
        useLLM: true
      })
    });
    
    // Get the response from the main search API
    const searchResults = await searchApiResponse.json();
    
    logger.info('Successfully redirected from verifiedSearch to main search API');
    
    // Return the results in the expected format for backward compatibility
    return res.status(200).json({ results: searchResults });
    
  } catch (error) {
    logger.error('Simplified verified search error:', error);
    return res.status(200).json({
      results: [],
      status: 'fail-soft',
      degradedSources: ['verified-search-forwarder'],
      error: 'An error occurred in the simplified search handler',
      message: error.message
    });
  }
}
