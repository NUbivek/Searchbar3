/**
 * Regression tests for the Nov 2026 deep-dive fixes:
 * LinkedIn OAuth CSRF state check, the open-search Hacker News fallback,
 * Hacker News HTTP errors, and the server self-URL helper.
 */
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('../../../src/utils/llmProcessing', () => ({ processWithLLM: jest.fn() }));

const axios = require('axios');
const { createMockReq, createMockRes } = require('../api/testUtils');

function createRedirectRes() {
  const res = createMockRes();
  res.headers = {};
  res.setHeader = jest.fn((name, value) => { res.headers[name] = value; });
  res.redirect = jest.fn((target) => { res.redirectTarget = target; return res; });
  return res;
}

describe('LinkedIn callback CSRF state check', () => {
  const handler = require('../../../src/pages/api/auth/linkedin/callback').default;
  const env = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LINKEDIN_CLIENT_ID = 'id';
    process.env.LINKEDIN_CLIENT_SECRET = 'secret';
  });
  afterAll(() => { process.env = env; });

  test.each([
    ['no state cookie', {}, 'abc'],
    ['mismatched state', { linkedin_auth_state: 'expected' }, 'attacker'],
    ['missing state param', { linkedin_auth_state: 'expected' }, undefined],
  ])('rejects %s without exchanging the code', async (_label, cookies, state) => {
    const req = createMockReq({ query: { code: 'c', state }, cookies, headers: { host: 'localhost:3007' } });
    const res = createRedirectRes();

    await handler(req, res);

    expect(axios.post).not.toHaveBeenCalled();
    const url = new URL(res.redirectTarget);
    expect(url.pathname).toBe('/network');
    expect(url.searchParams.get('error')).toMatch(/Sign-in check failed/);
  });

  test('accepts a matching state, sets the token and clears the state cookie', async () => {
    axios.post.mockResolvedValueOnce({ data: { access_token: 'tok', expires_in: 3600 } });
    axios.get.mockResolvedValueOnce({ data: { sub: 'u1', given_name: 'A', family_name: 'B' } });
    const req = createMockReq({
      query: { code: 'c', state: 's1' },
      cookies: { linkedin_auth_state: 's1' },
      headers: { host: 'localhost:3007' },
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(res.redirectTarget).toBe('http://localhost:3007/network?auth=linkedin_success');
    const cookies = res.headers['Set-Cookie'];
    expect(cookies[0]).toMatch(/^linkedin_access_token=tok;.*HttpOnly/);
    expect(cookies).toContain('linkedin_auth_state=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  });
});

// The open-search route (including Hacker News coverage) is now tested in
// tests/unit/features/searchPipeline.test.js.

describe('searchHackerNews', () => {
  const { searchHackerNews } = require('../../../src/utils/sources/hackernewsAlgolia');
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  test('throws on a non-2xx response instead of parsing it as data', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    await expect(searchHackerNews('x')).rejects.toThrow('503');
  });
});

describe('selfBaseUrl', () => {
  const { selfBaseUrl } = require('../../../src/utils/serverBaseUrl');
  const env = { ...process.env };
  afterEach(() => { process.env = { ...env }; });

  test('uses the real dev port in development', () => {
    process.env.NODE_ENV = 'development';
    process.env.PORT = '3007';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://prod.example.com';
    expect(selfBaseUrl()).toBe('http://localhost:3007');
  });

  test('uses the configured public URL in production, without trailing slash', () => {
    process.env.NODE_ENV = 'production';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://prod.example.com/';
    expect(selfBaseUrl()).toBe('https://prod.example.com');
  });

  test('ignores any request passed in (Host header is client-controlled)', () => {
    process.env.NODE_ENV = 'production';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://prod.example.com';
    expect(selfBaseUrl({ headers: { host: '169.254.169.254' } })).toBe('https://prod.example.com');
  });
});
