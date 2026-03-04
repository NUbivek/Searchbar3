/**
 * API endpoint to fetch LinkedIn connections
 */
import axios from 'axios';

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
    // Fetch user profile first
    const profileResponse = await axios.get('https://api.linkedin.com/v2/me', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    const userData = profileResponse.data;

    // Fetch connections
    // Note: LinkedIn v2 API has limitations on connections data
    // This endpoint returns basic connection data (1st degree)
    const connectionsResponse = await axios.get(
      'https://api.linkedin.com/v2/connections?q=viewer&start=0&count=50',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    // Process the connections data into a format suitable for our graph
    const processedData = {
      nodes: [],
      links: []
    };

    // Add the user as the central node
    processedData.nodes.push({
      id: 'user',
      name: `${userData.localizedFirstName} ${userData.localizedLastName}`,
      val: 20, // Larger value for the user node
      color: '#0077B5', // LinkedIn blue
      image: userData.profilePicture?.displayImage || null,
      degree: 0,
      type: 'user'
    });

    // Process each connection and add to the graph data
    const hasRealConnections = connectionsResponse.data.elements && connectionsResponse.data.elements.length > 0;
    
    if (hasRealConnections) {
      connectionsResponse.data.elements.forEach((connection, index) => {
        const connectionId = `linkedin-${connection.miniProfile.id}`;
        
        // Add the connection as a node
        processedData.nodes.push({
          id: connectionId,
          name: `${connection.miniProfile.firstName} ${connection.miniProfile.lastName}`,
          company: connection.miniProfile.occupation || '',
          position: connection.miniProfile.title || '',
          location: connection.miniProfile.locationName || '',
          val: 10, // Standard size for connections
          color: '#0077B5', // LinkedIn blue
          image: connection.miniProfile.picture?.displayImage || null,
          degree: 1,
          source: 'linkedin',
          type: 'linkedin'
        });
        
        // Add a link from the user to this connection
        processedData.links.push({
          source: 'user',
          target: connectionId,
          value: 1
        });
      });
    }

    // Return the processed graph data
    // If no real connections were found, add some placeholder/simulated connections
    // This ensures we always show a visualization even if the LinkedIn API
    // doesn't return connections (which is often the case with their v2 API)
    if (!hasRealConnections) {
      // Generate 5 simulated connections with LinkedIn-like data
      for (let i = 1; i <= 5; i++) {
        const connectionId = `linkedin-simulated-${i}`;
        const positions = [
          'Software Engineer', 'Product Manager', 'Data Scientist', 'Marketing Specialist', 'CEO'
        ];
        const companies = [
          'Tech Company', 'Startup', 'Enterprise Inc.', 'Digital Solutions', 'AI Research'
        ];
        
        // Add the simulated connection
        processedData.nodes.push({
          id: connectionId,
          name: `LinkedIn Contact ${i}`,
          company: companies[i-1],
          position: positions[i-1],
          location: 'San Francisco, CA',
          val: 10,
          color: '#0077B5', // LinkedIn blue
          image: null,
          degree: 1,
          source: 'linkedin',
          type: 'linkedin',
          simulated: true // Flag to indicate this is simulated data
        });
        
        // Link to user
        processedData.links.push({
          source: 'user',
          target: connectionId,
          value: 1,
          color: '#0077B5',
          type: 'linkedin'
        });
      }
    }
    
    return res.status(200).json(processedData);
  } catch (error) {
    console.error('Error fetching LinkedIn connections:', error.response?.data || error.message);
    
    // Check if error is due to expired token
    if (error.response?.status === 401) {
      return res.status(401).json({ error: 'LinkedIn session expired, please reconnect' });
    }

    return res.status(200).json({
      status: 'fail-soft',
      nodes: [],
      links: [],
      degradedSources: ['linkedin-network'],
      error: 'Failed to fetch LinkedIn connections',
      details: error.message
    });
  }
}
