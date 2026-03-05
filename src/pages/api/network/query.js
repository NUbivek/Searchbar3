/**
 * API endpoint for processing natural language queries on network data
 */
import Together from 'together';

function resolveTogetherConstructor(pkg) {
  if (typeof pkg === 'function') return pkg;
  if (pkg && typeof pkg.default === 'function') return pkg.default;
  if (pkg && typeof pkg.TogetherAI === 'function') return pkg.TogetherAI;
  if (pkg && pkg.default && typeof pkg.default.TogetherAI === 'function') {
    return pkg.default.TogetherAI;
  }
  return null;
}

const TogetherCtor = resolveTogetherConstructor(Together);
const togetherClient = TogetherCtor
  ? new TogetherCtor({ apiKey: process.env.TOGETHER_API_KEY || '' })
  : null;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query, networkData, source } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  if (!networkData || !networkData.nodes) {
    return res.status(400).json({ error: 'Valid network data is required' });
  }

  if (!source || !['linkedin', 'twitter', 'facebook'].includes(source)) {
    return res.status(400).json({ error: 'Valid source is required (linkedin, twitter, or facebook)' });
  }

  const failSoft = (error, details = {}) => ({
    status: 'fail-soft',
    matches: [],
    summary: 'Unable to process network query with LLM right now.',
    relatedIndustries: [],
    suggestedConnections: [],
    degradedSources: ['network-llm'],
    error,
    ...details
  });

  try {
    if (!togetherClient) {
      return res.status(200).json(failSoft('Together client unavailable', {
        details: 'Missing API key or invalid Together SDK import'
      }));
    }

    // Prepare context for LLM from network data
    const networkContext = prepareNetworkContext(networkData, source);
    
    // Create a prompt for the LLM
    const prompt = `
You are a network analysis assistant helping to find relevant connections in a user's ${source} network.

USER QUERY: "${query}"

NETWORK DATA:
${networkContext}

INSTRUCTIONS:
Analyze the network data above and find connections that best match the user's query.
Return your response in the following JSON format:

{
  "matches": [
    {
      "id": "connection_id",
      "name": "Connection Name",
      "relevance": "High/Medium/Low",
      "reasoning": "Brief explanation of why this connection matches the query"
    }
  ],
  "summary": "A concise summary of the findings",
  "relatedIndustries": ["List of industries or fields relevant to the query"],
  "suggestedConnections": ["IDs of other connections that might be relevant but didn't fully match"]
}
`;

    // Call the LLM
    const llmResponse = await togetherClient.chat.completions.create({
      model: "meta-llama/Llama-3-70b-chat-hf",
      messages: [
        {
          role: "system",
          content: "You are an expert network analysis assistant that helps users find relevant connections in their social networks. Return only valid JSON in your response."
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
      parsedResponse = JSON.parse(llmResponse.choices[0].message.content);
    } catch (parseError) {
      console.error("Error parsing LLM response:", parseError);
      return res.status(200).json(failSoft('Failed to parse LLM response', {
        rawResponse: llmResponse.choices[0].message.content
      }));
    }

    // Enhance response with node data for matches
    const enhancedMatches = parsedResponse.matches.map(match => {
      const node = networkData.nodes.find(n => n.id === match.id);
      return {
        ...match,
        nodeData: node || null
      };
    });

    // Return the enhanced response
    return res.status(200).json({
      ...parsedResponse,
      matches: enhancedMatches
    });
  } catch (error) {
    console.error("Error processing network query:", error);
    return res.status(200).json(failSoft('An error occurred while processing the network query', {
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
  // Filter out non-person nodes to keep context manageable
  const relevantNodes = networkData.nodes.filter(node => 
    node.id !== 'user' && !node.type
  );
  
  // Format each node based on the source network
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
