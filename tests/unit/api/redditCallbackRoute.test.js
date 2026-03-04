jest.mock('axios');

const axios = require('axios');
const handler = require('../../../src/pages/api/auth/reddit/callback').default;
const { createMockReq, createMockRes } = require('./testUtils');

const ORIGINAL_ENV = process.env;

function createRedirectRes() {
  const res = createMockRes();
  res.headers = {};
  res.redirectTarget = null;
  res.redirect = jest.fn((target) => {
    res.redirectTarget = target;
    return res;
  });
  res.setHeader = jest.fn((name, value) => {
    res.headers[name] = value;
    return res;
  });
  return res;
}

describe('/api/auth/reddit/callback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_CLIENT_SECRET;
    delete process.env.REDDIT_REDIRECT_URI;
    delete process.env.NEXT_PUBLIC_BASE_URL;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('redirects when reddit returns an auth error', async () => {
    const req = createMockReq({
      query: { error: 'access_denied' },
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=access_denied');
  });

  it('redirects when no authorization code is present', async () => {
    const req = createMockReq({ query: {} });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      '/network?error=No authorization code received from Reddit'
    );
  });

  it('redirects when the oauth state is invalid', async () => {
    const req = createMockReq({
      headers: { cookie: 'reddit_auth_state=expected-state' },
      query: { code: 'code-123', state: 'different-state' },
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      '/network?error=Invalid Reddit OAuth state'
    );
  });

  it('redirects when reddit client credentials are missing', async () => {
    const req = createMockReq({
      headers: { cookie: 'reddit_auth_state=valid-state' },
      query: { code: 'code-123', state: 'valid-state' },
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      '/network?error=Missing Reddit client credentials'
    );
  });

  it('sets cookies and redirects on successful token exchange', async () => {
    process.env.REDDIT_CLIENT_ID = 'reddit-client-id';
    process.env.REDDIT_CLIENT_SECRET = 'reddit-client-secret';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://example.com';

    axios.post.mockResolvedValue({
      data: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
      },
    });

    const req = createMockReq({
      headers: { cookie: 'reddit_auth_state=valid-state' },
      query: { code: 'code-123', state: 'valid-state' },
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.arrayContaining([
        expect.stringContaining('reddit_access_token=access-token'),
        expect.stringContaining('reddit_refresh_token=refresh-token'),
      ])
    );
    expect(res.redirect).toHaveBeenCalledWith('/network?auth=reddit_success');
  });

  it('redirects with the upstream error when token exchange fails', async () => {
    process.env.REDDIT_CLIENT_ID = 'reddit-client-id';
    process.env.REDDIT_CLIENT_SECRET = 'reddit-client-secret';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://example.com';

    axios.post.mockRejectedValue({
      response: { data: { error: 'bad_code' } },
    });

    const req = createMockReq({
      headers: { cookie: 'reddit_auth_state=valid-state' },
      query: { code: 'code-123', state: 'valid-state' },
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      '/network?error=Reddit%20token%20exchange%20failed%3A%20bad_code'
    );
  });
});
