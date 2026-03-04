import axios from 'axios';
import handler from '../../../src/pages/api/auth/facebook/token';
import { createMockReq, createMockRes } from './testUtils';

jest.mock('axios', () => ({
  get: jest.fn(),
}));

describe('/api/auth/facebook/token', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.FACEBOOK_APP_ID;
    delete process.env.FACEBOOK_APP_SECRET;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns 400 when code is missing', async () => {
    const req = createMockReq({ method: 'POST', body: {} });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Authorization code is required' });
  });

  it('returns fail-soft payload when Facebook credentials are missing', async () => {
    const req = createMockReq({ method: 'POST', body: { code: 'auth-code' } });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      error: 'Facebook API credentials not configured',
      degradedSources: ['facebook-auth-token'],
    });
  });

  it('returns normalized token, profile, and friends on success', async () => {
    process.env.FACEBOOK_APP_ID = 'app-id';
    process.env.FACEBOOK_APP_SECRET = 'app-secret';
    process.env.NEXT_PUBLIC_APP_URL = 'https://example.com';

    axios.get
      .mockResolvedValueOnce({ data: { access_token: 'token123', expires_in: 3600 } })
      .mockResolvedValueOnce({ data: { id: '1', name: 'User Example', email: 'user@example.com' } })
      .mockResolvedValueOnce({ data: { data: [{ id: 'friend-1' }] } });

    const req = createMockReq({ method: 'POST', body: { code: 'auth-code' } });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      profile: { id: '1', name: 'User Example', email: 'user@example.com' },
      friends: { data: [{ id: 'friend-1' }] },
      accessToken: 'token123',
      expiresIn: 3600,
    });
    expect(axios.get).toHaveBeenCalledTimes(3);
  });

  it('returns fail-soft payload with failure details when exchange fails', async () => {
    process.env.FACEBOOK_APP_ID = 'app-id';
    process.env.FACEBOOK_APP_SECRET = 'app-secret';

    axios.get.mockRejectedValueOnce(new Error('boom'));

    const req = createMockReq({ method: 'POST', body: { code: 'auth-code' } });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      error: 'Failed to exchange Facebook authorization code',
      details: 'boom',
      degradedSources: ['facebook-auth-token'],
    });
  });
});
