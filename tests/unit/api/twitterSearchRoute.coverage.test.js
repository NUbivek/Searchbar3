jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const axios = require('axios');
const handler = require('../../../src/pages/api/search/twitter').default;

function createRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };

  return res;
}

describe('/api/search/twitter coverage', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.TWITTER_API_KEY;
    delete process.env.SERPER_API_KEY;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns 405 for non-POST requests', async () => {
    const req = { method: 'GET', body: {} };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ message: 'Method not allowed' });
  });

  it('returns 400 when query is missing', async () => {
    const req = { method: 'POST', body: {} };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: 'Query is required' });
  });

  it('returns mapped twitter results when twitter api succeeds', async () => {
    process.env.TWITTER_API_KEY = 'twitter-key';
    axios.get.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: '123',
            text: 'Founder update',
            created_at: '2025-01-01T00:00:00.000Z',
            author_id: 'author-1',
            public_metrics: {
              like_count: 5,
              retweet_count: 2,
            },
          },
        ],
        includes: {
          users: [
            {
              id: 'author-1',
              name: 'Alice Founder',
              username: 'alice',
              profile_image_url: 'https://img.example/avatar.png',
            },
          ],
        },
      },
    });

    const req = { method: 'POST', body: { query: 'founder' } };
    const res = createRes();

    await handler(req, res);

    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.sources[0]).toMatchObject({
      type: 'TwitterResult',
      title: 'Tweet by author-1',
      content: 'Founder update',
      url: 'https://twitter.com/i/web/status/123',
      sourceId: 'twitter-0',
      metadata: {
        likes: 5,
        retweets: 2,
      },
    });
  });

  it('falls back to serper when twitter api fails', async () => {
    process.env.TWITTER_API_KEY = 'twitter-key';
    process.env.SERPER_API_KEY = 'serper-key';

    axios.get.mockRejectedValueOnce(new Error('twitter down'));
    axios.post.mockResolvedValueOnce({
      data: {
        organic: [
          {
            title: '@builder on X',
            link: 'https://twitter.com/builder/status/999',
            snippet: 'Shipping product updates',
          },
        ],
      },
    });

    const req = { method: 'POST', body: { query: 'builder' } };
    const res = createRes();

    await handler(req, res);

    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.sources[0]).toMatchObject({
      type: 'TwitterResult',
      title: '@builder on X',
      content: 'Shipping product updates',
      url: 'https://twitter.com/builder/status/999',
      sourceId: 'twitter-0',
    });
  });

  it('returns fail-soft response when required credentials are unavailable', async () => {
    const req = { method: 'POST', body: { query: 'operator' } };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      sources: [],
      status: 'fail-soft',
      degradedSources: ['twitter'],
      message: 'Search failed',
    });
  });
});
