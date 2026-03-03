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

  test('returns configuration error when client id is missing', () => {
    const req = createMockReq();
    const res = createRedirectRes();

    handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'Configuration error',
      details: 'LinkedIn client ID is not configured.',
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
    expect(res.redirect).toHaveBeenCalledTimes(1);
    expect(res.redirectUrl).toContain('https://www.linkedin.com/oauth/v2/authorization');
    expect(res.redirectUrl).toContain('client_id=linkedin-client-id');
    expect(res.redirectUrl).toContain('response_type=code');
    expect(res.redirectUrl).toContain('scope=r_emailaddress+r_liteprofile');
    expect(res.redirectUrl).toContain(
      encodeURIComponent('https://example.com/api/auth/linkedin/callback')
    );
  });
});
