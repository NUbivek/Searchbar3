const axios = require('axios');
import { logger as log } from '../../../utils/logger';
import { generatePrompt } from '../../../utils/llmProcessing';

// Create a log object for consistent logging
const logger = log;
const LLM_PROVIDER_TIMEOUT_MS = 15000;

/**
 * Process content with LLM API
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 */
export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('DEBUG: About to process with LLM');
    
    // Extract request parameters
    const { query, sources, model = 'mixtral-8x7b' } = req.body;

    // Validate required parameters
    if (!query) {
      return res.status(400).json({ 
        categories: {
          key_insights: "No query was provided. Please enter a search query."
        },
        metrics: {
          relevance: 0,
          accuracy: 0,
          credibility: 0
        }
      });
    }

    // Format sources for LLM processing
    const validSources = Array.isArray(sources) ? sources.filter(source => source && typeof source === 'object') : [];
    
    // Handle case with no valid sources
    if (validSources.length === 0) {
      console.warn('No valid sources provided for LLM processing');
      return res.status(200).json({
        categories: {
          key_insights: `I couldn't find specific information about "${query}". Please try a different search query or provide more context.`
        },
        metrics: {
          relevance: 60,
          accuracy: 60,
          credibility: 60
        },
        followUpQuestions: [
          `Would you like to know more general information about ${query}?`,
          `Can I help you refine your search query?`,
          `Would you like to try a different approach to find information about ${query}?`
        ]
      });
    }
    
    // Generate the prompt for LLM processing
    const prompt = generatePrompt(query, validSources);
    console.log('DEBUG: Generated prompt for LLM processing');
    
    // Try the Together API first
    const togetherApiKey = process.env.TOGETHER_API_KEY;
    let togetherApiStatus = 'Not tested';
    let llmResponse = null;
    
    if (togetherApiKey) {
      try {
        console.log('DEBUG: Attempting to use Together API');
        
        const apiUrl = 'https://api.together.xyz/v1/completions';
        const requestData = {
          model: 'mistralai/Mistral-7B-v0.1',
          prompt: prompt,
          max_tokens: 1500,
          temperature: 0.7,
          top_p: 0.9,
          top_k: 50,
          repetition_penalty: 1.0,
          stop: ['</answer>', '</response>']
        };
        
        const headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${togetherApiKey}`
        };
        
        const response = await axios.post(apiUrl, requestData, {
          headers,
          timeout: LLM_PROVIDER_TIMEOUT_MS,
        });
        
        // Extract the content from the response
        const result = response.data.choices[0].text;
        console.log('DEBUG: Together API response received');
        
        // Try to parse JSON from the response
        try {
          // Look for JSON in the response
          const jsonMatch = result.match(/\{[\s\S]*\}/);
          
          if (jsonMatch) {
            llmResponse = JSON.parse(jsonMatch[0]);
            console.log('DEBUG: Successfully parsed JSON from Together API response');
            togetherApiStatus = 'Success';
          } else {
            // If no JSON is found, create a structured response
            llmResponse = {
              categories: {
                key_insights: result
              },
              metrics: {
                relevance: 80,
                accuracy: 75,
                credibility: 75
              }
            };
            console.log('DEBUG: No JSON found in Together API response, created structured response');
            togetherApiStatus = 'Success (raw text)';
          }
        } catch (parseError) {
          console.error('DEBUG: Failed to parse JSON from Together API response:', parseError.message);
          // Create a structured response
          llmResponse = {
            categories: {
              key_insights: result
            },
            metrics: {
              relevance: 75,
              accuracy: 70,
              credibility: 70
            }
          };
          togetherApiStatus = 'Success (parse error)';
        }
      } catch (togetherError) {
        console.error('DEBUG: Together API error:', togetherError.message);
        togetherApiStatus = `Error: ${togetherError.message}`;
        if (togetherError.response) {
          togetherApiStatus += ` (${togetherError.response.status})`;
        }
      }
    } else {
      togetherApiStatus = 'Missing API key';
    }
    
    // If Together API failed, try Perplexity API
    const perplexityApiKey = process.env.PERPLEXITY_API_KEY;
    let perplexityApiStatus = 'Not tested';
    
    if (!llmResponse && perplexityApiKey) {
      try {
        console.log('DEBUG: Attempting to use Perplexity API');
        
        const apiUrl = 'https://api.perplexity.ai/chat/completions';
        const requestData = {
          model: 'sonar-small-chat',
          messages: [
            {
              role: 'system',
              content: 'You are a helpful research assistant that provides accurate information based on search results.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          max_tokens: 2048,
          temperature: 0.7
        };
        
        const headers = {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${perplexityApiKey}`
        };
        
        const response = await axios.post(apiUrl, requestData, {
          headers,
          timeout: LLM_PROVIDER_TIMEOUT_MS,
        });
        
        // Extract the content from the response
        const result = response.data.choices[0].message.content;
        console.log('DEBUG: Perplexity API response received');
        
        // Try to parse JSON from the response
        try {
          // Look for JSON in the response
          const jsonMatch = result.match(/\{[\s\S]*\}/);
          
          if (jsonMatch) {
            llmResponse = JSON.parse(jsonMatch[0]);
            console.log('DEBUG: Successfully parsed JSON from Perplexity API response');
            perplexityApiStatus = 'Success';
          } else {
            // If no JSON is found, create a structured response
            llmResponse = {
              categories: {
                key_insights: result
              },
              metrics: {
                relevance: 80,
                accuracy: 75,
                credibility: 75
              }
            };
            console.log('DEBUG: No JSON found in Perplexity API response, created structured response');
            perplexityApiStatus = 'Success (raw text)';
          }
        } catch (parseError) {
          console.error('DEBUG: Failed to parse JSON from Perplexity API response:', parseError.message);
          // Create a structured response
          llmResponse = {
            categories: {
              key_insights: result
            },
            metrics: {
              relevance: 75,
              accuracy: 70,
              credibility: 70
            }
          };
          perplexityApiStatus = 'Success (parse error)';
        }
      } catch (perplexityError) {
        console.error('DEBUG: Perplexity API error:', perplexityError.message);
        perplexityApiStatus = `Error: ${perplexityError.message}`;
        if (perplexityError.response) {
          perplexityApiStatus += ` (${perplexityError.response.status})`;
        }
      }
    } else if (!llmResponse) {
      perplexityApiStatus = 'Missing API key';
    } else {
      perplexityApiStatus = 'Skipped (Together API succeeded)';
    }
    
    const failSoftResponse = (apiStatus, errorMessage = null) => ({
      status: 'fail-soft',
      categories: {
        key_insights: `I couldn't generate a model summary for "${query}" right now. Returning a safe fallback response.`
      },
      metrics: {
        relevance: 60,
        accuracy: 55,
        credibility: 55
      },
      followUpQuestions: [
        `Would you like a shorter summary for ${query}?`,
        `Should I retry this with fewer sources?`,
        `Do you want to continue with raw search results only?`
      ],
      apiStatus,
      error: errorMessage || null
    });

    // If both APIs failed, return fail-soft response
    if (!llmResponse) {
      console.warn('DEBUG: Both LLM APIs failed, returning error response');
      
      return res.status(200).json(
        failSoftResponse(
          {
            together: togetherApiStatus,
            perplexity: perplexityApiStatus
          },
          'Failed to process query with LLM APIs'
        )
      );
    }
    
    // Add API status information to the response
    llmResponse.apiStatus = {
      together: togetherApiStatus,
      perplexity: perplexityApiStatus
    };
    
    // Return the LLM response
    return res.status(200).json(llmResponse);
    
  } catch (error) {
    console.error('API handler error:', error);
    
    // Return a fail-soft response
    return res.status(200).json({ 
      status: 'fail-soft',
      categories: {
        key_insights: 'An internal error occurred while processing LLM output. Returning a safe fallback response.'
      },
      metrics: {
        relevance: 50,
        accuracy: 50,
        credibility: 50
      },
      followUpQuestions: [
        'Would you like to retry this query?',
        'Should I continue with search results only?'
      ],
      error: error.message,
      apiStatus: {
        together: `Error: ${error.message}`,
        perplexity: 'Not tested due to error'
      }
    });
  }
}
