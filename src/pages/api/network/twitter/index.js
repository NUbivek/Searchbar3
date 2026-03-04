/**
 * Twitter Network Data API
 * Fetches the user's Twitter network data
 */
import axios from 'axios';
import { parse } from 'cookie';

const TWITTER_NETWORK_TIMEOUT_MS = 10000;

export default async function handler(req, res) {
  // Get access token from cookies
  const cookies = parse(req.headers.cookie || '');
  const accessToken = cookies.twitter_access_token;

  if (!accessToken) {
    console.error('No Twitter access token found in cookies');
    return res.status(401).json({
      error: 'Authentication required',
      details: 'No Twitter access token found'
    });
  }

  try {
    console.log('Starting Twitter network data fetch');
    
    // Log partial token for debugging (only first few chars)
    const tokenPrefix = accessToken.slice(0, 6) + '...' + accessToken.slice(-4);
    console.log(`Using Twitter token: ${tokenPrefix}`);
    
    // Get user ID first with better error handling
    console.log('Fetching Twitter user data...');
    const userResponse = await axios.get('https://api.twitter.com/2/users/me', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      params: {
        'user.fields': 'username,profile_image_url,description'
      },
      timeout: TWITTER_NETWORK_TIMEOUT_MS,
    }).catch(error => {
      // Enhanced error logging
      console.error('Twitter API user.me call failed:', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        message: error.message
      });
      throw error; // Re-throw for outer catch
    });
    
    console.log('Twitter user data fetch successful');
    const userData = userResponse.data.data;
    
    if (!userData) {
      console.error('Twitter API returned success but no user data');
      return res.status(200).json({
        status: 'fail-soft',
        user: null,
        networksData: { nodes: [], links: [] },
        degradedSources: ['twitter-network'],
        error: 'Missing user data in Twitter API response'
      });
    }
    
    // Generate visualization-ready data
    const nodes = [];
    const links = [];
    
    // Add the user as the central node
    nodes.push({
      id: 'user',
      name: userData.username || 'You',
      type: 'user',
      image: userData.profile_image_url,
      data: userData
    });
    
    // Add some placeholder nodes for visualization
    for (let i = 1; i <= 5; i++) {
      const id = `twitter_contact_${i}`;
      nodes.push({
        id,
        name: `Twitter Contact ${i}`,
        type: 'twitter',
        image: 'https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png'
      });
      
      // Link to the central user
      links.push({
        source: 'user',
        target: id,
        type: 'twitter'
      });
    }
    
    const networkData = {
      user: userData,
      // Return in the format expected by the frontend visualization component
      networksData: {
        nodes,
        links
      }
    };

    console.log('Sending Twitter network data:', networkData);
    return res.status(200).json(networkData);

  } catch (error) {
    // Enhanced error handling with more details
    console.error('Error fetching Twitter network data:', {
      message: error.message,
      stack: error.stack?.split('\n')[0],
      response: {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data
      }
    });
    
    // Check for token expired error
    if (error.response?.status === 401) {
      return res.status(401).json({
        error: 'Authentication error',
        details: 'Twitter token expired or invalid',
        tokenExpired: true
      });
    }
    
    // Specific error for rate limiting
    if (error.response?.status === 429) {
      return res.status(429).json({
        error: 'Twitter API rate limit exceeded',
        details: 'Too many requests. Please try again later.',
        retryAfter: error.response.headers?.['retry-after'] || 60
      });
    }
    
    // For any other errors
    return res.status(200).json({
      status: 'fail-soft',
      user: null,
      networksData: { nodes: [], links: [] },
      degradedSources: ['twitter-network'],
      error: 'Failed to fetch Twitter network data',
      details: error.response?.data?.error || error.message,
      errorData: JSON.stringify(error.response?.data || {})
    });
  }
}
