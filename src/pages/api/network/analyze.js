/**
 * Network Analysis API
 * Processes natural language queries for network data using LLM
 */
import { processNetworkQuery, generateIndustryClassification } from '../../../utils/networkLLMUtils';

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Get query and network data from request body
  const { query, networkData } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  if (!networkData || (!networkData.connections && !networkData.networksData)) {
    return res.status(400).json({ error: 'Network data is required' });
  }

  const failSoft = (details) => ({
    status: 'fail-soft',
    matches: [],
    filteredConnections: [],
    summary: 'Network analysis is temporarily unavailable.',
    responseText: `Could not process network analysis for "${query}" right now.`,
    degradedSources: ['network-analyze'],
    error: 'Failed to process network analysis',
    details
  });

  try {
    console.log('Processing network analysis query:', query);
    
    // Prepare data for processing - format it appropriately
    const processableData = {
      nodes: [
        // Add the user as the central node
        {
          id: 'user',
          name: networkData.user?.firstName || networkData.twitterUser?.username || 'You',
          type: 'user'
        },
        // Add connections as nodes
        ...(networkData.connections || []).map(conn => ({
          id: conn.id || `connection_${Math.random().toString(36).substring(2, 10)}`,
          name: conn.firstName || conn.lastName || conn.name || 'Connection',
          company: conn.company || conn.organization || undefined,
          position: conn.position || conn.title || undefined,
          location: conn.location || undefined,
          source: conn.source || 'linkedin'
        }))
      ],
      links: []
    };
    
    // Add links between user and connections
    processableData.nodes.forEach(node => {
      if (node.id !== 'user') {
        processableData.links.push({
          source: 'user',
          target: node.id,
          type: node.source || 'connection'
        });
      }
    });
    
    // Determine primary source
    const source = networkData.linkedInConnected ? 'linkedin' : 
                  networkData.twitterConnected ? 'twitter' : 'generic';
    
    // Process the query with the LLM
    const result = await processNetworkQuery(query, processableData, source);
    
    // If we got results, prepare filtered connections for visualization
    if (result.matches && result.matches.length > 0) {
      // Get matched connection IDs
      const matchedIds = result.matches.map(match => match.id);
      
      // Filter connections that match
      const filteredConnections = networkData.connections
        .filter(conn => {
          const connectionId = conn.id || '';
          return matchedIds.includes(connectionId);
        })
        .map(conn => {
          // Find the match data for this connection
          const matchData = result.matches.find(match => match.id === conn.id);
          
          // Add match data to connection
          return {
            ...conn,
            relevance: matchData?.relevance || 'Medium',
            reasoning: matchData?.reasoning || '',
            category: matchData?.industry || ''
          };
        });
      
      result.filteredConnections = filteredConnections;
    }
    
    // Add helpful response text for the user
    if (result.matches && result.matches.length > 0) {
      result.responseText = `Found ${result.matches.length} connections matching your search: "${query}"`;
    } else {
      result.responseText = `No connections found matching your search: "${query}"`;
    }
    
    console.log('Network analysis complete with results:', {
      matchCount: result.matches?.length || 0,
      filteredConnectionsCount: result.filteredConnections?.length || 0,
      summary: result.summary
    });
    
    return res.status(200).json(result);
  } catch (error) {
    console.error('Error processing network analysis:', error);
    return res.status(200).json(failSoft(error.message));
  }
}
