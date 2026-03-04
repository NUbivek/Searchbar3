import { logger } from '../../../utils/logger';

const SUPPORTED_MODELS = {
  'mistral-7b': {
    provider: 'together',
    model: 'mistralai/Mistral-7B-v0.1',
    temperature: 0.7,
    max_tokens: 800,
    top_p: 0.7,
    top_k: 50,
    repetition_penalty: 1,
    stop: ['</s>', '[/INST]']
  },
  'gemma-2-9b': {
    provider: 'together',
    model: 'google/gemma-2-9b-it',
    temperature: 0.7,
    max_tokens: 1024,
    top_p: 0.7,
    top_k: 50,
    repetition_penalty: 1,
    stop: ['<end_of_turn>']
  },
  'deepseek-70b': {
    provider: 'together',
    model: 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free',
    temperature: 0.7,
    max_tokens: 1024,
    top_p: 0.7,
    top_k: 50,
    repetition_penalty: 1,
    stop: ['</s>']
  }
};

async function processWithTogether(messages, config) {
  const API_KEY = process.env.TOGETHER_API_KEY;
  if (!API_KEY) {
    throw new Error('Together API key not found');
  }

  const systemPrompt = `You are a helpful AI assistant that provides accurate and informative responses based on the conversation history. Keep your responses focused and relevant to the user's questions.`;

  const formattedMessages = messages.map(msg => {
    if (msg.role === 'user') {
      return `Human: ${msg.content}`;
    } else if (msg.role === 'assistant') {
      return `Assistant: ${msg.content}`;
    }
    return '';
  }).join('\n');

  const prompt = `${systemPrompt}\n\n${formattedMessages}\nHuman: Please provide a response to continue this conversation:\nAssistant:`;

  try {
    const response = await fetch('https://api.together.xyz/inference', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: config.model,
        prompt: prompt,
        temperature: config.temperature,
        max_tokens: config.max_tokens,
        top_p: config.top_p,
        top_k: config.top_k,
        repetition_penalty: config.repetition_penalty,
        stop: config.stop
      })
    });

    if (!response.ok) {
      throw new Error(`Together API error: ${response.status}`);
    }

    const data = await response.json();
    return data.output.choices[0].text.trim();
  } catch (error) {
    logger.error('Error processing with Together API:', error);
    throw error;
  }
}

async function processWithProvider(messages, config) {
  switch (config.provider) {
    case 'together':
      return processWithTogether(messages, config);
    default:
      throw new Error(`Unsupported provider: ${config.provider}`);
  }
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb'
    }
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, model = 'mistral-7b' } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    // Process with LLM
    const requestedModel = typeof model === 'string' ? model.toLowerCase() : 'mistral-7b';
    let modelConfig = SUPPORTED_MODELS[requestedModel];
    if (!modelConfig) {
      logger.warn('Unsupported model, falling back to mistral-7b', { requestedModel: model });
      modelConfig = SUPPORTED_MODELS['mistral-7b'];
    }

    const result = await processWithProvider(messages, modelConfig);

    res.status(200).json({
      content: result,
      model: modelConfig.model
    });
  } catch (error) {
    logger.error('Error in chat endpoint:', error);
    res.status(500).json({ error: error.message });
  }
}
