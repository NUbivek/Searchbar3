const { createMockReq, createMockRes } = require('./testUtils');

jest.mock('axios', () => ({
  get: jest.fn(),
}));

const axios = require('axios');
const handler = require('../../../src/pages/api/network/linkedin').default;

describe('/api/network/linkedin', () => {
  const originalBaseUrl = process.env.NEXT_PUBLIC_BASE_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    axios.get.mockReset(); // don't leak queued responses between tests
    process.env.NEXT_PUBLIC_BASE_URL = 'https://example.com';
  });

  afterAll(() => {
    process.env.NEXT_PUBLIC_BASE_URL = originalBaseUrl;
  });

  test('rejects non-GET requests', async () => {
    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('requires a linkedin access token', async () => {
    const req = createMockReq({ method: 'GET', cookies: {} });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Not authenticated with LinkedIn' });
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('returns combined profile and connection data', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: { sub: 'user-1', given_name: 'Avery', family_name: 'Stone', name: 'Avery Stone', email: 'avery@example.com', picture: 'avatar-url' },
      })
      .mockResolvedValueOnce({
        data: { elements: [{ miniProfile: { id: '2', firstName: 'Jordan', lastName: 'Lee', occupation: 'Acme' } }] },
      });

    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'token-123' },
      headers: { cookie: 'linkedin_access_token=token-123' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.get).toHaveBeenNthCalledWith(
      1,
      'https://api.linkedin.com/v2/userinfo',
      { headers: { Authorization: 'Bearer token-123' }, timeout: 10000 }
    );
    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
    expect(res.body.user).toEqual({
      id: 'user-1',
      firstName: 'Avery',
      lastName: 'Stone',
      profilePicture: 'avatar-url',
      email: 'avery@example.com',
    });
    expect(res.body.connections).toEqual([
      expect.objectContaining({ id: 'linkedin-2', name: 'Jordan Lee', company: 'Acme' }),
    ]);
  });

  test('returns 401 when linkedin reports an expired token', async () => {
    axios.get.mockRejectedValueOnce({
      response: {
        status: 401,
        data: { message: 'expired' },
      },
      message: 'Request failed with status code 401',
    });

    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'expired-token' },
      headers: { cookie: 'linkedin_access_token=expired-token' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'LinkedIn session expired, please reconnect' });
  });

  test('fails soft (200) for other linkedin failures', async () => {
    axios.get.mockRejectedValueOnce(new Error('linkedin down'));

    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'token-123' },
      headers: { cookie: 'linkedin_access_token=token-123' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      status: 'fail-soft',
      error: 'Failed to fetch LinkedIn network data',
      details: 'linkedin down',
    }));
  });
});
