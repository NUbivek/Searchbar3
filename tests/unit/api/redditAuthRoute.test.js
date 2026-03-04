jest.mock('../../../src/utils/oauthUtils', () => ({
  getCallbackUrl: jest.fn(() => 'https://example.com/api/auth/reddit/callback'),
}));

const { getCallbackUrl } = require('../../../src/utils/oauthUtils');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/auth/reddit/index').default;

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

describe('/api/auth/reddit', () => {
  const originalClientId = process.env.REDDIT_CLIENT_ID;
  const originalRedirectUri = process.env.REDDIT_REDIRECT_URI;
  const originalRandom = Math.random;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.REDDIT_CLIENT_ID;
    delete process.env.REDDIT_REDIRECT_URI;
  });

  afterAll(() => {
    Math.random = originalRandom;
    if (originalClientId) {
      process.env.REDDIT_CLIENT_ID = originalClientId;
    } else {
      delete process.env.REDDIT_CLIENT_ID;
    }
    if (originalRedirectUri) {
      process.env.REDDIT_REDIRECT_URI = originalRedirectUri;
    } else {
      delete process.env.REDDIT_REDIRECT_URI;
    }
  });

  test('returns 405 for non-GET requests', () => {
    const req = createMockReq({ method: 'POST' });
    const res = createRedirectRes();

    handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  test('returns fail-soft payload when client id is missing', () => {
    const req = createMockReq();
    const res = createRedirectRes();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      error: 'Configuration error',
      details: 'REDDIT_CLIENT_ID is not configured.',
      degradedSources: ['reddit-auth'],
    });
    expect(getCallbackUrl).not.toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
  });

  test('sets auth state cookie and redirects to reddit oauth', () => {
    process.env.REDDIT_CLIENT_ID = 'reddit-client-id';
    jest.spyOn(Math, 'random').mockReturnValue(0.123456);

    const req = createMockReq();
    const res = createRedirectRes();

    handler(req, res);

    expect(getCallbackUrl).toHaveBeenCalledWith('reddit');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.stringContaining('reddit_auth_state=')
    );
    expect(res.redirect).toHaveBeenCalledTimes(1);
    expect(res.redirectUrl).toContain('https://www.reddit.com/api/v1/authorize');
    expect(res.redirectUrl).toContain('client_id=reddit-client-id');
    expect(res.redirectUrl).toContain('scope=identity+read');
    expect(res.redirectUrl).toContain(
      encodeURIComponent('https://example.com/api/auth/reddit/callback')
    );
  });

  test('prefers explicit REDDIT_REDIRECT_URI over callback helper', () => {
    process.env.REDDIT_CLIENT_ID = 'reddit-client-id';
    process.env.REDDIT_REDIRECT_URI = 'https://custom.example.com/reddit/callback';
    jest.spyOn(Math, 'random').mockReturnValue(0.123456);

    const req = createMockReq();
    const res = createRedirectRes();

    handler(req, res);

    expect(getCallbackUrl).not.toHaveBeenCalled();
    expect(res.redirectUrl).toContain(
      encodeURIComponent('https://custom.example.com/reddit/callback')
    );
  });
});
