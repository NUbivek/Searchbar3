jest.mock('axios', () => ({
  post: jest.fn(),
}));

const axios = require('axios');
const handler = require('../../../src/pages/api/auth/reddit/callback').default;

function createRes() {
  return {
    setHeader: jest.fn(),
    redirect: jest.fn(),
  };
}

describe('/api/auth/reddit/callback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_CLIENT_SECRET;
    delete process.env.REDDIT_REDIRECT_URI;
    delete process.env.NEXT_PUBLIC_BASE_URL;
  });

  it('redirects non-GET requests back to the network page', async () => {
    const req = { method: 'POST', query: {}, headers: {} };
    const res = createRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=Method%20not%20allowed');
  });

  it('redirects provider errors back to the network page', async () => {
    const req = { query: { error: 'access_denied' }, headers: {} };
    const res = createRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=access_denied');
  });

  it('redirects when the auth code is missing', async () => {
    const req = { query: {}, headers: {} };
    const res = createRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      '/network?error=No authorization code received from Reddit'
    );
  });

  it('rejects invalid oauth state values', async () => {
    const req = {
      query: { code: 'abc', state: 'from-query' },
      headers: { cookie: 'reddit_auth_state=stored-state' },
    };
    const res = createRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      '/network?error=Invalid Reddit OAuth state'
    );
  });

  it('redirects when reddit credentials are missing', async () => {
    const req = { query: { code: 'abc' }, headers: {} };
    const res = createRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      '/network?error=Missing Reddit client credentials'
    );
  });

  it('sets auth cookies and redirects on successful token exchange', async () => {
    process.env.REDDIT_CLIENT_ID = 'client-id';
    process.env.REDDIT_CLIENT_SECRET = 'client-secret';
    process.env.REDDIT_REDIRECT_URI = 'https://example.com/callback';

    axios.post.mockResolvedValue({
      data: {
        access_token: 'token-123',
        refresh_token: 'refresh-456',
        expires_in: 3600,
      },
    });

    const req = { query: { code: 'abc', state: 'same-state' }, headers: { cookie: 'reddit_auth_state=same-state' } };
    const res = createRes();

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
    expect(res.setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.arrayContaining([
        expect.stringContaining('reddit_access_token=token-123'),
        expect.stringContaining('reddit_refresh_token=refresh-456'),
      ])
    );
    expect(res.redirect).toHaveBeenCalledWith('/network?auth=reddit_success');
  });

  it('redirects with a token exchange error when reddit rejects the code', async () => {
    process.env.REDDIT_CLIENT_ID = 'client-id';
    process.env.REDDIT_CLIENT_SECRET = 'client-secret';

    axios.post.mockRejectedValue({
      response: { data: { error: 'invalid_grant' } },
    });

    const req = { query: { code: 'abc' }, headers: {} };
    const res = createRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      '/network?error=Reddit%20token%20exchange%20failed%3A%20invalid_grant'
    );
  });
});
