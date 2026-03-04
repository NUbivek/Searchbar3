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
const { validateSearchResponseV1 } = require('../../../src/utils/contracts/searchResponse');
const handler = require('../../../src/pages/api/search/linkedin').default;
const { createMockReq, createMockRes } = require('./testUtils');

describe('/api/search/linkedin', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns 405 for unsupported methods', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ message: 'Method not allowed' });
  });

  it('returns 400 when query is missing', async () => {
    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: 'Query is required' });
  });

  it('returns LinkedIn API results when credentials are configured', async () => {
    process.env.LINKEDIN_CLIENT_ID = 'linkedin-id';
    process.env.LINKEDIN_CLIENT_SECRET = 'linkedin-secret';

    axios.post.mockResolvedValueOnce({
      data: { access_token: 'linkedin-token' },
    });
    axios.get.mockResolvedValueOnce({
      data: {
        elements: [
          {
            text: 'Founder post body',
            description: 'Fallback description',
            url: 'https://www.linkedin.com/feed/update/urn:li:share:123',
            created: { time: '2026-03-03T12:00:00.000Z' },
            title: 'LinkedIn title',
            id: 'urn:li:share:123',
          },
        ],
      },
    });

    const req = createMockReq({
      method: 'POST',
      body: { query: 'seed startup' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledWith(
      'https://www.linkedin.com/oauth/v2/accessToken',
      expect.stringContaining('grant_type=client_credentials'),
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10000,
      })
    );
    expect(axios.get).toHaveBeenCalledWith(
      'https://api.linkedin.com/v2/search',
      expect.objectContaining({
        params: {
          q: 'seed startup',
          count: 10,
          start: 0,
        },
        timeout: 10000,
        headers: expect.objectContaining({
          Authorization: 'Bearer linkedin-token',
        }),
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.status).toBe('ok');
    expect(res.body.sources[0]).toEqual(
      expect.objectContaining({
        type: 'LinkedInResult',
        content: 'Founder post body',
        title: 'LinkedIn title',
        url: 'https://www.linkedin.com/feed/update/urn:li:share:123',
        sourceId: 'linkedin-0',
      })
    );
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });

  it('falls back to Serper when the LinkedIn API fails', async () => {
    process.env.LINKEDIN_CLIENT_ID = 'linkedin-id';
    process.env.LINKEDIN_CLIENT_SECRET = 'linkedin-secret';
    process.env.SERPER_API_KEY = 'serper-key';

    axios.post
      .mockRejectedValueOnce(new Error('linkedin down'))
      .mockResolvedValueOnce({
        data: {
          organic: [
            {
              title: 'LinkedIn fallback result',
              link: 'https://www.linkedin.com/posts/test',
              snippet: 'Fallback snippet',
            },
          ],
        },
      });

    const req = createMockReq({
      method: 'POST',
      body: { query: 'operator network' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenNthCalledWith(
      2,
      'https://google.serper.dev/search',
      {
        q: 'site:linkedin.com operator network',
        num: 10,
      },
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-API-KEY': 'serper-key',
        }),
        timeout: 10000,
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.sources).toEqual([
      expect.objectContaining({
        type: 'LinkedInResult',
        title: 'LinkedIn fallback result',
        content: 'Fallback snippet',
        url: 'https://www.linkedin.com/posts/test',
      }),
    ]);
    expect(res.body.results).toEqual(res.body.sources);
    expect(res.body.status).toBe('ok');
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });

  it('returns a fail-soft payload when LinkedIn and Serper both fail', async () => {
    process.env.LINKEDIN_CLIENT_ID = 'linkedin-id';
    process.env.LINKEDIN_CLIENT_SECRET = 'linkedin-secret';
    process.env.SERPER_API_KEY = 'serper-key';

    axios.post
      .mockRejectedValueOnce(new Error('linkedin down'))
      .mockRejectedValueOnce(new Error('serper down'));

    const req = createMockReq({
      method: 'POST',
      body: { query: 'operators' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(logger.error).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      sources: [],
      status: 'fail-soft',
      degradedSources: ['linkedin'],
      message: 'Search failed',
      error: 'serper down',
    }));
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });
});
