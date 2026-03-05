/**
 * Network LLM Utilities
 * Functions for processing network data with LLM for natural language search
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

/**
 * Process a natural language query against network data using LLM
 * @param {string} query - The natural language query
 * @param {Object} networkData - The network data object with nodes and links
 * @param {string} source - The source network (linkedin, twitter, facebook)
 * @returns {Promise<Object>} - Results with matched nodes and summary
 */
export async function processNetworkQuery(query, networkData, source) {
  if (!query || !networkData || !networkData.nodes) {
    return { matches: [], summary: "No data available to search." };
  }

  if (!process.env.TOGETHER_API_KEY || !togetherClient) {
    return buildHeuristicNetworkResponse(query, networkData);
  }

  try {
    // Prepare network data for LLM context
    const networkContext = prepareNetworkContext(networkData, source);
    
    // Create prompt for LLM
    const prompt = createNetworkSearchPrompt(query, networkContext, source);
    
    // Call the LLM
    const response = await togetherClient.chat.completions.create({
      model: "meta-llama/Llama-3-70b-chat-hf",
      messages: [
        {
          role: "system",
          content: `You are a network analysis assistant that helps users find relevant connections in their social networks. 
                   You'll receive network data and a query. Your task is to:
                   1. Find the most relevant matches to the query
                   2. Provide a brief summary of findings
                   3. Return a JSON response with matched profiles and reasoning
                   Be precise and helpful.`
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.2,
      response_format: { type: "json_object" }
    });

    // Parse LLM response
    const llmResponse = JSON.parse(response.choices[0].message.content);
    
    // Process the matches to include node references
    const processedMatches = processLLMMatches(llmResponse.matches || [], networkData);

    // Guard against generic internet-style summaries that are not network-specific.
    if (isOffTopicNetworkResponse(llmResponse, processedMatches)) {
      return buildHeuristicNetworkResponse(query, networkData, 'LLM response was not network-specific');
    }
    
    return {
      matches: processedMatches,
      summary: llmResponse.summary || "No results found for your query.",
      relatedIndustries: llmResponse.relatedIndustries || [],
      suggestedConnections: llmResponse.suggestedConnections || []
    };
  } catch (error) {
    console.error("Error processing network query with LLM:", error);
    return buildHeuristicNetworkResponse(query, networkData, error.message);
  }
}

function isOffTopicNetworkResponse(llmResponse, processedMatches) {
  const summary = String(llmResponse?.summary || '').toLowerCase();
  const content = String(llmResponse?.content || '').toLowerCase();
  const combined = `${summary}\n${content}`;

  const genericIndicators = [
    'provided search results',
    'no specific information',
    'refining your search',
    'search terms',
    'related topics',
    'detailed analysis',
    'follow-up questions'
  ];

  const hasGenericLanguage = genericIndicators.some((indicator) => combined.includes(indicator));
  const hasMatches = Array.isArray(processedMatches) && processedMatches.length > 0;

  return hasGenericLanguage && !hasMatches;
}

function buildHeuristicNetworkResponse(query, networkData, failureReason = null) {
  const queryTerms = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 2);

  const candidates = (networkData.nodes || []).filter((node) => node && node.id !== 'user');

  const matches = candidates
    .map((node) => {
      const haystack = [
        node.name,
        node.company,
        node.position,
        node.title,
        node.location,
        node.handle
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      const hitCount = queryTerms.length === 0
        ? 0
        : queryTerms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0);

      if (hitCount === 0 && queryTerms.length > 0) {
        return null;
      }

      const relevance = hitCount >= 2 ? 'High' : (hitCount === 1 ? 'Medium' : 'Low');
      return {
        id: node.id,
        name: node.name || 'Unknown',
        relevance,
        reasoning: hitCount > 0
          ? `Matched ${hitCount} query term${hitCount > 1 ? 's' : ''} in profile fields.`
          : 'Included as a broad fallback match.',
        nodeData: node
      };
    })
    .filter(Boolean)
    .slice(0, 25);

  const summary = matches.length > 0
    ? `Found ${matches.length} network connection${matches.length > 1 ? 's' : ''} using local fallback analysis.`
    : 'No matching connections found using local fallback analysis.';

  return {
    matches,
    summary,
    relatedIndustries: [],
    suggestedConnections: [],
    degradedSources: ['together-llm'],
    status: 'fail-soft',
    ...(failureReason ? { error: failureReason } : {})
  };
}

/**
 * Prepare network data as context for the LLM
 * @param {Object} networkData - Network data with nodes and links
 * @param {string} source - Network source
 * @returns {string} - Formatted network context
 */
function prepareNetworkContext(networkData, source) {
  let context = "";
  
  // Format depends on the source network
  switch (source) {
    case 'linkedin':
      context = formatLinkedInContext(networkData);
      break;
    case 'twitter':
      context = formatTwitterContext(networkData);
      break;
    case 'facebook':
      context = formatFacebookContext(networkData);
      break;
    default:
      context = formatGenericContext(networkData);
  }
  
  return context;
}

/**
 * Format LinkedIn network data
 * @param {Object} networkData - Network data
 * @returns {string} - Formatted context
 */
function formatLinkedInContext(networkData) {
  // Get connections data (exclude companies and user node)
  const connections = networkData.nodes.filter(node => 
    node.degree && node.id !== 'user' && !node.type
  );

  // Format each connection
  return connections.map((conn, index) => {
    return `Connection ${index + 1}:
Name: ${conn.name}
Degree: ${conn.degree}
Company: ${conn.company || 'N/A'}
Position: ${conn.position || 'N/A'}
Location: ${conn.location || 'N/A'}
ID: ${conn.id}
`;
  }).join('\n');
}

/**
 * Format Twitter network data
 * @param {Object} networkData - Network data
 * @returns {string} - Formatted context
 */
function formatTwitterContext(networkData) {
  // Get followers/following (exclude interest nodes and user node)
  const connections = networkData.nodes.filter(node => 
    !node.type && node.id !== 'user'
  );

  // Format each connection
  return connections.map((conn, index) => {
    return `User ${index + 1}:
Name: ${conn.name}
Handle: ${conn.handle || 'N/A'}
Followers: ${conn.followers || 'N/A'}
Following: ${conn.following || 'N/A'}
Interests: ${conn.interests ? conn.interests.join(', ') : 'N/A'}
ID: ${conn.id}
`;
  }).join('\n');
}

/**
 * Format Facebook network data
 * @param {Object} networkData - Network data
 * @returns {string} - Formatted context
 */
function formatFacebookContext(networkData) {
  // Get friends (exclude group nodes and user node)
  const connections = networkData.nodes.filter(node => 
    !node.type && node.id !== 'user'
  );

  // Format each connection
  return connections.map((conn, index) => {
    return `Friend ${index + 1}:
Name: ${conn.name}
Group: ${conn.group || 'N/A'}
Mutual Friends: ${conn.mutualFriends || 'N/A'}
ID: ${conn.id}
`;
  }).join('\n');
}

/**
 * Format generic network data
 * @param {Object} networkData - Network data
 * @returns {string} - Formatted context
 */
function formatGenericContext(networkData) {
  // Get all nodes except user
  const connections = networkData.nodes.filter(node => node.id !== 'user');

  // Format each node
  return connections.map((node, index) => {
    return `Node ${index + 1}:
Name: ${node.name}
Type: ${node.type || 'Person'}
${Object.entries(node)
  .filter(([key]) => !['id', 'name', 'type', 'val', 'color', 'image'].includes(key))
  .map(([key, value]) => `${key.charAt(0).toUpperCase() + key.slice(1)}: ${value}`)
  .join('\n')}
ID: ${node.id}
`;
  }).join('\n');
}

/**
 * Create a search prompt for the LLM
 * @param {string} query - User query
 * @param {string} networkContext - Formatted network data
 * @param {string} source - Network source
 * @returns {string} - Complete prompt
 */
function createNetworkSearchPrompt(query, networkContext, source) {
  return `
QUERY: ${query}

SOURCE NETWORK: ${source}

NETWORK DATA:
${networkContext}

INSTRUCTIONS:
1. Analyze the network data provided above.
2. Find connections that match the user's query: "${query}"
3. For industry-related queries, consider job titles, company names, and descriptions.
4. Return your response in the following JSON format:

{
  "matches": [
    {
      "id": "The ID of the matching connection",
      "name": "Name of the connection",
      "relevance": "High/Medium/Low",
      "reasoning": "Brief explanation of why this connection matches the query"
    }
  ],
  "summary": "A concise summary of the findings (1-2 sentences)",
  "relatedIndustries": ["List of industries relevant to the query"],
  "suggestedConnections": ["IDs of connections that might be relevant to follow up with"]
}

Be creative in understanding the user's intent. If they're looking for people in a specific industry, role, or with certain skills, identify the most relevant matches.
`;
}

/**
 * Process LLM matches to include node references
 * @param {Array} matches - Matches from LLM
 * @param {Object} networkData - Network data
 * @returns {Array} - Processed matches with node references
 */
function processLLMMatches(matches, networkData) {
  return matches.map(match => {
    // Find corresponding node
    const node = networkData.nodes.find(n => n.id === match.id);
    
    if (node) {
      return {
        ...match,
        nodeData: node
      };
    }
    
    return match;
  });
}

/**
 * Generate industry classification for network visualization
 * @param {Array} nodes - Network nodes
 * @returns {Object} - Industry classifications and node mappings
 */
export function generateIndustryClassification(nodes) {
  const industries = {
    'Technology': ['Software Engineer', 'Frontend Developer', 'Backend Developer', 'Data Scientist', 'DevOps', 'CTO', 'VP Engineering'],
    'Business': ['CEO', 'Product Manager', 'Business Analyst', 'Marketing Manager', 'Sales'],
    'Design': ['UX Designer', 'UI Designer', 'Graphic Designer'],
    'Finance': ['CFO', 'Financial Analyst', 'Accountant'],
    'Healthcare': ['Doctor', 'Nurse', 'Healthcare'],
    'Education': ['Teacher', 'Professor', 'Education'],
    'Media': ['Journalist', 'Content Creator', 'Media'],
    'Science': ['Scientist', 'Researcher', 'R&D'],
    'Other': []
  };
  
  const industryColors = {
    'Technology': '#3b82f6',
    'Business': '#10b981',
    'Design': '#f59e0b',
    'Finance': '#8b5cf6',
    'Healthcare': '#ef4444',
    'Education': '#6366f1',
    'Media': '#ec4899',
    'Science': '#06b6d4',
    'Other': '#6b7280'
  };
  
  const nodeIndustries = {};
  const industryNodes = {};
  
  // Initialize industry nodes
  Object.keys(industries).forEach(industry => {
    industryNodes[industry] = [];
  });
  
  // Classify nodes by industry
  nodes.forEach(node => {
    if (node.id === 'user' || node.type) return;
    
    let assigned = false;
    
    // Check position/title against industry keywords
    if (node.position) {
      for (const [industry, keywords] of Object.entries(industries)) {
        if (keywords.some(keyword => 
          node.position.toLowerCase().includes(keyword.toLowerCase()))) {
          nodeIndustries[node.id] = industry;
          industryNodes[industry].push(node.id);
          assigned = true;
          break;
        }
      }
    }
    
    // Check company against industry inference
    if (!assigned && node.company) {
      const techCompanies = ['Google', 'Microsoft', 'Amazon', 'Apple', 'Facebook', 'Twitter', 'LinkedIn', 'Netflix', 'Tesla'];
      
      if (techCompanies.includes(node.company)) {
        nodeIndustries[node.id] = 'Technology';
        industryNodes['Technology'].push(node.id);
        assigned = true;
      }
    }
    
    // Default to Other
    if (!assigned) {
      nodeIndustries[node.id] = 'Other';
      industryNodes['Other'].push(node.id);
    }
  });
  
  return {
    nodeIndustries,
    industryNodes,
    industries,
    industryColors
  };
}
