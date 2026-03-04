jest.mock('../../../src/utils/llmProcessing', () => ({
  MODEL_ENDPOINTS: {
    'mixtral-8x7b': {
      apiEndpoint: 'https://api.together.xyz/inference',
      apiModelName: 'mistralai/Mixtral-8x7B-Instruct-v0.1',
    },
    perplexity: {
      apiEndpoint: 'https://api.perplexity.ai/chat/completions',
      apiModelName: 'sonar',
    },
  },
}));

const { createMockReq, createMockRes } = require('./testUtils');

const handler = require('../../../src/pages/api/llm/status').default;

describe('/api/llm/status', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TOGETHER_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.NEXT_PUBLIC_SEARCH_API_URL;
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns 405 for non-GET requests', async () => {
    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('reports missing keys as unavailable', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.apiKeys).toEqual({
      together: false,
      togetherKeyLength: 0,
      perplexity: false,
      perplexityKeyLength: 0,
    });
    expect(res.body.env).toEqual({
      nodeEnv: 'test',
      hasEnvFile: false,
    });
    expect(res.body.modelConfig.together).toEqual({
      endpoint: 'https://api.together.xyz/inference',
      model: 'mistralai/Mixtral-8x7B-Instruct-v0.1',
    });
    expect(res.body.modelConfig.perplexity).toEqual({
      endpoint: 'https://api.perplexity.ai/chat/completions',
      model: 'sonar',
    });
  });

  it('reports configured keys and lengths', async () => {
    process.env.TOGETHER_API_KEY = 'together-secret';
    process.env.PERPLEXITY_API_KEY = 'perplexity-secret';
    process.env.NEXT_PUBLIC_SEARCH_API_URL = 'http://localhost:3000';

    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.apiKeys).toEqual({
      together: true,
      togetherKeyLength: 'together-secret'.length,
      perplexity: true,
      perplexityKeyLength: 'perplexity-secret'.length,
    });
    expect(res.body.env).toEqual({
      nodeEnv: 'test',
      hasEnvFile: true,
    });
  });

  it('treats placeholder values as not configured', async () => {
    process.env.TOGETHER_API_KEY = 'your_together_api_key_here';
    process.env.PERPLEXITY_API_KEY = 'your_perplexity_api_key_here';

    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.apiKeys).toEqual({
      together: false,
      togetherKeyLength: 0,
      perplexity: false,
      perplexityKeyLength: 0,
    });
  });
});
