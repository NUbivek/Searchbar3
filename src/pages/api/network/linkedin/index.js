/**
 * API endpoint to fetch and process LinkedIn network data for visualization
 */
import axios from 'axios';

const LINKEDIN_NETWORK_TIMEOUT_MS = 10000;

export default async function handler(req, res) {
  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get LinkedIn access token from cookies
  const { cookies } = req;
  const accessToken = cookies.linkedin_access_token;

  if (!accessToken) {
    return res.status(401).json({ error: 'Not authenticated with LinkedIn' });
  }

  try {
    // Fetch user profile
    const profileResponse = await axios.get('https://api.linkedin.com/v2/me', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      timeout: LINKEDIN_NETWORK_TIMEOUT_MS,
    });

    const userData = profileResponse.data;

    // Fetch email address
    const emailResponse = await axios.get('https://api.linkedin.com/v2/emailAddress?q=members&projection=(elements*(handle~))', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      timeout: LINKEDIN_NETWORK_TIMEOUT_MS,
    });

    const userEmail = emailResponse.data.elements?.[0]?.['handle~']?.emailAddress || '';

    // Fetch connections using our existing endpoint
    const connectionsResponse = await axios.get(
      `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3002'}/api/network/linkedin/connections`,
      {
        headers: {
          Cookie: req.headers.cookie // Pass the cookies for authentication
        },
        timeout: LINKEDIN_NETWORK_TIMEOUT_MS,
      }
    );

    // Combine user data with connections
    const result = {
      user: {
        id: userData.id,
        firstName: userData.localizedFirstName,
        lastName: userData.localizedLastName,
        profilePicture: userData.profilePicture?.displayImage,
        email: userEmail
      },
      connections: connectionsResponse.data.nodes.filter(node => node.id !== 'user'),
      networksData: connectionsResponse.data // Full graph data for visualization
    };

    return res.status(200).json(result);
  } catch (error) {
    console.error('Error fetching LinkedIn network data:', error.response?.data || error.message);
    
    // Check if error is due to expired token
    if (error.response?.status === 401) {
      return res.status(401).json({ error: 'LinkedIn session expired, please reconnect' });
    }
    
    return res.status(200).json({
      status: 'fail-soft',
      user: null,
      connections: [],
      networksData: { nodes: [], links: [] },
      degradedSources: ['linkedin-network'],
      error: 'Failed to fetch LinkedIn network data',
      details: error.message
    });
  }
}
