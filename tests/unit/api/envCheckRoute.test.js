// The real gate in src/server/auth.js runs; only the session lookup is stood in for.
jest.mock('next-auth/next', () => ({ getServerSession: jest.fn(async () => null) }));
jest.mock('../../../src/server/db', () => ({ query: jest.fn(async () => []), persistenceMode: jest.fn(() => 'none') }));

const { getServerSession } = require('next-auth/next');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/debug/env-check').default;

describe('/api/debug/env-check', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    for (const key of [
      'TAVILY_API_KEY', 'SERPER_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_AI_API_KEY',
      'NVIDIA_API_KEY', 'TOGETHER_API_KEY', 'PERPLEXITY_API_KEY', 'OPENAI_API_KEY', 'TWITTER_CLIENT_ID', 'TWITTER_CLIENT_SECRET',
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
    expect(getServerSession).not.toHaveBeenCalled();
  });

  test('is open outside production and reports which keys are set without their values', async () => {
    process.env.GROQ_API_KEY = 'super-secret-value';
    process.env.TOGETHER_API_KEY = 'a-paid-key-that-is-never-read';
    process.env.TWITTER_CLIENT_ID = 'twitter-client-id';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://example.test';
    process.env.NEXT_PUBLIC_USE_PRODUCTION_CALLBACKS = 'true';

    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(getServerSession).not.toHaveBeenCalled();
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
      present: ['GROQ_API_KEY'],
      missing: ['GOOGLE_AI_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY'],
    });
    expect(res.body.diagnostics.providers.twitter).toEqual({
      configured: true,
      present: ['TWITTER_CLIENT_ID'],
      missing: ['TWITTER_CLIENT_SECRET'],
    });
    expect(JSON.stringify(res.body)).not.toContain('super-secret-value');
    // keys for paid AI services are not part of the app any more
    expect(JSON.stringify(res.body)).not.toMatch(/TOGETHER|PERPLEXITY|OPENAI_API_KEY/);
  });

  test('is ok once a search provider key is present', async () => {
    process.env.TAVILY_API_KEY = 'tvly-x';
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.body.diagnostics.ok).toBe(true);
    expect(res.body.diagnostics.missingCore).toEqual([]);
  });

  // Changed in round 3 (security-debug-routes): signed out gets a 404, as if the route did not exist.
  // Changed in round 4 (network-security-debug-prod-open): production answers only an account on a set allow-list.
  test('requires a signed-in session in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.FOUNDER_ALLOWED_EMAILS = 'owner@example.com';
    getServerSession.mockResolvedValue(null);

    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(getServerSession).toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.body.diagnostics).toBeUndefined();
  });

  // Changed in round 3: on a deployment only whether each group is set up, never the names of settings.
  test('serves diagnostics to a signed-in user on the allow-list in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.FOUNDER_ALLOWED_EMAILS = 'owner@example.com';
    getServerSession.mockResolvedValue({ user: { id: 'google:123', email: 'owner@example.com' } });

    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.diagnostics).toBeDefined();
    expect(JSON.stringify(res.body)).not.toMatch(/_API_KEY|present|missing/);
  });
});
