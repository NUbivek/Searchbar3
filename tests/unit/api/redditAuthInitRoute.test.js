jest.mock('../../../src/utils/oauthUtils', () => ({
  getCallbackUrl: jest.fn(() => 'https://example.com/reddit/callback'),
}));

import handler from '../../../src/pages/api/auth/reddit/index';

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    redirectUrl: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    redirect(url) {
      this.redirectUrl = url;
      return this;
    },
  };
}

describe('/api/auth/reddit', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_REDIRECT_URI;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns 500 when REDDIT_CLIENT_ID is missing', async () => {
    const req = { method: 'GET' };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'Configuration error',
      details: 'REDDIT_CLIENT_ID is not configured.',
    });
  });

  it('sets state cookie and redirects to the reddit authorize url', async () => {
    process.env.REDDIT_CLIENT_ID = 'reddit-client-id';
    process.env.REDDIT_REDIRECT_URI = 'https://example.com/custom/callback';

    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.123456789);
    const req = { method: 'GET' };
    const res = createMockRes();

    await handler(req, res);

    expect(res.headers['Set-Cookie']).toContain('reddit_auth_state=');
    expect(res.headers['Set-Cookie']).toContain('Path=/');
    expect(res.headers['Set-Cookie']).toContain('HttpOnly');
    expect(res.headers['Set-Cookie']).toContain('SameSite=Lax');

    const redirectUrl = new URL(res.redirectUrl);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(
      'https://www.reddit.com/api/v1/authorize'
    );
    expect(redirectUrl.searchParams.get('client_id')).toBe('reddit-client-id');
    expect(redirectUrl.searchParams.get('response_type')).toBe('code');
    expect(redirectUrl.searchParams.get('redirect_uri')).toBe(
      'https://example.com/custom/callback'
    );
    expect(redirectUrl.searchParams.get('duration')).toBe('permanent');
    expect(redirectUrl.searchParams.get('scope')).toBe('identity read');
    expect(redirectUrl.searchParams.get('state')).toBeTruthy();

    randomSpy.mockRestore();
  });
});
