import { MODEL_ENDPOINTS } from '../../../utils/llmProcessing';

export default async function handler(req, res) {
  try {
    // Get model config info
    const modelConfig = {
      together: {
        endpoint: MODEL_ENDPOINTS['mixtral-8x7b']?.apiEndpoint || 'Not configured',
        model: MODEL_ENDPOINTS['mixtral-8x7b']?.apiModelName || 'Not configured'
      },
      perplexity: {
        endpoint: MODEL_ENDPOINTS['perplexity']?.apiEndpoint || 'Not configured',
        model: MODEL_ENDPOINTS['perplexity']?.apiModelName || 'Not configured'
      }
    };
    
    // Check Together API key
    const togetherApiKey = process.env.TOGETHER_API_KEY;
    const hasTogetherApiKey = !!(togetherApiKey && togetherApiKey !== 'your_together_api_key_here');
    
    // Check Perplexity API key
    const perplexityApiKey = process.env.PERPLEXITY_API_KEY;
    const hasPerplexityApiKey = !!(perplexityApiKey && perplexityApiKey !== 'your_perplexity_api_key_here');
    
    // Return status
    return res.status(200).json({
      apiKeys: {
        together: hasTogetherApiKey,
        togetherKeyLength: hasTogetherApiKey ? togetherApiKey.length : 0,
        perplexity: hasPerplexityApiKey,
        perplexityKeyLength: hasPerplexityApiKey ? perplexityApiKey.length : 0
      },
      env: {
        nodeEnv: process.env.NODE_ENV,
        hasEnvFile: !!process.env.NEXT_PUBLIC_SEARCH_API_URL
      },
      modelConfig
    });
  } catch (error) {
    console.error('Error in API status endpoint:', error);
    return res.status(200).json({
      status: 'fail-soft',
      apiKeys: {
        together: false,
        togetherKeyLength: 0,
        perplexity: false,
        perplexityKeyLength: 0
      },
      env: {
        nodeEnv: process.env.NODE_ENV || 'unknown',
        hasEnvFile: false
      },
      modelConfig: {
        together: { endpoint: 'Not configured', model: 'Not configured' },
        perplexity: { endpoint: 'Not configured', model: 'Not configured' }
      },
      error: 'Internal server error',
      message: error.message
    });
  }
}
