jest.mock('axios');

const axios = require('axios');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/auth/reddit/callback').default;

function createRedirectRes() {
  const res = createMockRes();
  const headers = {};

  res.setHeader = jest.fn((key, value) => {
    headers[key] = value;
    return res;
  });

  res.redirectTarget = null;
  res.redirect = jest.fn((target) => {
    res.redirectTarget = target;
    return res;
  });

  res.headers = headers;
  return res;
}

describe('/api/auth/reddit/callback', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_CLIENT_SECRET;
    delete process.env.REDDIT_REDIRECT_URI;
    delete process.env.NEXT_PUBLIC_BASE_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('redirects when reddit returns an auth error', async () => {
    const req = createMockReq({
      query: { error: 'access_denied' },
      headers: {},
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=access_denied');
  });

  it('redirects when no authorization code is provided', async () => {
    const req = createMockReq({
      query: {},
      headers: {},
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      '/network?error=No authorization code received from Reddit'
    );
  });

  it('redirects when oauth state does not match the stored cookie', async () => {
    const req = createMockReq({
      query: { code: 'code-123', state: 'incoming-state' },
      headers: { cookie: 'reddit_auth_state=stored-state' },
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      '/network?error=Invalid Reddit OAuth state'
    );
  });

  it('redirects when reddit credentials are missing', async () => {
    const req = createMockReq({
      query: { code: 'code-123', state: 'same-state' },
      headers: { cookie: 'reddit_auth_state=same-state' },
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      '/network?error=Missing Reddit client credentials'
    );
  });

  it('sets cookies and redirects on successful token exchange', async () => {
    process.env.REDDIT_CLIENT_ID = 'client-id';
    process.env.REDDIT_CLIENT_SECRET = 'client-secret';
    process.env.REDDIT_REDIRECT_URI = 'https://example.com/api/auth/reddit/callback';

    axios.post.mockResolvedValue({
      data: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
      },
    });

    const req = createMockReq({
      query: { code: 'code-123', state: 'same-state' },
      headers: { cookie: 'reddit_auth_state=same-state' },
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', expect.any(Array));
    expect(res.redirect).toHaveBeenCalledWith('/network?auth=reddit_success');
  });

  it('redirects with a detailed message when token exchange fails', async () => {
    process.env.REDDIT_CLIENT_ID = 'client-id';
    process.env.REDDIT_CLIENT_SECRET = 'client-secret';
    process.env.REDDIT_REDIRECT_URI = 'https://example.com/api/auth/reddit/callback';

    axios.post.mockRejectedValue({
      response: {
        data: {
          error: 'bad_code',
        },
      },
    });

    const req = createMockReq({
      query: { code: 'code-123', state: 'same-state' },
      headers: { cookie: 'reddit_auth_state=same-state' },
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      `/network?error=${encodeURIComponent('Reddit token exchange failed: bad_code')}`
    );
  });
});
