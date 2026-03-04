import handler from '../../../src/pages/api/llm/status';
import { createMockReq, createMockRes } from './testUtils';

describe('/api/llm/status', () => {
  const originalEnv = {
    TOGETHER_API_KEY: process.env.TOGETHER_API_KEY,
    PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY,
    NEXT_PUBLIC_SEARCH_API_URL: process.env.NEXT_PUBLIC_SEARCH_API_URL,
  };

  afterEach(() => {
    if (originalEnv.TOGETHER_API_KEY === undefined) {
      delete process.env.TOGETHER_API_KEY;
    } else {
      process.env.TOGETHER_API_KEY = originalEnv.TOGETHER_API_KEY;
    }

    if (originalEnv.PERPLEXITY_API_KEY === undefined) {
      delete process.env.PERPLEXITY_API_KEY;
    } else {
      process.env.PERPLEXITY_API_KEY = originalEnv.PERPLEXITY_API_KEY;
    }

    if (originalEnv.NEXT_PUBLIC_SEARCH_API_URL === undefined) {
      delete process.env.NEXT_PUBLIC_SEARCH_API_URL;
    } else {
      process.env.NEXT_PUBLIC_SEARCH_API_URL = originalEnv.NEXT_PUBLIC_SEARCH_API_URL;
    }
  });

  it('returns disabled statuses when env vars are missing', async () => {
    delete process.env.TOGETHER_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.NEXT_PUBLIC_SEARCH_API_URL;

    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.apiKeys.together).toBe(false);
    expect(res.body.apiKeys.togetherKeyLength).toBe(0);
    expect(res.body.apiKeys.perplexity).toBe(false);
    expect(res.body.apiKeys.perplexityKeyLength).toBe(0);
    expect(res.body.env.hasEnvFile).toBe(false);
    expect(res.body.modelConfig).toHaveProperty('together');
    expect(res.body.modelConfig).toHaveProperty('perplexity');
  });

  it('reports enabled statuses and key lengths when env vars exist', async () => {
    process.env.TOGETHER_API_KEY = 'abc123';
    process.env.PERPLEXITY_API_KEY = 'perpkey';
    process.env.NEXT_PUBLIC_SEARCH_API_URL = 'http://localhost:3000/api/search';

    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.apiKeys.together).toBe(true);
    expect(res.body.apiKeys.togetherKeyLength).toBe(6);
    expect(res.body.apiKeys.perplexity).toBe(true);
    expect(res.body.apiKeys.perplexityKeyLength).toBe(7);
    expect(res.body.env.hasEnvFile).toBe(true);
  });
});
