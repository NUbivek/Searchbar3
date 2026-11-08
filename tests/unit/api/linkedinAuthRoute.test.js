jest.mock('../../../src/utils/oauthUtils', () => ({
  getCallbackUrl: jest.fn(() => 'https://example.com/api/auth/linkedin/callback'),
}));

const { getCallbackUrl } = require('../../../src/utils/oauthUtils');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/auth/linkedin/index').default;

function createRedirectRes() {
  const res = createMockRes();
  res.redirectUrl = null;
  res.redirect = jest.fn((url) => {
    res.redirectUrl = url;
    return res;
  });
  return res;
}

describe('/api/auth/linkedin', () => {
  const originalClientId = process.env.LINKEDIN_CLIENT_ID;
  let logSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.LINKEDIN_CLIENT_ID;
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalClientId) {
      process.env.LINKEDIN_CLIENT_ID = originalClientId;
    } else {
      delete process.env.LINKEDIN_CLIENT_ID;
    }
  });

  test('returns 405 for non-GET requests', () => {
    const req = createMockReq({ method: 'POST' });
    const res = createRedirectRes();

    handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  test('sends the user back to /network with an error code (not developer copy) when the client id is missing', () => {
    const req = createMockReq();
    const res = createRedirectRes();

    handler(req, res);

    // The page maps the code to user-facing copy; env var names never reach the browser.
    expect(res.redirect).toHaveBeenCalledTimes(1);
    expect(res.redirectUrl).toBe('/network?error=linkedin_not_configured');
    expect(res.redirectUrl).not.toMatch(/LINKEDIN_CLIENT|\.env/);
    expect(res.headers['Set-Cookie']).toBeUndefined();
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  test('sets the auth state cookie and redirects to LinkedIn with the same state', () => {
    process.env.LINKEDIN_CLIENT_ID = 'linkedin-client-id';

    const req = createMockReq({ headers: { host: 'localhost:3000' } });
    const res = createRedirectRes();

    handler(req, res);

    expect(getCallbackUrl).toHaveBeenCalledWith('linkedin', req);
    const cookie = res.headers['Set-Cookie'];
    // State is 16 random bytes (hex) and the cookie expires after 10 minutes
    expect(cookie).toMatch(/^linkedin_auth_state=[0-9a-f]{32};/);
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');

    expect(res.redirect).toHaveBeenCalledTimes(1);
    expect(res.redirectUrl.startsWith('https://www.linkedin.com/oauth/v2/authorization?')).toBe(true);
    const params = new URL(res.redirectUrl).searchParams;
    expect(params.get('client_id')).toBe('linkedin-client-id');
    expect(params.get('response_type')).toBe('code');
    expect(params.get('redirect_uri')).toBe('https://example.com/api/auth/linkedin/callback');
    expect(params.get('scope')).toBe('openid profile email');
    expect(params.get('state')).toBe(cookie.split(';')[0].split('=')[1]);
    // OAuth parameters (client id, authorization URL, state) are not logged.
    expect(logSpy).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });
});
