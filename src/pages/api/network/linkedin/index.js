/**
 * API endpoint to fetch and process LinkedIn network data for visualization
 */
import { fetchLinkedInProfile, fetchLinkedInGraph } from '../../../../utils/linkedinProfile';

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
    const profile = await fetchLinkedInProfile(accessToken, LINKEDIN_NETWORK_TIMEOUT_MS);

    const graph = await fetchLinkedInGraph(accessToken, profile, LINKEDIN_NETWORK_TIMEOUT_MS);

    // Combine user data with connections
    const result = {
      user: {
        id: profile.id,
        firstName: profile.firstName,
        lastName: profile.lastName,
        profilePicture: profile.picture,
        email: profile.email || ''
      },
      connections: (graph.nodes || []).filter(node => node.id !== 'user'),
      connectionsAvailable: Boolean(graph.connectionsAvailable),
      note: graph.note || null,
      networksData: graph // Full graph data for visualization
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
