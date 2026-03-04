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

  it('returns 500 when twitter client id is missing', async () => {
    delete process.env.TWITTER_API_KEY;
    delete process.env.TWITTER_CLIENT_ID;

    const req = { method: 'GET' };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.jsonPayload).toEqual({
      error: 'Configuration error',
      details: 'Twitter API key is not configured.',
    });
  });

  it('sets cookies and redirects to twitter oauth', async () => {
    process.env.TWITTER_API_KEY = 'twitter-client-id';
    Math.random = jest
      .fn()
      .mockReturnValueOnce(0.123456789)
      .mockReturnValueOnce(0.987654321);

    const req = { method: 'GET' };
    const res = createMockRes();

    await handler(req, res);

    expect(getCallbackUrl).toHaveBeenCalledWith('twitter');
    expect(res.headers['Set-Cookie']).toHaveLength(2);
    expect(res.headers['Set-Cookie'][0]).toContain('twitter_auth_state=');
    expect(res.headers['Set-Cookie'][1]).toContain('twitter_code_verifier=challenge');
    expect(res.redirectUrl).toContain('https://twitter.com/i/oauth2/authorize?');

    const redirectUrl = new URL(res.redirectUrl);
    expect(redirectUrl.searchParams.get('response_type')).toBe('code');
    expect(redirectUrl.searchParams.get('client_id')).toBe('twitter-client-id');
    expect(redirectUrl.searchParams.get('redirect_uri')).toBe(
      'https://example.com/api/auth/twitter/callback'
    );
    expect(redirectUrl.searchParams.get('code_challenge_method')).toBe('plain');
    expect(redirectUrl.searchParams.get('code_challenge')).toMatch(/^challenge/);
    expect(redirectUrl.searchParams.get('scope')).toBe(
      'tweet.read users.read follows.read offline.access'
    );
  });
});
