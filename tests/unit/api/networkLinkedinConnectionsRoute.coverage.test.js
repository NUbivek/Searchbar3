const axios = require('axios');
const { createMockReq, createMockRes } = require('./testUtils');

jest.mock('axios', () => ({
  get: jest.fn(),
}));

const handler = require('../../../src/pages/api/network/linkedin/connections').default;

describe('/api/network/linkedin/connections', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects non-GET requests', async () => {
    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  test('requires a linkedin access token', async () => {
    const req = createMockReq({ method: 'GET', cookies: {} });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Not authenticated with LinkedIn' });
  });

  test('returns simulated connections when linkedin has no connections', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: {
          localizedFirstName: 'Avery',
          localizedLastName: 'Stone',
          profilePicture: { displayImage: 'avatar-url' },
        },
      })
      .mockResolvedValueOnce({
        data: { elements: [] },
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
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-123' }),
      })
    );
    expect(axios.get).toHaveBeenNthCalledWith(
      2,
      'https://api.linkedin.com/v2/connections?q=viewer&start=0&count=50',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-123' }),
      })
    );

    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body.nodes).toHaveLength(6);
    expect(body.links).toHaveLength(5);
    expect(body.nodes[0]).toEqual(
      expect.objectContaining({
        id: 'user',
        name: 'Avery Stone',
        type: 'user',
      })
    );
    expect(body.nodes.filter((node) => node.simulated)).toHaveLength(5);
  });

  test('returns real linkedin connection nodes when available', async () => {
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
                id: '2',
                firstName: 'Jordan',
                lastName: 'Lee',
                occupation: 'Founder',
                publicIdentifier: 'jordan-lee',
                picture: {
                  'com.linkedin.common.VectorImage': {
                    rootUrl: 'https://cdn.example.com/',
                  },
                },
              },
            },
          ],
        },
      });

    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'token-abc' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body.nodes).toHaveLength(2);
    expect(body.links).toHaveLength(1);
    expect(body.nodes[1]).toEqual(
      expect.objectContaining({
        id: 'linkedin-2',
        name: 'Jordan Lee',
        company: 'Founder',
        type: 'linkedin',
        source: 'linkedin',
      })
    );
    expect(body.nodes.filter((node) => node.simulated)).toHaveLength(0);
  });

  test('returns 401 when linkedin token is expired', async () => {
    axios.get.mockRejectedValueOnce({
      response: { status: 401 },
      message: 'expired token',
    });

    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'expired-token' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'LinkedIn session expired, please reconnect' });
  });

  test('returns 500 on other linkedin failures', async () => {
    axios.get.mockRejectedValueOnce(new Error('linkedin down'));

    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'token-xyz' },
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
