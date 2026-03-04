import { API_CONFIG, MODEL_CONFIGS } from '../../config/api-config';
import axios from 'axios';

const PROCESS_RESULTS_TIMEOUT_MS = 15000;

const processWithPerplexity = async (results, modelConfig) => {
  const response = await axios.post(
    `${API_CONFIG.PERPLEXITY.BASE_URL}/chat/completions`,
    {
      model: modelConfig.model,
      messages: [
        {
          role: "system",
          content: "Analyze and organize the search results into categories. Include source links and extract key information."
        },
        {
          role: "user",
          content: JSON.stringify(results)
        }
      ],
      temperature: modelConfig.temperature
    },
    {
      headers: {
        'Authorization': `Bearer ${API_CONFIG.PERPLEXITY.API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: PROCESS_RESULTS_TIMEOUT_MS,
    }
  );
  
  return response.data;
};

const processWithTogether = async (results, modelConfig) => {
  const response = await axios.post(
    `${API_CONFIG.TOGETHER.BASE_URL}/v1/completions`,
    {
      model: modelConfig.model,
      prompt: `Analyze and organize these search results into categories. Include source links and extract key information: ${JSON.stringify(results)}`,
      temperature: modelConfig.temperature,
      max_tokens: 1000
    },
    {
      headers: {
        'Authorization': `Bearer ${API_CONFIG.TOGETHER.API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: PROCESS_RESULTS_TIMEOUT_MS,
    }
  );
  
  return response.data;
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { results, model } = req.body;
  
  try {
    const modelConfig = MODEL_CONFIGS[model];
    if (!modelConfig) {
      return res.status(200).json({
        status: 'fail-soft',
        categories: {},
        sources: {},
        followUpQuestions: [],
        raw: null,
        degradedSources: ['result-processor'],
        error: 'Invalid model selected'
      });
    }

    let processedResults;
    if (modelConfig.provider === 'PERPLEXITY') {
      processedResults = await processWithPerplexity(results, modelConfig);
    } else if (modelConfig.provider === 'TOGETHER') {
      processedResults = await processWithTogether(results, modelConfig);
    }

    // Organize results into a consistent format
    const organizedResults = {
      categories: {},
      sources: {},
      followUpQuestions: [],
      raw: processedResults
    };

    return res.status(200).json(organizedResults);
  } catch (error) {
    console.error('Processing error:', error);
    return res.status(200).json({
      status: 'fail-soft',
      categories: {},
      sources: {},
      followUpQuestions: [],
      raw: null,
      degradedSources: ['result-processor'],
      error: error.message
    });
  }
}
