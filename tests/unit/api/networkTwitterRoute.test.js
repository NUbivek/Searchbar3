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

  test('returns the X user and following list when the API tier allows it', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: { data: { id: 'user-1', username: 'builder', profile_image_url: 'https://example.com/avatar.png', description: 'bio' } }
      })
      .mockResolvedValueOnce({
        data: { data: [{ id: 'f1', name: 'Ada Example', username: 'ada_example', description: 'Engineer' }], meta: {} }
      });

    const req = createMockReq({ method: 'GET', headers: { cookie: 'twitter_access_token=token123' } });
    const res = createMockRes();
    await handler(req, res);

    expect(axios.get).toHaveBeenCalledWith(
      'https://api.twitter.com/2/users/me',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token123' }),
        params: expect.objectContaining({ 'user.fields': 'username,profile_image_url,description' }),
        timeout: 10000
      })
    );
    expect(axios.get.mock.calls[1][0]).toBe('https://api.twitter.com/2/users/user-1/following');
    expect(res.statusCode).toBe(200);
    expect(res.body.user.username).toBe('builder');
    expect(res.body.followingAvailable).toBe(true);
    expect(res.body.following).toEqual([
      { id: 'f1', name: 'Ada Example', username: 'ada_example', description: 'Engineer', location: '' }
    ]);
    // never placeholder contacts
    expect(res.body.networksData.nodes).toHaveLength(1);
  });

  test('reports honestly when following lists need a paid X API tier', async () => {
    const forbidden = new Error('Forbidden');
    forbidden.response = { status: 403 };
    axios.get
      .mockResolvedValueOnce({ data: { data: { id: 'user-1', username: 'builder' } } })
      .mockRejectedValueOnce(forbidden);

    const req = createMockReq({ method: 'GET', headers: { cookie: 'twitter_access_token=token123' } });
    const res = createMockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.followingAvailable).toBe(false);
    expect(res.body.following).toEqual([]);
    expect(res.body.note).toMatch(/paid X API tier/);
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
      following: [],
      followingAvailable: false,
      networksData: { nodes: [], links: [] },
      degradedSources: ['twitter-network'],
      error: 'Failed to fetch Twitter network data',
      details: 'upstream broke'
    });
  });
});
