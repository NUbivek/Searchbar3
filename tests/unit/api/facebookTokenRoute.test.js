jest.mock('axios', () => ({
  get: jest.fn(),
}));

const axios = require('axios');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/auth/facebook/token').default;

describe('/api/auth/facebook/token', () => {
  const originalAppId = process.env.FACEBOOK_APP_ID;
  const originalAppSecret = process.env.FACEBOOK_APP_SECRET;
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FACEBOOK_APP_ID;
    delete process.env.FACEBOOK_APP_SECRET;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  afterAll(() => {
    if (originalAppId) {
      process.env.FACEBOOK_APP_ID = originalAppId;
    } else {
      delete process.env.FACEBOOK_APP_ID;
    }

    if (originalAppSecret) {
      process.env.FACEBOOK_APP_SECRET = originalAppSecret;
    } else {
      delete process.env.FACEBOOK_APP_SECRET;
    }

    if (originalAppUrl) {
      process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    } else {
      delete process.env.NEXT_PUBLIC_APP_URL;
    }
  });

  test('rejects non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('requires an authorization code', async () => {
    const req = createMockReq({ method: 'POST', body: {} });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Authorization code is required' });
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('returns fail-soft payload when facebook credentials are missing', async () => {
    const req = createMockReq({ method: 'POST', body: { code: 'auth-code' } });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      error: 'Facebook API credentials not configured',
      degradedSources: ['facebook-auth-token'],
    });
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('exchanges code and returns facebook profile payload', async () => {
    process.env.FACEBOOK_APP_ID = 'facebook-app-id';
    process.env.FACEBOOK_APP_SECRET = 'facebook-app-secret';
    process.env.NEXT_PUBLIC_APP_URL = 'https://example.com';

    axios.get
      .mockResolvedValueOnce({
        data: {
          access_token: 'facebook-access-token',
          expires_in: 3600,
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: 'user-id',
          name: 'Jane Founder',
          email: 'jane@example.com',
        },
      })
      .mockResolvedValueOnce({
        data: {
          data: [{ id: 'friend-1' }],
        },
      });

    const req = createMockReq({ method: 'POST', body: { code: 'auth-code' } });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.get).toHaveBeenNthCalledWith(
      1,
      'https://graph.facebook.com/v17.0/oauth/access_token',
      {
        params: {
          client_id: 'facebook-app-id',
          client_secret: 'facebook-app-secret',
          code: 'auth-code',
          redirect_uri: 'https://example.com/api/auth/facebook/callback',
        },
      }
    );
    expect(axios.get).toHaveBeenNthCalledWith(
      2,
      'https://graph.facebook.com/me',
      {
        params: {
          fields: 'id,name,email,picture',
          access_token: 'facebook-access-token',
        },
      }
    );
    expect(axios.get).toHaveBeenNthCalledWith(
      3,
      'https://graph.facebook.com/me/friends',
      {
        params: {
          access_token: 'facebook-access-token',
        },
      }
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      profile: {
        id: 'user-id',
        name: 'Jane Founder',
        email: 'jane@example.com',
      },
      friends: {
        data: [{ id: 'friend-1' }],
      },
      accessToken: 'facebook-access-token',
      expiresIn: 3600,
    });
  });
});
