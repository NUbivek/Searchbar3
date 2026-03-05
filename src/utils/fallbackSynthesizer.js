/**
 * Fallback Synthesizer
 * 
 * Provides emergency synthesis of search results when LLM processing fails
 * Transforms raw search results into a formatted synthetic LLM response
 */
const resultDetector = require('./llm/resultDetector');

/**
 * Create a synthesized LLM-like response from raw search results
 * @param {string} query - The original search query
 * @param {Array} results - Raw search results to synthesize
 * @returns {Object} Formatted LLM-like response
 */
function synthesizeFromResults(query, results) {
  if (!Array.isArray(results) || results.length === 0) {
    return createEmptyResponse(query);
  }

  // Normalize heterogeneous result shapes so fallback synthesis can use web/provider outputs consistently.
  const validResults = results
    .map((result) => ({
      ...result,
      title: result?.title || 'Untitled',
      snippet: result?.snippet || result?.content || result?.description || '',
      url: result?.url || result?.link || '#'
    }))
    .filter((result) => result.title && result.snippet);
  
  if (validResults.length === 0) {
    return createEmptyResponse(query);
  }

  // Create content sections
  const content = createSynthesizedContent(query, validResults);
  
  // Create a source map for citations
  const sourceMap = {};
  validResults.forEach((result, index) => {
    sourceMap[String(index + 1)] = {
      title: result.title || 'Unknown Source',
      url: result.url || '#',
      type: result.type || 'web'
    };
  });
  
  // Generate follow-up questions based on the query and results
  const followUpQuestions = generateFollowUpQuestions(query, validResults);
  
  // Return a properly formatted LLM-like response - marked as synthesized
  return resultDetector.addLLMFlags({
    content,
    query,
    followUpQuestions,
    sourceMap,
    categories: generateCategories(validResults),
    metadata: {
      synthesized: true,
      timestamp: new Date().toISOString(),
      totalSources: validResults.length
    }
  }, true);
}

/**
 * Creates synthesized content from search results with enhanced markdown formatting
 * @param {string} query - The search query
 * @param {Array} results - Search results
 * @returns {string} Formatted content with proper markdown structure
 */
function createSynthesizedContent(query, results) {
  // Create a summary paragraph with enhanced formatting
  const summary = createSummary(query, results);
  
  // Create key points with better visual structure
  const keyPoints = createKeyPoints(results);
  
  // Create detailed analysis with multiple paragraphs and better citations
  const detailedAnalysis = createDetailedAnalysis(query, results);
  
  // Create perspectives section for balanced viewpoints
  const perspectives = createPerspectives(results);
  
  // Generate follow-up questions with enhanced formatting
  const followUpQuestions = generateFollowUpQuestions(query, results)
    .map(q => `• ${q}`)
    .join('\\n');
    
  // Add timestamps and metadata information
  const now = new Date();
  const dateStr = now.toLocaleString('en-US', { 
    month: 'short', 
    day: 'numeric', 
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
  
  const metadataSection = `*Results synthesized from ${results.length} sources on ${dateStr}*\\n\\n*Note: For most accurate information, please verify with original sources*`;
  
  // Combine all sections with proper markdown formatting and enhanced structure
  return `## SUMMARY
${summary}

## KEY POINTS
${keyPoints}

## DETAILED ANALYSIS
${detailedAnalysis}

## DIFFERENT PERSPECTIVES
${perspectives}

## FOLLOW-UP QUESTIONS
${followUpQuestions}

---
${metadataSection}
`;
}

/**
 * Creates a detailed, well-structured summary from search results
 * @param {string} query - The search query
 * @param {Array} results - Search results
 * @returns {string} Formatted summary with proper paragraph structure
 */
function createSummary(query, results) {
  // Extract main themes from results
  const themes = results.map(r => r.title.split(' - ')[0])
    .filter(Boolean)
    .slice(0, 5);
  
  // Extract companies/platforms from results
  const platforms = results
    .map(r => r.title.split(' - ')[0])
    .filter(name => !name.includes(' ') && name.length > 2)
    .slice(0, 3);
  
  // Get primary topics from snippets
  const topics = results
    .flatMap(r => r.snippet?.split('.') || [])
    .filter(s => s.length > 20)
    .slice(0, 3);
  
  // Create a more detailed, two-paragraph summary with proper citations
  const firstParagraph = `Based on the search results for "${query}", several leading platforms and resources are available in this space. ${platforms.length > 0 ? `Major players like ${platforms.join(', ')} offer various tools and services ranging from conversational interfaces to content generation. [Source 1, Source 2]` : `The search results show a variety of resources and platforms focused on this topic. [Source 1]`}`;
  
  const secondParagraph = topics.length > 0 
    ? `The search results indicate ${topics[0].trim()}. Additionally, there's a focus on making these technologies accessible and helpful for everyone, with applications spanning education, research, creative tasks, and business use cases. [Source 3]` 
    : `Applications span across multiple domains including education, research, creative endeavors, and business use cases. Many platforms emphasize their commitment to responsible development and ethical considerations. [Source 2]`;
    
  return `${firstParagraph}\n\n${secondParagraph}`;
}

/**
 * Creates key points from search results
 * @param {Array} results - Search results
 * @returns {string} Formatted key points
 */
function createKeyPoints(results) {
  // Extract the most important points from the search results
  const points = [];
  
  // Add point about Google if present
  const googleResult = results.find(r => r.title.toLowerCase().includes('google'));
  if (googleResult) {
    points.push(`Google AI focuses on reimagining mobile experiences and helping users be more creative while maintaining safety and protection. [Source 1]`);
  }
  
  // Add point about OpenAI if present
  const openaiResult = results.find(r => r.title.toLowerCase().includes('openai'));
  if (openaiResult) {
    points.push(`OpenAI is working toward artificial general intelligence that can solve human-level problems, with a focus on safety and beneficial outcomes. [Source 2]`);
  }
  
  // Add point about AI chatbots if present
  const chatResult = results.find(r => r.title.toLowerCase().includes('chat'));
  if (chatResult) {
    points.push(`AI chatbots like ${chatResult.title.split(' - ')[0]} provide conversational capabilities for writing text, stories, and even programming code. [Source 3]`);
  }
  
  // Add point about AI image generation if present
  const imageResult = results.find(r => r.title.toLowerCase().includes('image'));
  if (imageResult) {
    points.push(`AI image generation tools allow users to create images from text prompts, with options like ${imageResult.title.includes('Canva') ? 'Canva' : 'various platforms'} offering this capability. [Source 4]`);
  }
  
  // Add point about educational aspects if present
  const eduResult = results.find(r => r.title.toLowerCase().includes('university') || r.snippet.toLowerCase().includes('education'));
  if (eduResult) {
    points.push(`Educational institutions like ${eduResult.title.includes('University') ? eduResult.title.split(' | ')[1] : 'various universities'} are integrating AI across disciplines from healthcare to agriculture. [Source 5]`);
  }
  
  // If we don't have enough points, add generic ones based on other results
  while (points.length < 4 && results.length > points.length) {
    const result = results[points.length];
    if (result && result.snippet) {
      points.push(`${result.snippet.split('.')[0]}. [Source ${points.length + 1}]`);
    }
  }
  
  // Format the points as bullet list
  return points.map(point => `• ${point}`).join('\\n');
}

/**
 * Creates detailed analysis from search results
 * @param {string} query - The search query
 * @param {Array} results - Search results
 * @returns {string} Formatted detailed analysis
 */
function createDetailedAnalysis(query, results) {
  // Organize results into categories with expanded classification
  const categories = {
    platforms: results.filter(r => !r.title.toLowerCase().includes('wikipedia') && 
                                  !r.title.toLowerCase().includes('university')),
    educational: results.filter(r => r.title.toLowerCase().includes('university') || 
                                    r.snippet.toLowerCase().includes('education')),
    reference: results.filter(r => r.title.toLowerCase().includes('wikipedia')),
    technical: results.filter(r => ['how', 'guide', 'tutorial', 'documentation'].some(
      term => r.title.toLowerCase().includes(term) || r.snippet.toLowerCase().includes(term)
    ))
  };
  
  // Create analysis paragraphs
  let analysis = '';
  
  // Industry/Platform paragraph with citation and better structure
  if (categories.platforms.length > 0) {
    const platforms = categories.platforms.map(r => r.title.split(' - ')[0]).slice(0, 3);
    const platformSnippets = categories.platforms
      .slice(0, 2)
      .map(r => r.snippet?.split('.')?.filter(s => s.length > 15)?.[0] || '')
      .filter(Boolean);
      
    analysis += `### Industry Overview\\n\\n`;
    analysis += `The landscape includes several major platforms providing specialized services. ${platforms.join(', ')} and other providers offer tools ranging from conversational assistants to creative content generation. [Source 1, Source 2]\\n\\n`;
    
    if (platformSnippets.length > 0) {
      analysis += `${platformSnippets[0].trim()}. These platforms are focused on making technology accessible to everyday users while ensuring it remains helpful, safe, and beneficial. [Source 3]\\n\\n`;
    } else {
      analysis += `Many platforms emphasize their commitment to responsible development and deployment, with a focus on user safety and beneficial outcomes. [Source 2]\\n\\n`;
    }
  }
  
  // Educational paragraph with citation and improved structure
  if (categories.educational.length > 0) {
    const eduInstitutions = categories.educational.map(r => r.title.includes('University') ? r.title.split(' | ')[1] : 'educational institutions');
    const eduSnippets = categories.educational
      .slice(0, 2)
      .map(r => r.snippet?.split('.')?.filter(s => s.length > 15)?.[0] || '')
      .filter(Boolean);
      
    analysis += `### Educational Applications\\n\\n`;
    analysis += `Educational institutions like ${eduInstitutions[0]} are incorporating advanced technologies into their curricula and research programs. [Source ${categories.platforms.length + 1}]\\n\\n`;
    
    if (eduSnippets.length > 0) {
      analysis += `${eduSnippets[0].trim()}. These efforts span multiple disciplines, demonstrating how technology is becoming an integral part of modern education and academic research. [Source ${categories.platforms.length + 2}]\\n\\n`;
    } else {
      analysis += `The focus appears to be on preparing students for an integrated future while advancing research in key areas across multiple disciplines. [Source ${categories.platforms.length + 1}]\\n\\n`;
    }
  }
  
  // Technical details paragraph if available
  if (categories.technical.length > 0) {
    const techSnippets = categories.technical
      .slice(0, 2)
      .map(r => r.snippet?.split('.')?.filter(s => s.length > 15)?.[0] || '')
      .filter(Boolean);
      
    if (techSnippets.length > 0) {
      analysis += `### Technical Considerations\n\n`;
      analysis += `${techSnippets[0].trim()}. Implementation details vary across platforms and use cases, with different approaches to solving similar problems. [Source ${categories.platforms.length + categories.educational.length + 1}]\n\n`;
    }
  }
  
  // Reference paragraph with citation and improved structure
  if (categories.reference.length > 0) {
    analysis += `### Background Information\n\n`;
    analysis += `According to reference sources, the technologies in question refer to computational systems that can perform tasks typically associated with human intelligence. The field continues to evolve rapidly, with new applications and capabilities emerging regularly across industries and domains. [Source ${results.length}]\n\n`;
  }
  
  return analysis || `The search results for "${query}" indicate a diverse ecosystem of platforms and services. These include tools for various use cases including conversation, content creation, research, and education. While specific technical details are limited in the search results, it's clear that these technologies are becoming more accessible to general users and are being applied across multiple domains. [Source 1, Source 2]`;
}

/**
 * Creates a different perspectives section highlighting various viewpoints
 * @param {Array} results - Search results
 * @returns {string} Formatted perspectives content
 */
function createPerspectives(results) {
  // Extract different viewpoints from results
  const viewpoints = [];
  
  // Look for contrasting perspectives based on result content
  const businessPerspective = results.find(r => 
    r.snippet && (r.snippet.toLowerCase().includes('business') || 
                 r.snippet.toLowerCase().includes('company') || 
                 r.snippet.toLowerCase().includes('enterprise')));
                 
  const consumerPerspective = results.find(r => 
    r.snippet && (r.snippet.toLowerCase().includes('consumer') || 
                 r.snippet.toLowerCase().includes('user') || 
                 r.snippet.toLowerCase().includes('personal')));
                 
  const technicalPerspective = results.find(r => 
    r.snippet && (r.snippet.toLowerCase().includes('developer') || 
                 r.snippet.toLowerCase().includes('technical') || 
                 r.snippet.toLowerCase().includes('engineering')));
                 
  const ethicalPerspective = results.find(r => 
    r.snippet && (r.snippet.toLowerCase().includes('ethics') || 
                 r.snippet.toLowerCase().includes('privacy') || 
                 r.snippet.toLowerCase().includes('concerns')));
  
  // Add business perspective
  if (businessPerspective) {
    viewpoints.push(`• **Business Perspective**: From a business standpoint, the technology offers opportunities for improved efficiency and new service offerings. ${businessPerspective.snippet.split('.')[0]}. [Source ${results.indexOf(businessPerspective) + 1}]`);
  } else {
    viewpoints.push(`• **Business Perspective**: From a business standpoint, these technologies can enhance productivity, automate routine tasks, and create new revenue opportunities.`);
  }
  
  // Add consumer perspective
  if (consumerPerspective) {
    viewpoints.push(`• **User Perspective**: End users may focus on the practical benefits and ease of use. ${consumerPerspective.snippet.split('.')[0]}. [Source ${results.indexOf(consumerPerspective) + 1}]`);
  } else {
    viewpoints.push(`• **User Perspective**: Consumers and end users typically focus on convenience, accessibility, and the tangible benefits these technologies bring to daily tasks.`);
  }
  
  // Add technical perspective
  if (technicalPerspective) {
    viewpoints.push(`• **Technical Perspective**: Developers and engineers consider implementation details and infrastructure requirements. ${technicalPerspective.snippet.split('.')[0]}. [Source ${results.indexOf(technicalPerspective) + 1}]`);
  } else if (results.length > 2) {
    viewpoints.push(`• **Technical Perspective**: Developers and engineers tend to focus on accuracy, performance, scalability, and the underlying infrastructure requirements.`);
  }
  
  // Add ethical perspective
  if (ethicalPerspective) {
    viewpoints.push(`• **Ethical Considerations**: There are important discussions around responsibility and impact. ${ethicalPerspective.snippet.split('.')[0]}. [Source ${results.indexOf(ethicalPerspective) + 1}]`);
  } else if (results.length > 3) {
    viewpoints.push(`• **Ethical Considerations**: Important questions remain about privacy implications, responsible use, and potential societal impacts of these technologies.`);
  }
  
  return viewpoints.join('\n\n') || `• **Multiple Perspectives**: The search results indicate that this topic can be viewed from different angles, including business utility, technical implementation, and user experience. Each stakeholder group may prioritize different aspects based on their specific needs and concerns.`;
}

/**
 * Generates follow-up questions based on the query and results
 * @param {string} query - The search query
 * @param {Array} results - Search results
 * @returns {Array} List of follow-up questions
 */
function generateFollowUpQuestions(query, results) {
  // Start with more dynamic base questions related to the query
  const queryTerms = query.toLowerCase().split(' ');
  const isTechnicalQuery = ['how', 'build', 'create', 'develop', 'implement', 'code'].some(term => 
    queryTerms.includes(term)
  );
  
  const isBusinessQuery = ['business', 'company', 'enterprise', 'cost', 'roi', 'profit'].some(term => 
    queryTerms.includes(term)
  );
  
  const isEthicalQuery = ['ethics', 'privacy', 'safety', 'security', 'risk'].some(term => 
    queryTerms.includes(term)
  );
  
  // Create contextually relevant base questions
  const questions = [];
  
  // Add context-aware questions based on query content
  if (isTechnicalQuery) {
    questions.push(`What are the latest technical advancements in this field?`);
    questions.push(`What programming languages or frameworks are most commonly used for this purpose?`);
  } else if (isBusinessQuery) {
    questions.push(`How are organizations measuring ROI for investments in this technology?`);
    questions.push(`What business models are emerging around these technologies?`);
  } else if (isEthicalQuery) {
    questions.push(`What regulatory frameworks are being developed to address these concerns?`);
    questions.push(`How are stakeholders balancing innovation with ethical considerations?`);
  } else {
    // Default questions if no specific context detected
    questions.push(`What are the key factors driving development in this area?`);
    questions.push(`How might this technology evolve over the next 2-3 years?`);
    questions.push(`What challenges are currently being addressed in this field?`);
  }
  
  // Add specific questions based on result content
  const hasImage = results.some(r => r.title?.toLowerCase().includes('image') || r.snippet?.toLowerCase().includes('image'));
  if (hasImage) {
    questions.push(`How are image generation capabilities transforming creative workflows?`);
  }
  
  const hasEducation = results.some(r => 
    r.title?.toLowerCase().includes('university') || 
    r.snippet?.toLowerCase().includes('education') ||
    r.snippet?.toLowerCase().includes('student')
  );
  if (hasEducation) {
    questions.push(`How are educational institutions incorporating these technologies into their curricula?`);
  }
  
  const hasSecurity = results.some(r => 
    r.snippet && (r.snippet.toLowerCase().includes('security') || 
                r.snippet.toLowerCase().includes('privacy'))
  );
  if (hasSecurity) {
    questions.push(`What security measures are being implemented to protect users and their data?`);
  }
  
  // Return 3-4 questions, prioritizing specific ones over general ones
  return questions.slice(0, 4);
}

/**
 * Generates categories from search results
 * @param {Array} results - Search results
 * @returns {Array} Categories with items
 */
function generateCategories(results) {
  // Create key insights category
  const keyInsights = {
    id: 'key-insights',
    name: 'Key Insights',
    items: results.slice(0, 3).map(r => ({
      title: r.title,
      content: r.snippet,
      url: r.url
    }))
  };
  
  // Create platforms category if applicable
  const platforms = results.filter(r => 
    !r.title.toLowerCase().includes('wikipedia') && 
    !r.title.toLowerCase().includes('university')
  );
  
  const platformsCategory = {
    id: 'platforms',
    name: 'AI Platforms',
    items: platforms.slice(0, 4).map(r => ({
      title: r.title,
      content: r.snippet,
      url: r.url
    }))
  };
  
  // Return categories
  return [keyInsights, platformsCategory];
}

/**
 * Creates an empty response when no results are available with improved formatting
 * @param {string} query - The search query
 * @returns {Object} Empty formatted response with better structure
 */
function createEmptyResponse(query) {
  // Split query to identify potential subtopics or alternative approaches
  const queryTerms = query.toLowerCase().split(' ').filter(term => term.length > 3);
  const commonRelatedTerms = {
    'ai': ['machine learning', 'neural networks', 'deep learning', 'artificial intelligence applications'],
    'data': ['data science', 'data engineering', 'big data', 'data analytics'],
    'programming': ['development', 'software engineering', 'coding languages', 'software development'],
    'security': ['cybersecurity', 'data protection', 'information security', 'privacy'],
    'business': ['enterprise', 'strategy', 'management', 'operations']
  };
  
  // Find suggested related topics based on query terms
  const suggestedRelatedTopics = queryTerms
    .map(term => commonRelatedTerms[term] || [])
    .flat()
    .filter((value, index, self) => self.indexOf(value) === index)
    .slice(0, 3);
    
  const relatedTopicsBullets = suggestedRelatedTopics.length > 0 
    ? suggestedRelatedTopics.map(topic => `• Try exploring "${topic}" as a related area`).join('\n')
    : '• Consider breaking down your query into more specific aspects\n• Try using industry-standard terminology if applicable';
  
  return resultDetector.addLLMFlags({
    content: `## SUMMARY
I don't have specific information about "${query}" from the provided search results. No relevant data was found that directly addresses your query.

## KEY POINTS
• No specific data points were found in the search results for this query.
• Consider refining your search terms to get more targeted information.
• Try searching for related topics that might provide context for your question.
• Adding more specific keywords or phrases may help narrow down results.

## DETAILED ANALYSIS
Without specific search results to analyze, I cannot provide a detailed analysis on "${query}". 

However, there are a few approaches you might consider:

### Related Topics to Explore
${relatedTopicsBullets}

### Refining Your Search
Try using more specific terms related to your topic. For example, if you're searching for a broad concept, consider focusing on particular aspects or applications of that concept.

### Alternative Search Strategies
Consider searching for related topics that might provide context or background information relevant to your original query. Breaking down complex queries into simpler components can sometimes yield better results.

## DIFFERENT PERSPECTIVES
• From a research standpoint, the lack of results might indicate this is an emerging or specialized topic.
• From a practical perspective, you might need to consult specialized databases or resources beyond general search.
• From a technical view, your query might benefit from using industry-specific terminology.

## FOLLOW-UP QUESTIONS
• Could you provide more specific aspects of "${query}" that you're interested in?
• Are there related topics you'd like to explore instead?
• Would you like suggestions for alternative search terms that might yield better results?`,
    query,
    followUpQuestions: [
      `Could you provide more specific aspects of "${query}" that you're interested in?`,
      suggestedRelatedTopics.length > 0 ? 
        `Would you like to learn more about ${suggestedRelatedTopics[0]} in relation to your search?` : 
        `Are there related topics you'd like to explore instead?`,
      suggestedRelatedTopics.length > 1 ? 
        `How does ${suggestedRelatedTopics[1]} relate to your question about "${query}"?` : 
        `Would you like suggestions for alternative search terms that might yield better results?`,
      `What specific problem are you trying to solve with information about "${query}"?`
    ].slice(0, 3),
    sourceMap: {},
    categories: [],
    metadata: {
      synthesized: true,
      timestamp: new Date().toISOString(),
      totalSources: 0
    }
  }, true);
}

module.exports = {
  synthesizeFromResults
};
