/**
 * Testing API endpoint for directly calling LLM models
 * Used to verify configuration with Together.ai
 */
import { processWithLLM } from '../../../utils/llmProcessing';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { query, modelId = 'mistral-7b' } = req.body;
    
    if (!query) {
      return res.status(400).json({ 
        error: 'Missing required parameters',
        message: 'The query parameter is required' 
      });
    }
    
    // Create a simple mock result to process with LLM
    const mockResults = [
      {
        title: 'Test Result',
        snippet: 'This is a test result for LLM processing',
        url: 'https://example.com/test'
      }
    ];
    
    console.log(`Testing LLM direct processing with model: ${modelId}`);
    console.log(`API Key from env: ${process.env.TOGETHER_API_KEY ? 'Present' : 'Missing'} (${process.env.TOGETHER_API_KEY?.length || 0} chars)`);
    
    // Process with LLM
    const llmResponse = await processWithLLM(
      mockResults,
      query,
      modelId,
      {
        apiKey: process.env.TOGETHER_API_KEY,
        forceLLM: true,
        debug: true
      }
    );
    
    // Add flags to ensure proper detection
    const result = {
      ...llmResponse,
      __isImmutableLLMResult: true,
      isLLMResult: true,
      llmProcessed: true,
      query: query,
      modelId: modelId,
      testEndpoint: true
    };
    
    return res.status(200).json(result);
  } catch (error) {
    console.error('LLM test error:', error);
    return res.status(200).json({
      status: 'fail-soft',
      degradedSources: ['llm-test'],
      error: 'Failed to test LLM processing',
      message: error.message,
      isError: true,
      __isImmutableLLMResult: true,
      errorType: error.code || 'unknown_error'
    });
  }
}
