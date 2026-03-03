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

  test('returns configuration error when client id is missing', () => {
    const req = createMockReq();
    const res = createRedirectRes();

    handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'Configuration error',
      details: 'Twitter API key is not configured.',
    });
    expect(getCallbackUrl).not.toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
  });

  test('sets cookies and redirects to twitter authorize url', () => {
    process.env.TWITTER_API_KEY = 'twitter-client-id';
    const randomValues = [0.123456, 0.654321];
    jest.spyOn(Math, 'random').mockImplementation(() => randomValues.shift() ?? 0.5);

    const req = createMockReq();
    const res = createRedirectRes();

    handler(req, res);

    expect(getCallbackUrl).toHaveBeenCalledWith('twitter');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.arrayContaining([
        expect.stringContaining('twitter_auth_state='),
        expect.stringContaining('twitter_code_verifier=challenge'),
      ])
    );
    expect(res.redirect).toHaveBeenCalledTimes(1);
    expect(res.redirectUrl).toContain('https://twitter.com/i/oauth2/authorize');
    expect(res.redirectUrl).toContain('client_id=twitter-client-id');
    expect(res.redirectUrl).toContain(
      encodeURIComponent('https://example.com/api/auth/twitter/callback')
    );
    expect(res.redirectUrl).toContain('code_challenge_method=plain');
    expect(res.redirectUrl).toContain('scope=tweet.read');
  });
});
