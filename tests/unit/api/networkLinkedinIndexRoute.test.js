import axios from 'axios';
import handler from '../../../src/pages/api/network/linkedin/index';
import { createMockReq, createMockRes } from './testUtils';

jest.mock('axios', () => ({
  get: jest.fn(),
}));

describe('/api/network/linkedin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 405 for non-GET requests', async () => {
    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns 401 when the LinkedIn token is missing', async () => {
    const req = createMockReq({ method: 'GET', cookies: {} });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Not authenticated with LinkedIn' });
  });

  it('returns normalized network data on success', async () => {
    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'token-123' },
      headers: { cookie: 'linkedin_access_token=token-123', host: 'app.example.com' },
    });
    const res = createMockRes();

    axios.get
      .mockResolvedValueOnce({
        data: {
          sub: 'abc123',
          given_name: 'Ada',
          family_name: 'Lovelace',
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          picture: 'pic-url',
        },
      })
      .mockResolvedValueOnce({
        data: {
          elements: [
            { miniProfile: { id: 'c1', firstName: 'Grace', lastName: 'Hopper', occupation: 'Navy' } },
            { miniProfile: { id: 'c2', firstName: 'Alan', lastName: 'Turing' } },
          ],
        },
      });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.user).toEqual({
      id: 'abc123',
      firstName: 'Ada',
      lastName: 'Lovelace',
      profilePicture: 'pic-url',
      email: 'ada@example.com',
    });
    expect(res.body.connections.map(c => c.name)).toEqual(['Grace Hopper', 'Alan Turing']);
    expect(res.body.connections[0]).toEqual(expect.objectContaining({ id: 'linkedin-c1', company: 'Navy', source: 'linkedin' }));
    expect(res.body.connectionsAvailable).toBe(true);
    expect(res.body.note).toBeNull();
    expect(res.body.networksData.nodes[0]).toEqual(expect.objectContaining({ id: 'user', name: 'Ada Lovelace' }));
    expect(res.body.networksData.links).toHaveLength(2);

    expect(axios.get).toHaveBeenCalledTimes(2);
    expect(axios.get).toHaveBeenNthCalledWith(
      1,
      'https://api.linkedin.com/v2/userinfo',
      expect.objectContaining({ headers: { Authorization: 'Bearer token-123' }, timeout: 10000 })
    );
    expect(axios.get).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('https://api.linkedin.com/v2/connections'),
      expect.objectContaining({ headers: { Authorization: 'Bearer token-123' }, timeout: 10000 })
    );
    expect(axios.get).not.toHaveBeenCalledWith(expect.stringContaining('/v2/me'), expect.anything());
  });

  it('never calls back into the app via request Host headers (SSRF guard)', async () => {
    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'token-123' },
      headers: { host: '169.254.169.254', 'x-forwarded-host': 'internal-svc:8080' },
    });
    const res = createMockRes();

    axios.get
      .mockResolvedValueOnce({ data: { sub: 'abc123', given_name: 'Ada', family_name: 'Lovelace' } })
      .mockRejectedValueOnce({ response: { status: 403 } });

    await handler(req, res);

    for (const [url] of axios.get.mock.calls) {
      expect(url.startsWith('https://api.linkedin.com/')).toBe(true);
    }
  });

  it('returns the profile-only graph and a note when connections are unavailable (403)', async () => {
    const req = createMockReq({ method: 'GET', cookies: { linkedin_access_token: 'token-123' } });
    const res = createMockRes();

    axios.get
      .mockResolvedValueOnce({ data: { sub: 'abc123', given_name: 'Ada', family_name: 'Lovelace' } })
      .mockRejectedValueOnce({ response: { status: 403 } });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.user).toEqual({
      id: 'abc123',
      firstName: 'Ada',
      lastName: 'Lovelace',
      profilePicture: null,
      email: '',
    });
    expect(res.body.connections).toEqual([]);
    expect(res.body.connectionsAvailable).toBe(false);
    expect(res.body.note).toMatch(/approved partner apps/);
    expect(res.body.networksData.nodes).toHaveLength(1);
  });

  it('returns 401 when LinkedIn responds with an auth error', async () => {
    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'expired-token' },
    });
    const res = createMockRes();

    axios.get.mockRejectedValue({
      response: { status: 401 },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      error: 'LinkedIn session expired, please reconnect',
    });
  });

  it('returns fail-soft 200 on generic upstream failure', async () => {
    const req = createMockReq({
      method: 'GET',
      cookies: { linkedin_access_token: 'token-123' },
    });
    const res = createMockRes();

    axios.get.mockRejectedValue(new Error('network down'));

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      user: null,
      connections: [],
      networksData: { nodes: [], links: [] },
      degradedSources: ['linkedin-network'],
      error: 'Failed to fetch LinkedIn network data',
      details: 'network down',
    });
  });
});
