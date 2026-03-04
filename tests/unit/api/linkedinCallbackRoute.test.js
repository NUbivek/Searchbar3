jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

const axios = require('axios');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/auth/linkedin/callback').default;

function createRedirectRes() {
  const res = createMockRes();
  res.headers = {};
  res.redirectTarget = null;
  res.setHeader = jest.fn((name, value) => {
    res.headers[name] = value;
  });
  res.redirect = jest.fn((target) => {
    res.redirectTarget = target;
    return res;
  });
  return res;
}

describe('/api/auth/linkedin/callback', () => {
  const originalClientId = process.env.LINKEDIN_CLIENT_ID;
  const originalClientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  const originalBaseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  const originalRedirectUri = process.env.LINKEDIN_REDIRECT_URI;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.LINKEDIN_CLIENT_ID;
    delete process.env.LINKEDIN_CLIENT_SECRET;
    delete process.env.NEXT_PUBLIC_BASE_URL;
    delete process.env.LINKEDIN_REDIRECT_URI;
  });

  afterAll(() => {
    if (originalClientId) process.env.LINKEDIN_CLIENT_ID = originalClientId;
    else delete process.env.LINKEDIN_CLIENT_ID;

    if (originalClientSecret) process.env.LINKEDIN_CLIENT_SECRET = originalClientSecret;
    else delete process.env.LINKEDIN_CLIENT_SECRET;

    if (originalBaseUrl) process.env.NEXT_PUBLIC_BASE_URL = originalBaseUrl;
    else delete process.env.NEXT_PUBLIC_BASE_URL;

    if (originalRedirectUri) process.env.LINKEDIN_REDIRECT_URI = originalRedirectUri;
    else delete process.env.LINKEDIN_REDIRECT_URI;
  });

  test('redirects with auth error from linkedin', async () => {
    const req = createMockReq({
      query: {
        error: 'access_denied',
        error_description: 'User denied access',
      },
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=User%20denied%20access');
  });

  test('redirects when no authorization code is received', async () => {
    const req = createMockReq({ query: {} });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=No authorization code received');
  });

  test('redirects when linkedin credentials are missing', async () => {
    const req = createMockReq({ query: { code: 'auth-code' } });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=LinkedIn API credentials not configured');
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('sets cookies and redirects on successful callback exchange', async () => {
    process.env.LINKEDIN_CLIENT_ID = 'linkedin-client-id';
    process.env.LINKEDIN_CLIENT_SECRET = 'linkedin-client-secret';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://example.com';

    axios.post.mockResolvedValueOnce({
      data: {
        access_token: 'linkedin-access-token',
        expires_in: 7200,
      },
    });

    axios.get.mockResolvedValueOnce({
      data: {
        id: 'linkedin-user',
      },
    });

    const req = createMockReq({ query: { code: 'auth-code' } });
    const res = createRedirectRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledWith(
      'https://www.linkedin.com/oauth/v2/accessToken',
      null,
      {
        params: {
          grant_type: 'authorization_code',
          code: 'auth-code',
          redirect_uri: 'https://example.com/api/auth/linkedin/callback',
          client_id: 'linkedin-client-id',
          client_secret: 'linkedin-client-secret',
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10000,
      }
    );
    expect(axios.get).toHaveBeenCalledWith('https://api.linkedin.com/v2/me', {
      headers: {
        Authorization: 'Bearer linkedin-access-token',
      },
      timeout: 10000,
    });
    expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', [
      'linkedin_access_token=linkedin-access-token; Path=/; Max-Age=7200; HttpOnly; SameSite=Lax',
      'linkedin_user_id=linkedin-user; Path=/; Max-Age=7200; SameSite=Lax',
    ]);
    expect(res.redirect).toHaveBeenCalledWith('/network?auth=linkedin_success');
  });

  test('redirects with detailed failure when token exchange fails', async () => {
    process.env.LINKEDIN_CLIENT_ID = 'linkedin-client-id';
    process.env.LINKEDIN_CLIENT_SECRET = 'linkedin-client-secret';

    axios.post.mockRejectedValueOnce({
      response: {
        data: {
          error_description: 'Invalid authorization code',
        },
      },
    });

    const req = createMockReq({ query: { code: 'bad-code' } });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith(
      '/network?error=Failed%20to%20authenticate%20with%20LinkedIn%3A%20Invalid%20authorization%20code'
    );
  });
});
