jest.mock('axios', () => ({
  post: jest.fn(),
  get: jest.fn(),
}));

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    error: jest.fn(),
  },
}));

const axios = require('axios');
const { validateSearchResponseV1 } = require('../../../src/utils/contracts/searchResponse');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/search/linkedin').default;

describe('/api/search/linkedin', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('rejects non-POST methods', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ message: 'Method not allowed' });
  });

  test('requires a query', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {},
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: 'Query is required' });
  });

  test('returns LinkedIn API results when credentials are configured', async () => {
    process.env.LINKEDIN_CLIENT_ID = 'client-id';
    process.env.LINKEDIN_CLIENT_SECRET = 'client-secret';

    axios.post.mockResolvedValueOnce({
      data: {
        access_token: 'linkedin-token',
      },
    });
    axios.get.mockResolvedValueOnce({
      data: {
        elements: [
          {
            id: 'abc',
            text: 'Operator update',
            url: 'https://www.linkedin.com/feed/update/abc',
            created: { time: '2025-01-01T00:00:00.000Z' },
            title: 'Update title',
          },
        ],
      },
    });

    const req = createMockReq({
      method: 'POST',
      body: { query: 'operator update' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledWith(
      'https://www.linkedin.com/oauth/v2/accessToken',
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
      })
    );
    expect(axios.get).toHaveBeenCalledWith(
      'https://api.linkedin.com/v2/search',
      expect.objectContaining({
        params: expect.objectContaining({
          q: 'operator update',
        }),
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.sources).toEqual([
      expect.objectContaining({
        type: 'LinkedInResult',
        content: 'Operator update',
        title: 'Update title',
        sourceId: 'linkedin-0',
      }),
    ]);
    expect(res.body.results).toEqual(res.body.sources);
    expect(res.body.status).toBe('ok');
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });

  test('falls back to Serper when LinkedIn fails', async () => {
    process.env.LINKEDIN_CLIENT_ID = 'client-id';
    process.env.LINKEDIN_CLIENT_SECRET = 'client-secret';
    process.env.SERPER_API_KEY = 'serper-key';
    axios.post
      .mockRejectedValueOnce(new Error('linkedin failed'))
      .mockResolvedValueOnce({
        data: {
          organic: [
            {
              title: 'LinkedIn fallback result',
              link: 'https://www.linkedin.com/in/example',
              snippet: 'Fallback snippet',
            },
          ],
        },
      });

    const req = createMockReq({
      method: 'POST',
      body: { query: 'example founder' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledWith(
      'https://google.serper.dev/search',
      expect.objectContaining({
        q: 'site:linkedin.com example founder',
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-API-KEY': 'serper-key',
        }),
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.sources).toEqual([
      expect.objectContaining({
        title: 'LinkedIn fallback result',
        url: 'https://www.linkedin.com/in/example',
        sourceId: 'linkedin-0',
      }),
    ]);
    expect(res.body.results).toEqual(res.body.sources);
    expect(res.body.status).toBe('ok');
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });

  test('returns fail-soft payload when LinkedIn and fallback both fail', async () => {
    axios.post.mockRejectedValueOnce(new Error('linkedin failed'));

    const req = createMockReq({
      method: 'POST',
      body: { query: 'example founder' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        sources: [],
        status: 'fail-soft',
        degradedSources: ['linkedin'],
        message: 'Search failed',
      })
    );
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });
});
