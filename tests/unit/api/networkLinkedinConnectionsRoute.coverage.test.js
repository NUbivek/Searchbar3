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

  test('returns only the user node with a note when linkedin has no connections', async () => {
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
      'https://api.linkedin.com/v2/userinfo',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-123' }),
        timeout: 10000,
      })
    );
    expect(axios.get).toHaveBeenNthCalledWith(
      2,
      'https://api.linkedin.com/v2/connections?q=viewer&start=0&count=50',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-123' }),
        timeout: 10000,
      })
    );

    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body.nodes).toHaveLength(1);
    expect(body.links).toHaveLength(0);
    expect(body.nodes[0]).toEqual(
      expect.objectContaining({
        id: 'user',
        name: 'Avery Stone',
        image: 'avatar-url',
        type: 'user',
      })
    );
    expect(body.connectionsAvailable).toBe(false);
    expect(typeof body.note).toBe('string');
    expect(body.note.length).toBeGreaterThan(0);
    expect(body.nodes.filter((node) => node.simulated)).toHaveLength(0);
  });

  test('returns only the user node when the connections api is not available to the app', async () => {
    const forbidden = new Error('Forbidden');
    forbidden.response = { status: 403 };
    axios.get
      .mockResolvedValueOnce({
        data: { sub: 'avery-sub', given_name: 'Avery', family_name: 'Stone', name: 'Avery Stone' },
      })
      .mockRejectedValueOnce(forbidden);

    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'token-123' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.nodes).toHaveLength(1);
    expect(res.body.nodes[0]).toEqual(expect.objectContaining({ id: 'user', name: 'Avery Stone' }));
    expect(res.body.links).toEqual([]);
    expect(res.body.connectionsAvailable).toBe(false);
    expect(typeof res.body.note).toBe('string');
    expect(res.body.status).toBeUndefined();
  });

  test('returns real linkedin connection nodes when available', async () => {
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
    expect(body.connectionsAvailable).toBe(true);
    expect(body.note).toBeUndefined();
  });

  test('returns 401 when the linkedin profile request reports an expired token', async () => {
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
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('returns fail-soft payload on other linkedin profile failures', async () => {
    axios.get.mockRejectedValueOnce(new Error('linkedin down'));

    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'token-xyz' },
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
