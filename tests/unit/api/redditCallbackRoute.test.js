jest.mock('axios', () => ({
  post: jest.fn()
}));

import axios from 'axios';
import handler from '../../../src/pages/api/auth/reddit/callback';

function createReq(overrides = {}) {
  return {
    method: 'GET',
    query: {},
    headers: {},
    ...overrides
  };
}

function createRes() {
  const res = {
    headers: {},
    redirect: jest.fn((location) => location),
    setHeader: jest.fn((name, value) => {
      res.headers[name] = value;
    })
  };
  return res;
}

describe('/api/auth/reddit/callback', () => {
  const env = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env };
    process.env.REDDIT_CLIENT_ID = 'reddit-client-id';
    process.env.REDDIT_CLIENT_SECRET = 'reddit-client-secret';
    process.env.REDDIT_REDIRECT_URI = 'https://example.com/api/auth/reddit/callback';
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    process.env = env;
  });

  it('redirects auth errors from Reddit', async () => {
    const req = createReq({
      query: { error: 'access_denied' }
    });
    const res = createRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=access_denied');
  });

  it('redirects when the authorization code is missing', async () => {
    const req = createReq();
    const res = createRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=No authorization code received from Reddit');
  });

  it('rejects invalid oauth state when a state cookie is present', async () => {
    const req = createReq({
      query: { code: 'oauth-code', state: 'returned-state' },
      headers: { cookie: 'reddit_auth_state=stored-state' }
    });
    const res = createRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=Invalid Reddit OAuth state');
  });

  it('redirects when Reddit credentials are missing', async () => {
    delete process.env.REDDIT_CLIENT_ID;
    const req = createReq({
      query: { code: 'oauth-code' }
    });
    const res = createRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=Missing Reddit client credentials');
  });

  it('stores tokens and redirects on a successful token exchange', async () => {
    axios.post.mockResolvedValue({
      data: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 1800
      }
    });

    const req = createReq({
      query: { code: 'oauth-code', state: 'stored-state' },
      headers: { cookie: 'reddit_auth_state=stored-state' }
    });
    const res = createRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.arrayContaining([
        expect.stringContaining('reddit_access_token=access-token'),
        expect.stringContaining('reddit_refresh_token=refresh-token')
      ])
    );
    expect(res.redirect).toHaveBeenCalledWith('/network?auth=reddit_success');
  });

  it('redirects with a token exchange failure message', async () => {
    axios.post.mockRejectedValue({
      response: {
        data: {
          error: 'invalid_grant'
        }
      }
    });

    const req = createReq({
      query: { code: 'oauth-code', state: 'stored-state' },
      headers: { cookie: 'reddit_auth_state=stored-state' }
    });
    const res = createRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      '/network?error=Reddit%20token%20exchange%20failed%3A%20invalid_grant'
    );
  });
});
