import handler from '../../../src/pages/api/auth/linkedin/index';

jest.mock('../../../src/utils/oauthUtils', () => ({
  getCallbackUrl: jest.fn(() => 'https://example.com/api/auth/linkedin/callback'),
}));

describe('/api/auth/linkedin', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.LINKEDIN_CLIENT_ID;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function createRes() {
    return {
      statusCode: 200,
      headers: {},
      jsonPayload: null,
      redirectedTo: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.jsonPayload = payload;
        return this;
      },
      setHeader(name, value) {
        this.headers[name] = value;
      },
      redirect(url) {
        this.redirectedTo = url;
        return this;
      },
    };
  }

  it('returns fail-soft payload when LinkedIn client id is missing', async () => {
    const req = { method: 'GET' };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload).toEqual({
      status: 'fail-soft',
      error: 'Configuration error',
      details: 'LinkedIn client ID is not configured.',
      degradedSources: ['linkedin-auth'],
    });
  });

  it('sets auth state cookie and redirects to LinkedIn auth url', async () => {
    process.env.LINKEDIN_CLIENT_ID = 'linkedin-client-id';

    const req = { method: 'GET' };
    const res = createRes();

    await handler(req, res);

    expect(res.headers['Set-Cookie']).toContain('linkedin_auth_state=');
    expect(res.headers['Set-Cookie']).toContain('HttpOnly');
    expect(res.redirectedTo).toBeTruthy();

    const redirected = new URL(res.redirectedTo);
    expect(redirected.origin + redirected.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(redirected.searchParams.get('response_type')).toBe('code');
    expect(redirected.searchParams.get('client_id')).toBe('linkedin-client-id');
    expect(redirected.searchParams.get('redirect_uri')).toBe('https://example.com/api/auth/linkedin/callback');
    expect(redirected.searchParams.get('scope')).toBe('r_emailaddress r_liteprofile');
    expect(redirected.searchParams.get('state')).toBeTruthy();
  });
});
