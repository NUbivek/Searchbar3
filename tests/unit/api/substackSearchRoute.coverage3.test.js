const axios = require('axios');
const { createMockReq, createMockRes } = require('./testUtils');

jest.mock('axios');
jest.mock('../../../src/utils/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const handler = require('../../../src/pages/api/search/substack').default;

describe('/api/search/substack', () => {
  const originalSerperApiKey = process.env.SERPER_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SERPER_API_KEY;
  });

  afterAll(() => {
    if (originalSerperApiKey === undefined) {
      delete process.env.SERPER_API_KEY;
    } else {
      process.env.SERPER_API_KEY = originalSerperApiKey;
    }
  });

  it('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ message: 'Method not allowed' });
  });

  it('returns 400 when query is missing', async () => {
    const req = createMockReq({ method: 'POST', body: {} });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: 'Query is required' });
  });

  it('returns a fail-soft response when SERPER_API_KEY is missing', async () => {
    const req = createMockReq({ method: 'POST', body: { query: 'ai infra' } });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      status: 'fail-soft',
      degradedSources: ['substack'],
      message: 'Search failed',
      error: 'Serper API key not configured',
      sources: [],
    });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('returns normalized substack search results on success', async () => {
    process.env.SERPER_API_KEY = 'test-key';
    axios.post.mockResolvedValue({
      data: {
        organic: [
          {
            link: 'https://example.substack.com/p/test-post',
            title: 'Test Title',
            snippet: 'Test snippet',
          },
        ],
      },
    });

    const req = createMockReq({ method: 'POST', body: { query: 'operator updates' } });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledWith(
      'https://google.serper.dev/search',
      { q: 'site:substack.com operator updates', num: 10 },
      {
        headers: {
          'X-API-KEY': 'test-key',
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.sources[0]).toMatchObject({
      type: 'SubstackResult',
      title: 'Test Title',
      url: 'https://example.substack.com/p/test-post',
      content: 'Test snippet',
      sourceId: 'substack-0',
      confidence: 1,
    });
    expect(typeof res.body.sources[0].timestamp).toBe('string');
  });

  it('returns a fail-soft response when the upstream request fails', async () => {
    process.env.SERPER_API_KEY = 'test-key';
    axios.post.mockRejectedValue(new Error('boom'));

    const req = createMockReq({ method: 'POST', body: { query: 'founder notes' } });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      status: 'fail-soft',
      degradedSources: ['substack'],
      message: 'Search failed',
      error: 'boom',
      sources: [],
    });
  });
});
