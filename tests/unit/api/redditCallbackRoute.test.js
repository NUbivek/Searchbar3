jest.mock('axios');

const axios = require('axios');
const { createMockReq } = require('./testUtils');
const handler = require('../../../src/pages/api/auth/reddit/callback').default;

function createRedirectRes() {
  const headers = {};

  return {
    statusCode: 200,
    headers,
    redirectUrl: null,
    setHeader(name, value) {
      headers[name] = value;
      return this;
    },
    getHeader(name) {
      return headers[name];
    },
    redirect(url) {
      this.redirectUrl = url;
      return this;
    },
  };
}

describe('/api/auth/reddit/callback', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('redirects when Reddit returns an auth error', async () => {
    const req = createMockReq({ query: { error: 'access_denied' } });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirectUrl).toBe('/network?error=access_denied');
  });

  it('redirects when no authorization code is present', async () => {
    const req = createMockReq({ query: {} });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirectUrl).toBe('/network?error=No authorization code received from Reddit');
  });

  it('redirects when the OAuth state does not match the stored cookie', async () => {
    const req = createMockReq({
      query: { code: 'abc', state: 'incoming-state' },
      headers: { cookie: 'reddit_auth_state=stored-state' },
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirectUrl).toBe('/network?error=Invalid Reddit OAuth state');
  });

  it('redirects when Reddit client credentials are missing', async () => {
    delete process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_CLIENT_SECRET;

    const req = createMockReq({ query: { code: 'abc' }, headers: {} });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirectUrl).toBe('/network?error=Missing Reddit client credentials');
  });

  it('sets cookies and redirects on successful token exchange', async () => {
    process.env.REDDIT_CLIENT_ID = 'client-id';
    process.env.REDDIT_CLIENT_SECRET = 'client-secret';
    process.env.REDDIT_REDIRECT_URI = 'https://example.com/callback';

    axios.post.mockResolvedValue({
      data: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 7200,
      },
    });

    const req = createMockReq({
      query: { code: 'abc', state: 'same-state' },
      headers: { cookie: 'reddit_auth_state=same-state' },
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalled();
    expect(res.redirectUrl).toBe('/network?auth=reddit_success');

    const cookies = res.getHeader('Set-Cookie');
    expect(Array.isArray(cookies)).toBe(true);
    expect(cookies[0]).toContain('reddit_access_token=access-token');
    expect(cookies[1]).toContain('reddit_refresh_token=refresh-token');
  });

  it('redirects with an encoded error when token exchange fails', async () => {
    process.env.REDDIT_CLIENT_ID = 'client-id';
    process.env.REDDIT_CLIENT_SECRET = 'client-secret';

    axios.post.mockRejectedValue({
      response: { data: { error: 'invalid_grant' } },
    });

    const req = createMockReq({ query: { code: 'abc' }, headers: {} });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirectUrl).toBe('/network?error=Reddit%20token%20exchange%20failed%3A%20invalid_grant');
  });
});
