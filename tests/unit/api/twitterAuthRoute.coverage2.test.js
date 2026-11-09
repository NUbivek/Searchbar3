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

  // A short code the network page maps to user copy; no env var names or file paths.
  const X_NOT_CONFIGURED = '/network?error=twitter_not_configured';

  it('redirects to /network with a configuration error when TWITTER_CLIENT_ID is missing', async () => {
    const req = createReq();
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(res.body).toBeNull();
    expect(res.headers['Set-Cookie']).toBeUndefined();
    expect(res.headers.Location).toBe(X_NOT_CONFIGURED);
  });

  it('does not fall back to TWITTER_API_KEY when TWITTER_CLIENT_ID is missing', async () => {
    process.env.TWITTER_API_KEY = 'legacy-api-key';

    const req = createReq();
    const res = createRes();

    await handler(req, res);

    expect(res.headers.Location).toBe(X_NOT_CONFIGURED);
    expect(res.headers.Location).not.toContain('legacy-api-key');
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

    // State is 16 random bytes in hex.
    const state = cookies[0].match(/twitter_auth_state=([^;]+)/)[1];
    expect(state).toMatch(/^[0-9a-f]{32}$/);

    // PKCE: S256 challenge derived from a random base64url verifier stored in the cookie.
    const verifier = cookies[1].match(/twitter_code_verifier=([^;]+)/)[1];
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);

    const authorizeUrl = new URL(res.headers.Location);
    expect(authorizeUrl.searchParams.get('state')).toBe(state);
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    const expectedChallenge = require('crypto').createHash('sha256').update(verifier).digest('base64url');
    expect(authorizeUrl.searchParams.get('code_challenge')).toBe(expectedChallenge);
    expect(authorizeUrl.searchParams.get('code_challenge')).not.toBe(verifier);
  });
});
