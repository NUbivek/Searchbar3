const { createMockReq, createMockRes } = require('./testUtils');

jest.mock('axios', () => ({
  get: jest.fn(),
}));

const axios = require('axios');
const handler = require('../../../src/pages/api/network/linkedin/connections').default;

describe('/api/network/linkedin/connections', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects non-GET requests', async () => {
    const req = createMockReq({ method: 'POST', cookies: {} });
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

  test('returns processed graph data for real linkedin connections', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: {
          localizedFirstName: 'Avery',
          localizedLastName: 'Stone',
          profilePicture: { displayImage: 'avatar-url' },
        },
      })
      .mockResolvedValueOnce({
        data: {
          elements: [
            {
              miniProfile: {
                id: 'abc123',
                firstName: 'Jordan',
                lastName: 'Lee',
                occupation: 'Acme',
                title: 'Founder',
                locationName: 'Oakland, CA',
                picture: { displayImage: 'conn-avatar' },
              },
            },
          ],
        },
      });

    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'token-123' },
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
      2,
      'https://api.linkedin.com/v2/connections?q=viewer&start=0&count=50',
      {
        headers: {
          Authorization: 'Bearer token-123',
        },
      }
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.nodes).toEqual([
      {
        id: 'user',
        name: 'Avery Stone',
        val: 20,
        color: '#0077B5',
        image: 'avatar-url',
        degree: 0,
        type: 'user',
      },
      {
        id: 'linkedin-abc123',
        name: 'Jordan Lee',
        company: 'Acme',
        position: 'Founder',
        location: 'Oakland, CA',
        val: 10,
        color: '#0077B5',
        image: 'conn-avatar',
        degree: 1,
        source: 'linkedin',
        type: 'linkedin',
      },
    ]);
    expect(res.body.links).toEqual([
      {
        source: 'user',
        target: 'linkedin-abc123',
        value: 1,
      },
    ]);
  });

  test('falls back to simulated connections when linkedin returns none', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: {
          localizedFirstName: 'Avery',
          localizedLastName: 'Stone',
        },
      })
      .mockResolvedValueOnce({
        data: {
          elements: [],
        },
      });

    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'token-123' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.nodes).toHaveLength(6);
    expect(res.body.links).toHaveLength(5);
    expect(res.body.nodes[0]).toEqual(
      expect.objectContaining({
        id: 'user',
        name: 'Avery Stone',
        type: 'user',
      })
    );
    expect(res.body.nodes[1]).toEqual(
      expect.objectContaining({
        simulated: true,
        source: 'linkedin',
        type: 'linkedin',
      })
    );
  });

  test('returns 401 when linkedin token is expired', async () => {
    const error = new Error('Unauthorized');
    error.response = { status: 401, data: { message: 'expired' } };
    axios.get.mockRejectedValueOnce(error);

    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'expired-token' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'LinkedIn session expired, please reconnect' });
  });

  test('returns 500 for unexpected linkedin failures', async () => {
    axios.get.mockRejectedValueOnce(new Error('linkedin down'));

    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'token-123' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'Failed to fetch LinkedIn connections',
      details: 'linkedin down',
    });
  });
});
