jest.mock('axios', () => ({
  post: jest.fn(),
}));

const axios = require('axios');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/auth/reddit/callback').default;

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

describe('/api/auth/reddit/callback', () => {
  const originalClientId = process.env.REDDIT_CLIENT_ID;
  const originalClientSecret = process.env.REDDIT_CLIENT_SECRET;
  const originalBaseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  const originalRedirectUri = process.env.REDDIT_REDIRECT_URI;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_CLIENT_SECRET;
    delete process.env.NEXT_PUBLIC_BASE_URL;
    delete process.env.REDDIT_REDIRECT_URI;
    delete process.env.NODE_ENV;
  });

  afterAll(() => {
    if (originalClientId) process.env.REDDIT_CLIENT_ID = originalClientId;
    else delete process.env.REDDIT_CLIENT_ID;

    if (originalClientSecret) process.env.REDDIT_CLIENT_SECRET = originalClientSecret;
    else delete process.env.REDDIT_CLIENT_SECRET;

    if (originalBaseUrl) process.env.NEXT_PUBLIC_BASE_URL = originalBaseUrl;
    else delete process.env.NEXT_PUBLIC_BASE_URL;

    if (originalRedirectUri) process.env.REDDIT_REDIRECT_URI = originalRedirectUri;
    else delete process.env.REDDIT_REDIRECT_URI;

    if (originalNodeEnv) process.env.NODE_ENV = originalNodeEnv;
    else delete process.env.NODE_ENV;
  });

  test('redirects with auth error from reddit', async () => {
    const req = createMockReq({ query: { error: 'access_denied' } });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=access_denied');
  });

  test('redirects when no authorization code is received', async () => {
    const req = createMockReq({ query: {} });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=No authorization code received from Reddit');
  });

  test('redirects when oauth state is invalid', async () => {
    const req = createMockReq({
      query: { code: 'auth-code', state: 'wrong-state' },
      headers: { cookie: 'reddit_auth_state=expected-state' },
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=Invalid Reddit OAuth state');
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('redirects when reddit credentials are missing', async () => {
    const req = createMockReq({ query: { code: 'auth-code' }, headers: {} });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=Missing Reddit client credentials');
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('sets cookies and redirects on successful callback exchange', async () => {
    process.env.REDDIT_CLIENT_ID = 'reddit-client-id';
    process.env.REDDIT_CLIENT_SECRET = 'reddit-client-secret';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://example.com';

    axios.post.mockResolvedValueOnce({
      data: {
        access_token: 'reddit-access-token',
        refresh_token: 'reddit-refresh-token',
        expires_in: 3600,
      },
    });

    const req = createMockReq({
      query: { code: 'auth-code', state: 'expected-state' },
      headers: { cookie: 'reddit_auth_state=expected-state' },
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledWith(
      'https://www.reddit.com/api/v1/access_token',
      'grant_type=authorization_code&code=auth-code&redirect_uri=https%3A%2F%2Fexample.com%2Fapi%2Fauth%2Freddit%2Fcallback',
      {
        headers: {
          Authorization: 'Basic ' + Buffer.from('reddit-client-id:reddit-client-secret').toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'searchbar/1.0',
        },
      }
    );
    expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', [
      'reddit_access_token=reddit-access-token; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax',
      'reddit_refresh_token=reddit-refresh-token; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax',
    ]);
    expect(res.redirect).toHaveBeenCalledWith('/network?auth=reddit_success');
  });

  test('redirects with detailed failure when token exchange fails', async () => {
    process.env.REDDIT_CLIENT_ID = 'reddit-client-id';
    process.env.REDDIT_CLIENT_SECRET = 'reddit-client-secret';

    axios.post.mockRejectedValueOnce({
      response: {
        data: {
          error: 'invalid_grant',
        },
      },
    });

    const req = createMockReq({ query: { code: 'bad-code' }, headers: {} });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      '/network?error=Reddit%20token%20exchange%20failed%3A%20invalid_grant'
    );
  });
});
