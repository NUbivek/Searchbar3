jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

const axios = require('axios');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/auth/linkedin/token').default;

function createHeaderRes() {
  const res = createMockRes();
  res.headers = {};
  res.setHeader = jest.fn((name, value) => {
    res.headers[name] = value;
  });
  return res;
}

describe('/api/auth/linkedin/token', () => {
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
    if (originalClientId) {
      process.env.LINKEDIN_CLIENT_ID = originalClientId;
    } else {
      delete process.env.LINKEDIN_CLIENT_ID;
    }

    if (originalClientSecret) {
      process.env.LINKEDIN_CLIENT_SECRET = originalClientSecret;
    } else {
      delete process.env.LINKEDIN_CLIENT_SECRET;
    }

    if (originalBaseUrl) {
      process.env.NEXT_PUBLIC_BASE_URL = originalBaseUrl;
    } else {
      delete process.env.NEXT_PUBLIC_BASE_URL;
    }

    if (originalRedirectUri) {
      process.env.LINKEDIN_REDIRECT_URI = originalRedirectUri;
    } else {
      delete process.env.LINKEDIN_REDIRECT_URI;
    }
  });

  test('returns unauthenticated on GET when no linkedin cookie exists', async () => {
    const req = createMockReq({ method: 'GET', cookies: {} });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ isAuthenticated: false });
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('returns authenticated user on GET when token is valid', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        id: 'linkedin-user',
        localizedFirstName: 'Ada',
        localizedLastName: 'Lovelace',
      },
    });

    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'valid-token' },
    });
    const res = createHeaderRes();

    await handler(req, res);

    expect(axios.get).toHaveBeenCalledWith('https://api.linkedin.com/v2/me', {
      headers: {
        Authorization: 'Bearer valid-token',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      isAuthenticated: true,
      provider: 'linkedin',
      user: {
        id: 'linkedin-user',
        firstName: 'Ada',
        lastName: 'Lovelace',
      },
    });
  });

  test('clears cookies on GET when token is invalid', async () => {
    axios.get.mockRejectedValueOnce(new Error('expired'));

    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'expired-token' },
    });
    const res = createHeaderRes();

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', [
      'linkedin_access_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      'linkedin_user_id=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      isAuthenticated: false,
      error: 'Token invalid or expired',
    });
  });

  test('rejects unsupported methods outside GET and POST', async () => {
    const req = createMockReq({ method: 'PUT' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  test('requires an authorization code for POST', async () => {
    const req = createMockReq({ method: 'POST', body: {} });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Authorization code is required' });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('returns fail-soft payload when linkedin credentials are missing', async () => {
    const req = createMockReq({ method: 'POST', body: { code: 'auth-code' } });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      error: 'LinkedIn API credentials not configured',
      degradedSources: ['linkedin-auth-token'],
    });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('exchanges code and returns linkedin profile payload', async () => {
    process.env.LINKEDIN_CLIENT_ID = 'linkedin-client-id';
    process.env.LINKEDIN_CLIENT_SECRET = 'linkedin-client-secret';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://example.com';

    axios.post.mockResolvedValueOnce({
      data: {
        access_token: 'linkedin-access-token',
        expires_in: 7200,
      },
    });

    axios.get
      .mockResolvedValueOnce({
        data: {
          id: 'linkedin-user',
          localizedFirstName: 'Grace',
          localizedLastName: 'Hopper',
        },
      })
      .mockResolvedValueOnce({
        data: {
          elements: [
            {
              'handle~': {
                emailAddress: 'grace@example.com',
              },
            },
          ],
        },
      });

    const req = createMockReq({ method: 'POST', body: { code: 'auth-code' } });
    const res = createHeaderRes();

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
      }
    );
    expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', [
      'linkedin_access_token=linkedin-access-token; Path=/; Max-Age=7200; HttpOnly; SameSite=Lax',
      'linkedin_user_id=linkedin-user; Path=/; Max-Age=7200; SameSite=Lax',
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      profile: {
        id: 'linkedin-user',
        firstName: 'Grace',
        lastName: 'Hopper',
        email: 'grace@example.com',
      },
      accessToken: 'linkedin-access-token',
      expiresIn: 7200,
    });
  });
});
