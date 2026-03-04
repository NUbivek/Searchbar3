jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    error: jest.fn(),
  },
}));

const axios = require('axios');
const { logger } = require('../../../src/utils/logger');
const handler = require('../../../src/pages/api/search/reddit').default;
const { createMockReq, createMockRes } = require('./testUtils');

describe('/api/search/reddit', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns 405 for unsupported methods', async () => {
    const req = createMockReq({ method: 'PUT' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ message: 'Method not allowed' });
  });

  it('returns 400 when query is missing', async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: 'Query is required' });
  });

  it('returns Reddit API results when credentials are configured', async () => {
    process.env.REDDIT_CLIENT_ID = 'client-id';
    process.env.REDDIT_CLIENT_SECRET = 'client-secret';

    axios.post.mockResolvedValueOnce({
      data: { access_token: 'reddit-token' },
    });
    axios.get.mockResolvedValueOnce({
      data: {
        data: {
          children: [
            {
              data: {
                selftext: 'Body text',
                title: 'Reddit title',
                permalink: '/r/startups/comments/abc123/test_post',
                created_utc: 1700000000,
                score: 42,
                subreddit: 'startups',
                author: 'founder1',
              },
            },
          ],
        },
      },
    });

    const req = createMockReq({
      method: 'GET',
      query: { query: 'startup funding' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledWith(
      'https://www.reddit.com/api/v1/access_token',
      'grant_type=client_credentials',
      expect.objectContaining({
        auth: {
          username: 'client-id',
          password: 'client-secret',
        },
      })
    );
    expect(axios.get).toHaveBeenCalledWith(
      'https://oauth.reddit.com/search',
      expect.objectContaining({
        params: expect.objectContaining({
          q: 'startup funding',
          sort: 'relevance',
          limit: 10,
          t: 'month',
        }),
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.sources[0]).toEqual(
      expect.objectContaining({
        type: 'RedditResult',
        content: 'Body text',
        title: 'Reddit title',
        url: 'https://reddit.com/r/startups/comments/abc123/test_post',
        sourceId: 'reddit-0',
        metadata: expect.objectContaining({
          score: 42,
          subreddit: 'startups',
          author: 'founder1',
        }),
      })
    );
  });

  it('falls back to Serper when the Reddit API fails', async () => {
    process.env.REDDIT_CLIENT_ID = 'client-id';
    process.env.REDDIT_CLIENT_SECRET = 'client-secret';
    process.env.SERPER_API_KEY = 'serper-key';

    axios.post
      .mockRejectedValueOnce(new Error('reddit down'))
      .mockResolvedValueOnce({
        data: {
          organic: [
            {
              title: 'Reddit result',
              link: 'https://reddit.com/r/test/comments/xyz',
              snippet: 'Fallback snippet',
            },
          ],
        },
      });

    const req = createMockReq({
      method: 'POST',
      body: { query: 'ai startup' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenNthCalledWith(
      2,
      'https://google.serper.dev/search',
      {
        q: 'site:reddit.com ai startup',
        num: 10,
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-API-KEY': 'serper-key',
        }),
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.sources).toEqual([
      expect.objectContaining({
        type: 'RedditResult',
        title: 'Reddit result',
        content: 'Fallback snippet',
        url: 'https://reddit.com/r/test/comments/xyz',
      }),
    ]);
  });

  it('returns a fail-soft payload when Reddit and Serper both fail', async () => {
    process.env.REDDIT_CLIENT_ID = 'client-id';
    process.env.REDDIT_CLIENT_SECRET = 'client-secret';
    process.env.SERPER_API_KEY = 'serper-key';

    axios.post
      .mockRejectedValueOnce(new Error('reddit down'))
      .mockRejectedValueOnce(new Error('serper down'));

    const req = createMockReq({
      method: 'GET',
      query: { query: 'operators' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(logger.error).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      sources: [],
      status: 'fail-soft',
      degradedSources: ['reddit'],
      message: 'Search failed',
      error: 'serper down',
    });
  });
});
