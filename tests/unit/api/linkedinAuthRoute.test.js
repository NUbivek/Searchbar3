jest.mock('../../../src/utils/oauthUtils', () => ({
  getCallbackUrl: jest.fn(() => 'https://example.com/api/auth/linkedin/callback'),
}));

const { getCallbackUrl } = require('../../../src/utils/oauthUtils');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/auth/linkedin/index').default;

function createRedirectRes() {
  const res = createMockRes();
  res.headers = {};
  res.redirectUrl = null;
  res.setHeader = jest.fn((name, value) => {
    res.headers[name] = value;
  });
  res.redirect = jest.fn((url) => {
    res.redirectUrl = url;
    return res;
  });
  return res;
}

describe('/api/auth/linkedin', () => {
  const originalClientId = process.env.LINKEDIN_CLIENT_ID;
  const originalRandom = Math.random;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.LINKEDIN_CLIENT_ID;
  });

  afterAll(() => {
    Math.random = originalRandom;
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
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  test('returns configuration error when client id is missing', () => {
    const req = createMockReq();
    const res = createRedirectRes();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      error: 'Configuration error',
      details: 'LinkedIn client ID is not configured.',
      degradedSources: ['linkedin-auth'],
    });
    expect(getCallbackUrl).toHaveBeenCalledWith('linkedin');
    expect(res.redirect).not.toHaveBeenCalled();
  });

  test('sets auth state cookie and redirects to linkedin oauth', () => {
    process.env.LINKEDIN_CLIENT_ID = 'linkedin-client-id';
    jest.spyOn(Math, 'random').mockReturnValue(0.123456);

    const req = createMockReq();
    const res = createRedirectRes();

    handler(req, res);

    expect(getCallbackUrl).toHaveBeenCalledWith('linkedin');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('linkedin_auth_state=')
    );
    expect(res.headers['Set-Cookie']).toContain('HttpOnly');
    expect(res.headers['Set-Cookie']).toContain('SameSite=Lax');
    expect(res.redirect).toHaveBeenCalledTimes(1);
    expect(res.redirectUrl).toContain('https://www.linkedin.com/oauth/v2/authorization');
    expect(res.redirectUrl).toContain('client_id=linkedin-client-id');
    expect(res.redirectUrl).toContain('response_type=code');
    expect(res.redirectUrl).toContain('scope=r_emailaddress+r_liteprofile');
    expect(res.redirectUrl).toContain(
      encodeURIComponent('https://example.com/api/auth/linkedin/callback')
    );

    const cookieState = res.headers['Set-Cookie']
      .split(';')[0]
      .split('=')[1];
    const redirectState = new URL(res.redirectUrl).searchParams.get('state');

    expect(cookieState).toBeTruthy();
    expect(redirectState).toBe(cookieState);
  });
});
