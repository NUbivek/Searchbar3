jest.mock('axios');

const axios = require('axios');
const handler =
  require('../../../src/pages/api/auth/reddit/callback').default;

function createMockReq(overrides = {}) {
  return {
    method: 'GET',
    query: {},
    headers: {},
    ...overrides,
  };
}

function createMockRes() {
  return {
    headers: {},
    redirectTarget: null,
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    redirect(target) {
      this.redirectTarget = target;
      return this;
    },
  };
}

describe('/api/auth/reddit/callback', () => {
  const originalEnv = {
    clientId: process.env.REDDIT_CLIENT_ID,
    clientSecret: process.env.REDDIT_CLIENT_SECRET,
    redirectUri: process.env.REDDIT_REDIRECT_URI,
    baseUrl: process.env.NEXT_PUBLIC_BASE_URL,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REDDIT_CLIENT_ID = 'reddit-client-id';
    process.env.REDDIT_CLIENT_SECRET = 'reddit-client-secret';
    process.env.REDDIT_REDIRECT_URI = 'https://example.com/api/auth/reddit/callback';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://example.com';
  });

  afterAll(() => {
    process.env.REDDIT_CLIENT_ID = originalEnv.clientId;
    process.env.REDDIT_CLIENT_SECRET = originalEnv.clientSecret;
    process.env.REDDIT_REDIRECT_URI = originalEnv.redirectUri;
    process.env.NEXT_PUBLIC_BASE_URL = originalEnv.baseUrl;
  });

  it('redirects provider errors back to the network page', async () => {
    const req = createMockReq({
      query: { error: 'access_denied' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.redirectTarget).toBe('/network?error=access_denied');
  });

  it('redirects when no code is present', async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.redirectTarget).toBe(
      '/network?error=No authorization code received from Reddit'
    );
  });

  it('redirects when the oauth state is invalid', async () => {
    const req = createMockReq({
      query: { code: 'reddit-code', state: 'wrong-state' },
      headers: { cookie: 'reddit_auth_state=expected-state' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.redirectTarget).toBe(
      '/network?error=Invalid Reddit OAuth state'
    );
  });

  it('redirects when reddit credentials are missing', async () => {
    delete process.env.REDDIT_CLIENT_SECRET;

    const req = createMockReq({
      query: { code: 'reddit-code', state: 'expected-state' },
      headers: { cookie: 'reddit_auth_state=expected-state' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.redirectTarget).toBe(
      '/network?error=Missing Reddit client credentials'
    );
  });

  it('sets cookies and redirects on successful token exchange', async () => {
    axios.post.mockResolvedValue({
      data: {
        access_token: 'reddit-access-token',
        refresh_token: 'reddit-refresh-token',
        expires_in: 3600,
      },
    });

    const req = createMockReq({
      query: { code: 'reddit-code', state: 'expected-state' },
      headers: { cookie: 'reddit_auth_state=expected-state' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledWith(
      'https://www.reddit.com/api/v1/access_token',
      expect.any(String),
      expect.objectContaining({
        timeout: 10000,
        headers: expect.objectContaining({
          Authorization: expect.stringContaining('Basic '),
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
      })
    );
    expect(Array.isArray(res.headers['Set-Cookie'])).toBe(true);
    expect(res.headers['Set-Cookie']).toHaveLength(2);
    expect(res.redirectTarget).toBe('/network?auth=reddit_success');
  });

  it('redirects with an encoded token exchange error', async () => {
    axios.post.mockRejectedValue({
      response: { data: { error: 'bad_code' } },
    });

    const req = createMockReq({
      query: { code: 'reddit-code', state: 'expected-state' },
      headers: { cookie: 'reddit_auth_state=expected-state' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.redirectTarget).toBe(
      `/network?error=${encodeURIComponent(
        'Reddit token exchange failed: bad_code'
      )}`
    );
  });
});
