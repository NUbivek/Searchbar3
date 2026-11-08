jest.mock('../../../src/utils/oauthUtils', () => ({
  getCallbackUrl: jest.fn(() => 'https://example.com/api/auth/twitter/callback'),
}));

const { getCallbackUrl } = require('../../../src/utils/oauthUtils');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/auth/twitter/index').default;

function createRedirectRes() {
  const res = createMockRes();
  res.headers = {};
  res.redirectUrl = null;
  res.setHeader = jest.fn((name, value) => {
    res.headers[name] = value;
  });
  res.redirect = jest.fn((url) => {
    res.redirectUrl = url;
    return res;
  });
  return res;
}

describe('/api/auth/twitter', () => {
  const originalApiKey = process.env.TWITTER_API_KEY;
  const originalClientId = process.env.TWITTER_CLIENT_ID;
  const originalRandom = Math.random;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.TWITTER_API_KEY;
    delete process.env.TWITTER_CLIENT_ID;
  });

  afterAll(() => {
    Math.random = originalRandom;
    if (originalApiKey) {
      process.env.TWITTER_API_KEY = originalApiKey;
    } else {
      delete process.env.TWITTER_API_KEY;
    }

    if (originalClientId) {
      process.env.TWITTER_CLIENT_ID = originalClientId;
    } else {
      delete process.env.TWITTER_CLIENT_ID;
    }
  });

  test('returns 405 for non-GET requests', () => {
    const req = createMockReq({ method: 'POST' });
    const res = createRedirectRes();

    handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  test('redirects back to /network with an error code (not developer copy) when client id is missing', () => {
    const req = createMockReq();
    const res = createRedirectRes();

    handler(req, res);

    // The page maps the code to user-facing copy; env var names never reach the browser.
    expect(res.redirect).toHaveBeenCalledWith('/network?error=twitter_not_configured');
    expect(res.redirectUrl).not.toMatch(/TWITTER_CLIENT|\.env/);
    expect(getCallbackUrl).not.toHaveBeenCalled();
  });

  test('sets cookies and redirects to twitter authorize url', () => {
    process.env.TWITTER_CLIENT_ID = 'twitter-client-id';

    const req = createMockReq();
    const res = createRedirectRes();

    handler(req, res);

    expect(getCallbackUrl).toHaveBeenCalledWith('twitter', req);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.arrayContaining([
        expect.stringContaining('twitter_auth_state='),
        expect.stringMatching(/^twitter_code_verifier=[A-Za-z0-9_-]{43,128};/),
      ])
    );
    expect(res.redirect).toHaveBeenCalledTimes(1);
    expect(res.redirectUrl).toContain('https://twitter.com/i/oauth2/authorize');
    expect(res.redirectUrl).toContain('client_id=twitter-client-id');
    expect(res.redirectUrl).toContain(
      encodeURIComponent('https://example.com/api/auth/twitter/callback')
    );
    expect(res.redirectUrl).toContain('code_challenge_method=S256');
    expect(res.redirectUrl).toContain('scope=tweet.read');
  });
});
