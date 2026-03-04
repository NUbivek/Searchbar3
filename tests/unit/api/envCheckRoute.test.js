const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/debug/env-check').default;

describe('/api/debug/env-check', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.SERPER_API_KEY;
    delete process.env.TOGETHER_API_KEY;
    delete process.env.TWITTER_CLIENT_ID;
    delete process.env.NEXT_PUBLIC_BASE_URL;
    delete process.env.NEXT_PUBLIC_PRODUCTION_URL;
    delete process.env.NEXT_PUBLIC_USE_PRODUCTION_CALLBACKS;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('rejects non-GET requests', async () => {
    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  test('returns diagnostics without exposing secret values', async () => {
    process.env.TOGETHER_API_KEY = 'super-secret-value';
    process.env.TWITTER_CLIENT_ID = 'twitter-client-id';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://example.test';
    process.env.NEXT_PUBLIC_USE_PRODUCTION_CALLBACKS = 'true';

    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(typeof res.body.timestamp).toBe('string');
    expect(res.body.diagnostics).toMatchObject({
      ok: false,
      missingCore: ['SERPER_API_KEY'],
      baseUrl: 'https://example.test',
      useProductionCallbacks: true,
    });
    expect(res.body.diagnostics.providers.llm).toEqual({
      configured: true,
      present: ['TOGETHER_API_KEY'],
      missing: ['PERPLEXITY_API_KEY', 'OPENAI_API_KEY'],
    });
    expect(res.body.diagnostics.providers.twitter).toEqual({
      configured: true,
      present: ['TWITTER_CLIENT_ID'],
      missing: ['TWITTER_CLIENT_SECRET'],
    });
    expect(JSON.stringify(res.body)).not.toContain('super-secret-value');
  });
});
