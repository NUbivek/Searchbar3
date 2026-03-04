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
      headers: { cookie: 'linkedin_access_token=token-123' },
    });
    const res = createMockRes();

    axios.get
      .mockResolvedValueOnce({
        data: {
          id: 'abc123',
          localizedFirstName: 'Ada',
          localizedLastName: 'Lovelace',
          profilePicture: { displayImage: 'pic-url' },
        },
      })
      .mockResolvedValueOnce({
        data: {
          elements: [
            {
              'handle~': {
                emailAddress: 'ada@example.com',
              },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          nodes: [
            { id: 'user', name: 'Current User' },
            { id: 'c1', name: 'First Connection' },
            { id: 'c2', name: 'Second Connection' },
          ],
          edges: [{ source: 'user', target: 'c1' }],
        },
      });

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      user: {
        id: 'abc123',
        firstName: 'Ada',
        lastName: 'Lovelace',
        profilePicture: 'pic-url',
        email: 'ada@example.com',
      },
      connections: [
        { id: 'c1', name: 'First Connection' },
        { id: 'c2', name: 'Second Connection' },
      ],
      networksData: {
        nodes: [
          { id: 'user', name: 'Current User' },
          { id: 'c1', name: 'First Connection' },
          { id: 'c2', name: 'Second Connection' },
        ],
        edges: [{ source: 'user', target: 'c1' }],
      },
    });

    expect(axios.get).toHaveBeenNthCalledWith(
      1,
      'https://api.linkedin.com/v2/me',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-123',
        }),
        timeout: 10000,
      })
    );
    expect(axios.get).toHaveBeenNthCalledWith(
      2,
      'https://api.linkedin.com/v2/emailAddress?q=members&projection=(elements*(handle~))',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-123',
        }),
        timeout: 10000,
      })
    );
    expect(axios.get).toHaveBeenNthCalledWith(
      3,
      'http://localhost:3002/api/network/linkedin/connections',
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: 'linkedin_access_token=token-123',
        }),
        timeout: 10000,
      })
    );
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
