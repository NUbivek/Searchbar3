jest.mock('../../../src/utils/oauthUtils', () => ({
  getCallbackUrl: jest.fn(),
}));

const { getCallbackUrl } = require('../../../src/utils/oauthUtils');
const handler = require('../../../src/pages/api/auth/twitter/index').default;

function createMockRes() {
  return {
    statusCode: 200,
    jsonPayload: null,
    headers: {},
    redirectUrl: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.jsonPayload = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    redirect(url) {
      this.redirectUrl = url;
      return this;
    },
  };
}

describe('/api/auth/twitter', () => {
  const originalEnv = process.env;
  const originalRandom = Math.random;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    getCallbackUrl.mockReturnValue('https://example.com/api/auth/twitter/callback');
  });

  afterAll(() => {
    process.env = originalEnv;
    Math.random = originalRandom;
  });

  it('redirects back to /network with a clear error when twitter client id is missing', async () => {
    delete process.env.TWITTER_API_KEY;
    delete process.env.TWITTER_CLIENT_ID;

    const req = { method: 'GET' };
    const res = createMockRes();

    await handler(req, res);

    // A short code the network page maps to user copy; no env var names or file paths.
    expect(res.redirectUrl).toBe('/network?error=twitter_not_configured');
    expect(res.jsonPayload).toBeNull();
  });

  it('sets cookies and redirects to twitter oauth', async () => {
    process.env.TWITTER_CLIENT_ID = 'twitter-client-id';

    const req = { method: 'GET' };
    const res = createMockRes();

    await handler(req, res);

    expect(getCallbackUrl).toHaveBeenCalledWith('twitter', req);
    expect(res.headers['Set-Cookie']).toHaveLength(2);
    expect(res.headers['Set-Cookie'][0]).toContain('twitter_auth_state=');
    expect(res.headers['Set-Cookie'][1]).toMatch(/^twitter_code_verifier=[A-Za-z0-9_-]{43,128};/);
    expect(res.redirectUrl).toContain('https://twitter.com/i/oauth2/authorize?');

    const redirectUrl = new URL(res.redirectUrl);
    expect(redirectUrl.searchParams.get('response_type')).toBe('code');
    expect(redirectUrl.searchParams.get('client_id')).toBe('twitter-client-id');
    expect(redirectUrl.searchParams.get('redirect_uri')).toBe(
      'https://example.com/api/auth/twitter/callback'
    );
    expect(redirectUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(redirectUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redirectUrl.searchParams.get('scope')).toBe(
      'tweet.read users.read follows.read offline.access'
    );
  });
});
