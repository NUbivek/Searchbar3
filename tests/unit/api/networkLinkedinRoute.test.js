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
        data: {
          id: 'user-1',
          localizedFirstName: 'Avery',
          localizedLastName: 'Stone',
          profilePicture: { displayImage: 'avatar-url' },
        },
      })
      .mockResolvedValueOnce({
        data: {
          elements: [
            {
              'handle~': {
                emailAddress: 'avery@example.com',
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          nodes: [
            { id: 'user', name: 'Avery Stone' },
            { id: '2', name: 'Jordan Lee', company: 'Acme' },
          ],
          links: [],
        },
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
      'https://api.linkedin.com/v2/me',
      {
        headers: {
          Authorization: 'Bearer token-123',
        },
      }
    );
    expect(axios.get).toHaveBeenNthCalledWith(
      3,
      'https://example.com/api/network/linkedin/connections',
      {
        headers: {
          Cookie: 'linkedin_access_token=token-123',
        },
      }
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      user: {
        id: 'user-1',
        firstName: 'Avery',
        lastName: 'Stone',
        profilePicture: 'avatar-url',
        email: 'avery@example.com',
      },
      connections: [{ id: '2', name: 'Jordan Lee', company: 'Acme' }],
      networksData: {
        nodes: [
          { id: 'user', name: 'Avery Stone' },
          { id: '2', name: 'Jordan Lee', company: 'Acme' },
        ],
        links: [],
      },
    });
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

  test('returns 500 for other linkedin failures', async () => {
    axios.get.mockRejectedValueOnce(new Error('linkedin down'));

    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'token-123' },
      headers: { cookie: 'linkedin_access_token=token-123' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'Failed to fetch LinkedIn network data',
      details: 'linkedin down',
    });
  });
});
