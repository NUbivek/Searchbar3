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
          sub: 'avery-sub',
          given_name: 'Avery',
          family_name: 'Stone',
          name: 'Avery Stone',
          picture: 'avatar-url',
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
      'https://api.linkedin.com/v2/userinfo',
      {
        headers: {
          Authorization: 'Bearer token-123',
        },
        timeout: 10000,
      }
    );
    expect(axios.get).toHaveBeenNthCalledWith(
      2,
      'https://api.linkedin.com/v2/connections?q=viewer&start=0&count=50',
      {
        headers: {
          Authorization: 'Bearer token-123',
        },
        timeout: 10000,
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
    expect(res.body.connectionsAvailable).toBe(true);
    expect(res.body.note).toBeUndefined();
  });

  test('returns only the user node and a note when linkedin returns no connections', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: {
          sub: 'avery-sub',
          given_name: 'Avery',
          family_name: 'Stone',
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
    expect(res.body).toEqual({
      nodes: [
        {
          id: 'user',
          name: 'Avery Stone',
          val: 20,
          color: '#0077B5',
          image: null,
          degree: 0,
          type: 'user',
        },
      ],
      links: [],
      connectionsAvailable: false,
      note: expect.any(String),
    });
    expect(res.body.nodes.some((node) => node.simulated)).toBe(false);
  });

  test('returns 401 when the linkedin profile request reports an expired token', async () => {
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

  test('returns fail-soft payload for unexpected linkedin profile failures', async () => {
    axios.get.mockRejectedValueOnce(new Error('linkedin down'));

    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'token-123' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      nodes: [],
      links: [],
      degradedSources: ['linkedin-network'],
      error: 'Failed to fetch LinkedIn profile',
      details: 'linkedin down',
    });
  });
});
