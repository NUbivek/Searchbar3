jest.mock('axios', () => ({
  post: jest.fn(),
}));

const axios = require('axios');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/auth/twitter/callback').default;

function createRedirectRes() {
  const res = createMockRes();
  res.headers = {};
  res.redirectTarget = null;
  res.setHeader = jest.fn((name, value) => {
    res.headers[name] = value;
  });
  res.redirect = jest.fn((target) => {
    res.redirectTarget = target;
    return res;
  });
  return res;
}

describe('/api/auth/twitter/callback', () => {
  const originalClientId = process.env.TWITTER_CLIENT_ID;
  const originalApiKey = process.env.TWITTER_API_KEY;
  const originalClientSecret = process.env.TWITTER_CLIENT_SECRET;
  const originalBaseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  const originalRedirectUri = process.env.TWITTER_REDIRECT_URI;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.TWITTER_CLIENT_ID;
    delete process.env.TWITTER_API_KEY;
    delete process.env.TWITTER_CLIENT_SECRET;
    delete process.env.NEXT_PUBLIC_BASE_URL;
    delete process.env.TWITTER_REDIRECT_URI;
    delete process.env.NODE_ENV;
  });

  afterAll(() => {
    if (originalClientId) process.env.TWITTER_CLIENT_ID = originalClientId;
    else delete process.env.TWITTER_CLIENT_ID;

    if (originalApiKey) process.env.TWITTER_API_KEY = originalApiKey;
    else delete process.env.TWITTER_API_KEY;

    if (originalClientSecret) process.env.TWITTER_CLIENT_SECRET = originalClientSecret;
    else delete process.env.TWITTER_CLIENT_SECRET;

    if (originalBaseUrl) process.env.NEXT_PUBLIC_BASE_URL = originalBaseUrl;
    else delete process.env.NEXT_PUBLIC_BASE_URL;

    if (originalRedirectUri) process.env.TWITTER_REDIRECT_URI = originalRedirectUri;
    else delete process.env.TWITTER_REDIRECT_URI;

    if (originalNodeEnv) process.env.NODE_ENV = originalNodeEnv;
    else delete process.env.NODE_ENV;
  });

  test('redirects with auth error from twitter', async () => {
    const req = createMockReq({
      query: {
        error: 'access_denied',
        error_description: 'User denied access',
      },
      headers: {},
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=User%20denied%20access');
  });

  test('redirects when no authorization code is received', async () => {
    const req = createMockReq({ query: {}, headers: {} });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=No authorization code received');
  });

  test('redirects when state parameter is invalid', async () => {
    const req = createMockReq({
      query: {
        code: 'auth-code',
        state: 'wrong-state',
      },
      headers: {
        cookie: 'twitter_auth_state=expected-state',
      },
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=Invalid state parameter');
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('redirects when twitter client id is missing', async () => {
    const req = createMockReq({
      query: {
        code: 'auth-code',
        state: 'valid-state',
      },
      headers: {
        cookie: 'twitter_auth_state=valid-state',
      },
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=Missing Twitter client configuration');
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('sets cookies and redirects on successful callback exchange', async () => {
    process.env.TWITTER_CLIENT_ID = 'twitter-client-id';
    process.env.TWITTER_CLIENT_SECRET = 'twitter-client-secret';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://example.com';

    axios.post.mockResolvedValueOnce({
      data: {
        access_token: 'twitter-access-token',
        refresh_token: 'twitter-refresh-token',
        expires_in: 3600,
      },
    });

    const req = createMockReq({
      query: {
        code: 'auth-code',
        state: 'valid-state',
      },
      headers: {
        cookie: 'twitter_auth_state=valid-state; twitter_code_verifier=custom-verifier',
      },
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledWith(
      'https://api.twitter.com/2/oauth2/token',
      'grant_type=authorization_code&code=auth-code&redirect_uri=https%3A%2F%2Fexample.com%2Fapi%2Fauth%2Ftwitter%2Fcallback&code_verifier=custom-verifier&client_id=twitter-client-id',
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from('twitter-client-id:twitter-client-secret').toString('base64')}`,
        },
        timeout: 10000,
      }
    );
    expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', [
      'twitter_access_token=twitter-access-token; Max-Age=3600000; Path=/; HttpOnly; SameSite=Lax',
      'twitter_refresh_token=twitter-refresh-token; Max-Age=2592000000; Path=/; HttpOnly; SameSite=Lax',
    ]);
    expect(res.redirect).toHaveBeenCalledWith('/network?auth=twitter_success');
  });

  test('redirects with detailed error when token exchange fails', async () => {
    process.env.TWITTER_CLIENT_ID = 'twitter-client-id';

    axios.post.mockRejectedValueOnce({
      response: {
        status: 400,
        data: {
          error_description: 'Authorization code expired',
        },
      },
    });

    const req = createMockReq({
      query: {
        code: 'bad-code',
        state: 'valid-state',
      },
      headers: {
        cookie: 'twitter_auth_state=valid-state',
      },
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      '/network?error=Invalid%20request%20to%20Twitter%3A%20Authorization%20code%20expired'
    );
  });
});
