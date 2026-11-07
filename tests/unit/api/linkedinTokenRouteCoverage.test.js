import axios from 'axios';
import handler from '../../../src/pages/api/auth/linkedin/token';
import { createMockReq, createMockRes } from './testUtils';

jest.mock('axios');

function createHeaderRes() {
  const res = createMockRes();
  const headers = {};

  res.setHeader = jest.fn((name, value) => {
    headers[name] = value;
  });
  res.getHeader = jest.fn((name) => headers[name]);

  return res;
}

describe('/api/auth/linkedin/token', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('rejects unsupported methods', async () => {
    const req = createMockReq({ method: 'DELETE' });
    const res = createHeaderRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns unauthenticated on get when no linkedin cookie is present', async () => {
    const req = createMockReq({ method: 'GET', cookies: {} });
    const res = createHeaderRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ isAuthenticated: false });
  });

  it('returns authenticated on get when the linkedin token is valid', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        sub: 'ln-123',
        given_name: 'Ada',
        family_name: 'Lovelace',
        name: 'Ada Lovelace',
      },
    });

    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'valid-token' },
    });
    const res = createHeaderRes();

    await handler(req, res);

    expect(axios.get).toHaveBeenCalledWith('https://api.linkedin.com/v2/userinfo', {
      headers: {
        Authorization: 'Bearer valid-token',
      },
      timeout: 10000,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      isAuthenticated: true,
      provider: 'linkedin',
      user: {
        id: 'ln-123',
        firstName: 'Ada',
        lastName: 'Lovelace',
      },
    });
  });

  it('clears cookies and returns unauthenticated when the linkedin token is invalid', async () => {
    axios.get.mockRejectedValueOnce(new Error('invalid token'));

    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'expired-token' },
    });
    const res = createHeaderRes();

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.arrayContaining([
        expect.stringContaining('linkedin_access_token='),
        expect.stringContaining('linkedin_user_id='),
      ])
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      isAuthenticated: false,
      error: 'Token invalid or expired',
    });
  });

  it('rejects post requests without an authorization code', async () => {
    const req = createMockReq({ method: 'POST', body: {} });
    const res = createHeaderRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Authorization code is required' });
  });

  it('returns a configuration error when linkedin credentials are missing', async () => {
    delete process.env.LINKEDIN_CLIENT_ID;
    delete process.env.LINKEDIN_CLIENT_SECRET;

    const req = createMockReq({
      method: 'POST',
      body: { code: 'auth-code' },
    });
    const res = createHeaderRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      error: 'LinkedIn API credentials not configured',
      degradedSources: ['linkedin-auth-token'],
    });
  });

  it('exchanges a code, fetches the userinfo profile, sets cookies, and returns normalized data', async () => {
    process.env.LINKEDIN_CLIENT_ID = 'linkedin-client-id';
    process.env.LINKEDIN_CLIENT_SECRET = 'linkedin-client-secret';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://example.com';

    axios.post.mockResolvedValueOnce({
      data: {
        access_token: 'linkedin-access-token',
        expires_in: 3600,
      },
    });
    // OpenID Connect subject identifiers may contain characters that are
    // not cookie-safe, so the route must URL-encode the user id cookie.
    axios.get.mockResolvedValueOnce({
      data: {
        sub: 'ln 999/x',
        given_name: 'Grace',
        family_name: 'Hopper',
        name: 'Grace Hopper',
        email: 'grace@example.com',
      },
    });

    const req = createMockReq({
      method: 'POST',
      body: { code: 'auth-code' },
    });
    const res = createHeaderRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get.mock.calls[0][0]).toBe('https://api.linkedin.com/v2/userinfo');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.arrayContaining([
        expect.stringContaining('linkedin_access_token=linkedin-access-token'),
        expect.stringContaining(`linkedin_user_id=${encodeURIComponent('ln 999/x')};`),
      ])
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      profile: {
        id: 'ln 999/x',
        firstName: 'Grace',
        lastName: 'Hopper',
        email: 'grace@example.com',
      },
      accessToken: 'linkedin-access-token',
      expiresIn: 3600,
    });
  });

  it('returns a detailed error when code exchange fails', async () => {
    process.env.LINKEDIN_CLIENT_ID = 'linkedin-client-id';
    process.env.LINKEDIN_CLIENT_SECRET = 'linkedin-client-secret';

    axios.post.mockRejectedValueOnce({
      response: {
        data: {
          error_description: 'bad verification code',
        },
      },
    });

    const req = createMockReq({
      method: 'POST',
      body: { code: 'bad-code' },
    });
    const res = createHeaderRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      error: 'Failed to exchange LinkedIn authorization code',
      details: 'bad verification code',
      degradedSources: ['linkedin-auth-token'],
    });
  });
});
