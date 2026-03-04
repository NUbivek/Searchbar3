/**
 * API endpoint for LLM-powered network search queries
 */
import { TogetherAI } from 'together';

// Initialize Together AI client with API key from environment variables
const togetherClient = new TogetherAI({
  apiKey: process.env.TOGETHER_API_KEY || '',
});

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query, networkData, source } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'Search query is required' });
  }

  if (!networkData || !networkData.nodes) {
    return res.status(400).json({ error: 'Network data is required' });
  }

  if (!source || !['linkedin', 'twitter', 'facebook'].includes(source)) {
    return res.status(400).json({ error: 'Valid source is required (linkedin, twitter, or facebook)' });
  }

  const failSoft = (error, details = {}) => ({
    status: 'fail-soft',
    matches: [],
    summary: 'Unable to process network search with LLM right now.',
    relatedIndustries: [],
    suggestedConnections: [],
    degradedSources: ['network-llm'],
    error,
    ...details
  });

  try {
    // Prepare context for LLM from network data
    const networkContext = prepareNetworkContext(networkData, source);
    
    // Create prompt for LLM
    const prompt = `
You are a network analysis assistant that helps users search their social network connections.

USER QUERY: "${query}"

SOURCE NETWORK: ${source}

NETWORK DATA:
${networkContext}

TASK:
Analyze the network data above and find connections that best match the user's query.
Return ONLY a JSON response in the following format:

{
  "matches": [
    {
      "id": "ID of the matching node",
      "name": "Name of the connection",
      "relevance": "High, Medium, or Low",
      "reasoning": "Brief explanation of why this connection matches the query"
    }
  ],
  "summary": "A concise summary of the findings (1-2 sentences)",
  "relatedIndustries": ["List of industries or fields relevant to the query"],
  "suggestedConnections": ["IDs of other connections that might be relevant"]
}

Be creative in understanding the user's intent. If they're looking for people in a specific industry, role, or with certain skills, identify the most relevant matches.
`;

    // Call the LLM
    const response = await togetherClient.chat.completions.create({
      model: "meta-llama/Llama-3-70b-chat-hf",
      messages: [
        { 
          role: "system", 
          content: "You are an expert network analyzer that helps users find connections in their social networks. Always respond with valid JSON." 
        },
        { 
          role: "user", 
          content: prompt 
        }
      ],
      temperature: 0.2,
      response_format: { type: "json_object" }
    });

    // Parse the LLM response
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(response.choices[0].message.content);
    } catch (parseError) {
      console.error("Error parsing LLM response:", parseError);
      return res.status(200).json(failSoft('Failed to parse LLM response', {
        rawResponse: response.choices[0].message.content
      }));
    }

    // Add node data to matches for easy reference
    const enhancedMatches = parsedResponse.matches.map(match => {
      const node = networkData.nodes.find(n => n.id === match.id);
      return {
        ...match,
        nodeData: node || null
      };
    });

    // Return enhanced response
    return res.status(200).json({
      ...parsedResponse,
      matches: enhancedMatches
    });
  } catch (error) {
    console.error("Error processing network query with LLM:", error);
    return res.status(200).json(failSoft('An error occurred while processing your query', {
      details: error.message
    }));
  }
}

/**
 * Prepare network data as context for the LLM
 * @param {Object} networkData - Network data with nodes and links
 * @param {string} source - Network source
 * @returns {string} - Formatted network context
 */
function prepareNetworkContext(networkData, source) {
  // Get relevant nodes (exclude user node and limit to prevent context overflow)
  const relevantNodes = networkData.nodes
    .filter(node => node.id !== 'user' && !node.type)
    .slice(0, 50); // Limit to 50 nodes to prevent context overflow
  
  // Format based on source
  switch (source) {
    case 'linkedin':
      return relevantNodes.map((node, index) => `
Connection ${index + 1}:
ID: ${node.id}
Name: ${node.name}
${node.degree ? `Degree: ${node.degree}` : ''}
${node.company ? `Company: ${node.company}` : ''}
${node.position ? `Position: ${node.position}` : ''}
${node.location ? `Location: ${node.location}` : ''}
`).join('\n');

    case 'twitter':
      return relevantNodes.map((node, index) => `
User ${index + 1}:
ID: ${node.id}
Name: ${node.name}
${node.handle ? `Handle: ${node.handle}` : ''}
${node.followers ? `Followers: ${node.followers}` : ''}
${node.interests ? `Interests: ${node.interests.join(', ')}` : ''}
`).join('\n');

    case 'facebook':
      return relevantNodes.map((node, index) => `
Friend ${index + 1}:
ID: ${node.id}
Name: ${node.name}
${node.group ? `Group: ${node.group}` : ''}
${node.mutualFriends ? `Mutual Friends: ${node.mutualFriends}` : ''}
`).join('\n');

    default:
      return relevantNodes.map((node, index) => `
Node ${index + 1}:
ID: ${node.id}
Name: ${node.name}
${Object.entries(node)
  .filter(([key]) => !['id', 'name', 'val', 'color', 'image'].includes(key))
  .map(([key, value]) => `${key.charAt(0).toUpperCase() + key.slice(1)}: ${value}`)
  .join('\n')}
`).join('\n');
  }
}
