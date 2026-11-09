jest.mock('../../../src/server/auth', () => ({
  getUserId: jest.fn(),
}));

const { getUserId } = require('../../../src/server/auth');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/debug/env-check').default;

describe('/api/debug/env-check', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    for (const key of [
      'TAVILY_API_KEY', 'SERPER_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_AI_API_KEY',
      'TOGETHER_API_KEY', 'PERPLEXITY_API_KEY', 'OPENAI_API_KEY', 'TWITTER_CLIENT_ID', 'TWITTER_CLIENT_SECRET',
      'NEXT_PUBLIC_BASE_URL', 'NEXT_PUBLIC_PRODUCTION_URL', 'NEXT_PUBLIC_USE_PRODUCTION_CALLBACKS',
    ]) delete process.env[key];
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('rejects non-GET requests', async () => {
    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('GET');
    expect(res.body).toEqual({ error: 'Method not allowed' });
    expect(getUserId).not.toHaveBeenCalled();
  });

  test('is open outside production and reports which keys are set without their values', async () => {
    process.env.TOGETHER_API_KEY = 'super-secret-value';
    process.env.TWITTER_CLIENT_ID = 'twitter-client-id';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://example.test';
    process.env.NEXT_PUBLIC_USE_PRODUCTION_CALLBACKS = 'true';

    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(getUserId).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(typeof res.body.timestamp).toBe('string');
    expect(res.body.diagnostics).toMatchObject({
      ok: false,
      missingCore: ['TAVILY_API_KEY or SERPER_API_KEY'],
      baseUrl: 'https://example.test',
      useProductionCallbacks: true,
    });
    expect(res.body.diagnostics.providers.llm).toEqual({
      configured: true,
      present: ['TOGETHER_API_KEY'],
      missing: ['GROQ_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_AI_API_KEY', 'PERPLEXITY_API_KEY', 'OPENAI_API_KEY'],
    });
    expect(res.body.diagnostics.providers.twitter).toEqual({
      configured: true,
      present: ['TWITTER_CLIENT_ID'],
      missing: ['TWITTER_CLIENT_SECRET'],
    });
    expect(JSON.stringify(res.body)).not.toContain('super-secret-value');
  });

  test('is ok once a search provider key is present', async () => {
    process.env.TAVILY_API_KEY = 'tvly-x';
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.body.diagnostics.ok).toBe(true);
    expect(res.body.diagnostics.missingCore).toEqual([]);
  });

  test('requires a signed-in session in production', async () => {
    process.env.NODE_ENV = 'production';
    getUserId.mockResolvedValue(null);

    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(getUserId).toHaveBeenCalledWith(req, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.diagnostics).toBeUndefined();
  });

  test('serves diagnostics to a signed-in user in production', async () => {
    process.env.NODE_ENV = 'production';
    getUserId.mockResolvedValue('google:123');

    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.diagnostics).toBeDefined();
  });
});
