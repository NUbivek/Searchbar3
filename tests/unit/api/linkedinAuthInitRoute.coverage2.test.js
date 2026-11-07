import handler from '../../../src/pages/api/auth/linkedin/index';

jest.mock('../../../src/utils/oauthUtils', () => ({
  getCallbackUrl: jest.fn(),
}));

const { getCallbackUrl } = require('../../../src/utils/oauthUtils');

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
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
    redirect(url) {
      this.statusCode = 302;
      this.headers.Location = url;
      return this;
    },
  };
}

describe('/api/auth/linkedin', () => {
  const originalEnv = process.env;
  const originalRandom = Math.random;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    Math.random = jest.fn(() => 0.123456789);
    getCallbackUrl.mockReturnValue('https://example.com/api/auth/linkedin/token');
  });

  afterEach(() => {
    process.env = originalEnv;
    Math.random = originalRandom;
  });

  it('redirects to /network with a configuration error when LINKEDIN_CLIENT_ID is missing', async () => {
    delete process.env.LINKEDIN_CLIENT_ID;

    const req = { method: 'GET' };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    expect(res.body).toBeUndefined();
    expect(res.headers['Set-Cookie']).toBeUndefined();
    const redirectUrl = new URL(res.headers.Location, 'https://example.com');
    expect(redirectUrl.pathname).toBe('/network');
    expect(redirectUrl.searchParams.get('error')).toBe(
      'LinkedIn is not configured yet: add LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET to .env.local and restart the dev server.'
    );
  });

  it('sets the auth state cookie and redirects to LinkedIn', async () => {
    process.env.LINKEDIN_CLIENT_ID = 'linkedin-client-id';

    const req = { method: 'GET' };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(302);
    // State is 16 random bytes (hex) and the cookie expires after 10 minutes
    const cookieState = res.headers['Set-Cookie'].match(/linkedin_auth_state=([0-9a-f]{32});/)[1];
    expect(res.headers['Set-Cookie']).toContain('Max-Age=600');
    expect(res.headers['Set-Cookie']).toContain('HttpOnly');
    expect(res.headers['Set-Cookie']).toContain('SameSite=Lax');

    const redirectUrl = new URL(res.headers.Location);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(redirectUrl.searchParams.get('response_type')).toBe('code');
    expect(redirectUrl.searchParams.get('client_id')).toBe('linkedin-client-id');
    expect(redirectUrl.searchParams.get('redirect_uri')).toBe('https://example.com/api/auth/linkedin/token');
    expect(redirectUrl.searchParams.get('state')).toBe(cookieState);
    expect(redirectUrl.searchParams.get('scope')).toBe('openid profile email');
  });
});
