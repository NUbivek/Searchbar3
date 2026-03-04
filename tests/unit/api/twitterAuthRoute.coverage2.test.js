import handler from '../../../src/pages/api/auth/twitter/index';

function createReq(overrides = {}) {
  return {
    method: 'GET',
    headers: {},
    ...overrides,
  };
}

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    redirect(codeOrUrl, maybeUrl) {
      if (typeof maybeUrl === 'string') {
        this.statusCode = codeOrUrl;
        this.headers.Location = maybeUrl;
      } else {
        this.statusCode = 302;
        this.headers.Location = codeOrUrl;
      }
      return this;
    },
  };
}

describe('/api/auth/twitter', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TWITTER_API_KEY;
    delete process.env.TWITTER_CLIENT_ID;
    delete process.env.NEXT_PUBLIC_BASE_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns fail-soft payload when twitter credentials are missing', async () => {
    const req = createReq();
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      error: 'Configuration error',
      details: 'Twitter API key is not configured.',
      degradedSources: ['twitter-auth'],
    });
  });

  it('sets cookies and redirects to the twitter authorize url', async () => {
    process.env.TWITTER_CLIENT_ID = 'client-123';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://airesearch.bivek.ai';

    const req = createReq();
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(res.headers.Location).toContain('https://twitter.com/i/oauth2/authorize?');
    expect(res.headers.Location).toContain('client_id=client-123');
    expect(res.headers.Location).toContain(
      encodeURIComponent('https://airesearch.bivek.ai/api/auth/twitter/callback')
    );

    const cookies = res.headers['Set-Cookie'];
    expect(Array.isArray(cookies)).toBe(true);
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain('twitter_auth_state=');
    expect(cookies[0]).toContain('HttpOnly');
    expect(cookies[1]).toContain('twitter_code_verifier=');
    expect(cookies[1]).toContain('HttpOnly');
  });
});
