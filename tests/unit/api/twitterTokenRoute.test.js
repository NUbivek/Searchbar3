import axios from 'axios';
import handler from '../../../src/pages/api/auth/twitter/token';
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

describe('/api/auth/twitter/token', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns unauthenticated when no access token cookie is present', async () => {
    const req = createMockReq({
      method: 'GET',
      headers: {},
      connection: { remoteAddress: '127.0.0.1' },
    });
    const res = createHeaderRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      error: 'Not authenticated with Twitter',
      authenticated: false,
    });
  });

  it('rejects unsupported methods', async () => {
    const req = createMockReq({ method: 'DELETE' });
    const res = createHeaderRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('rejects post requests with no valid parameters', async () => {
    const req = createMockReq({ method: 'POST', body: {} });
    const res = createHeaderRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request parameters' });
  });

  it('rejects refresh requests with no refresh cookie', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { refresh: true },
      headers: {},
    });
    const res = createHeaderRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'No refresh token available' });
  });

  it('returns fail-soft payload when code exchange credentials are missing', async () => {
    delete process.env.TWITTER_CLIENT_ID;
    delete process.env.TWITTER_API_KEY;
    delete process.env.TWITTER_CLIENT_SECRET;

    const req = createMockReq({
      method: 'POST',
      body: { code: 'auth-code' },
      headers: {},
    });
    const res = createHeaderRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      error: 'Twitter API credentials not configured',
      degradedSources: ['twitter-auth-token'],
    });
  });

  it('exchanges an authorization code and returns the Twitter profile', async () => {
    process.env.TWITTER_CLIENT_ID = 'twitter-client-id';
    process.env.TWITTER_CLIENT_SECRET = 'twitter-client-secret';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://example.com';

    axios.post.mockResolvedValueOnce({
      data: {
        access_token: 'twitter-access-token',
        refresh_token: 'twitter-refresh-token',
        expires_in: 7200,
      },
    });
    axios.get.mockResolvedValueOnce({
      data: {
        data: {
          id: '123',
          username: 'operator',
          name: 'Operator User',
        },
      },
    });

    const req = createMockReq({
      method: 'POST',
      body: { code: 'auth-code' },
      headers: {
        cookie: 'twitter_code_verifier=verifier-token',
      },
    });
    const res = createHeaderRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledWith(
      'https://api.twitter.com/2/oauth2/token',
      expect.any(String),
      expect.objectContaining({
        timeout: 10000,
        headers: expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: expect.stringContaining('Basic '),
        }),
      })
    );
    expect(axios.get).toHaveBeenCalledWith(
      'https://api.twitter.com/2/users/me',
      expect.objectContaining({
        timeout: 10000,
        headers: expect.objectContaining({
          Authorization: 'Bearer twitter-access-token',
        }),
      })
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Set-Cookie',
      expect.arrayContaining([
        expect.stringContaining('twitter_access_token=twitter-access-token'),
        expect.stringContaining('twitter_refresh_token=twitter-refresh-token'),
      ])
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      profile: {
        id: '123',
        username: 'operator',
        name: 'Operator User',
      },
      accessToken: 'twitter-ac...',
    });
  });
});
