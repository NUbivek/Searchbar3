const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/llm/status').default;

describe('/api/llm/status', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TOGETHER_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.NEXT_PUBLIC_SEARCH_API_URL;
    delete process.env.NODE_ENV;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('reports missing API keys as unavailable', async () => {
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
      nodeEnv: undefined,
      hasEnvFile: false,
    });
    expect(res.body.modelConfig.together.endpoint).toBe('Not configured');
    expect(res.body.modelConfig.perplexity.endpoint).toBe('Not configured');
  });

  test('reports configured key lengths without exposing full values', async () => {
    process.env.TOGETHER_API_KEY = 't'.repeat(64);
    process.env.PERPLEXITY_API_KEY = 'p'.repeat(48);
    process.env.NEXT_PUBLIC_SEARCH_API_URL = 'https://api.example.test';
    process.env.NODE_ENV = 'test';

    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.apiKeys).toEqual({
      together: true,
      togetherKeyLength: 64,
      perplexity: true,
      perplexityKeyLength: 48,
    });
    expect(res.body.env).toEqual({
      nodeEnv: 'test',
      hasEnvFile: true,
    });
    expect(JSON.stringify(res.body)).not.toContain('t'.repeat(64));
    expect(JSON.stringify(res.body)).not.toContain('p'.repeat(48));
  });
});
