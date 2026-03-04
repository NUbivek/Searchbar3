const { createMockReq, createMockRes } = require('./testUtils');

jest.mock('axios', () => ({
  get: jest.fn(),
}));

const axios = require('axios');
const handler = require('../../../src/pages/api/network/twitter/index').default;

describe('/api/network/twitter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 401 when no twitter token is present', async () => {
    const req = createMockReq({ method: 'GET', headers: {} });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      error: 'Authentication required',
      details: 'No Twitter access token found'
    });
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('returns visualization-ready data on success', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        data: {
          id: 'user-1',
          username: 'builder',
          profile_image_url: 'https://example.com/avatar.png',
          description: 'bio'
        }
      }
    });

    const req = createMockReq({
      method: 'GET',
      headers: { cookie: 'twitter_access_token=token123' }
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.get).toHaveBeenCalledWith(
      'https://api.twitter.com/2/users/me',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token123'
        }),
        params: expect.objectContaining({
          'user.fields': 'username,profile_image_url,description'
        })
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.user).toEqual({
      id: 'user-1',
      username: 'builder',
      profile_image_url: 'https://example.com/avatar.png',
      description: 'bio'
    });
    expect(res.body.networksData.nodes).toHaveLength(6);
    expect(res.body.networksData.links).toHaveLength(5);
    expect(res.body.networksData.nodes[0]).toEqual(
      expect.objectContaining({
        id: 'user',
        name: 'builder',
        type: 'user'
      })
    );
  });

  test('returns 401 when twitter reports an expired token', async () => {
    const error = new Error('Unauthorized');
    error.response = { status: 401 };
    axios.get.mockRejectedValueOnce(error);

    const req = createMockReq({
      method: 'GET',
      headers: { cookie: 'twitter_access_token=expired-token' }
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      error: 'Authentication error',
      details: 'Twitter token expired or invalid',
      tokenExpired: true
    });
  });

  test('returns 429 when twitter rate limits the request', async () => {
    const error = new Error('Rate limited');
    error.response = {
      status: 429,
      headers: { 'retry-after': '120' }
    };
    axios.get.mockRejectedValueOnce(error);

    const req = createMockReq({
      method: 'GET',
      headers: { cookie: 'twitter_access_token=token123' }
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({
      error: 'Twitter API rate limit exceeded',
      details: 'Too many requests. Please try again later.',
      retryAfter: '120'
    });
  });

  test('returns fail-soft 200 for unexpected twitter failures', async () => {
    const error = new Error('boom');
    error.response = { data: { error: 'upstream broke' } };
    axios.get.mockRejectedValueOnce(error);

    const req = createMockReq({
      method: 'GET',
      headers: { cookie: 'twitter_access_token=token123' }
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      user: null,
      networksData: { nodes: [], links: [] },
      degradedSources: ['twitter-network'],
      error: 'Failed to fetch Twitter network data',
      details: 'upstream broke',
      errorData: JSON.stringify({ error: 'upstream broke' })
    });
  });
});
