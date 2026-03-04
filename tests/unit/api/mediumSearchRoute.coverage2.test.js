const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('axios');
jest.mock('../../../src/utils/logger', () => ({
  __esModule: true,
  logger: mockLogger,
  default: mockLogger,
}));

const axios = require('axios');
const { validateSearchResponseV1 } = require('../../../src/utils/contracts/searchResponse');
const handler = require('../../../src/pages/api/search/medium').default;
const { createMockReq, createMockRes } = require('./testUtils');

describe('/api/search/medium', () => {
  const originalEnv = process.env.SERPER_API_KEY;

  afterEach(() => {
    jest.clearAllMocks();

    if (originalEnv === undefined) {
      delete process.env.SERPER_API_KEY;
    } else {
      process.env.SERPER_API_KEY = originalEnv;
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

  it('returns fail-soft 200 when SERPER_API_KEY is missing', async () => {
    delete process.env.SERPER_API_KEY;

    const req = createMockReq({ method: 'POST', body: { query: 'founders' } });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('fail-soft');
    expect(res.body.degradedSources).toEqual(['medium']);
    expect(res.body.sources).toEqual([]);
    expect(res.body.message).toBe('Search failed');
    expect(res.body.error).toBe('Serper API key not configured');
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('returns mapped medium sources on success', async () => {
    process.env.SERPER_API_KEY = 'test-serper-key';
    axios.post.mockResolvedValue({
      data: {
        organic: [
          {
            title: 'Medium result',
            link: 'https://medium.com/@example/post',
            snippet: 'A useful snippet',
          },
          {
            title: 'Ignored result',
            snippet: 'Missing link should be filtered out',
          },
        ],
      },
    });

    const req = createMockReq({ method: 'POST', body: { query: 'ai agents' } });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledWith(
      'https://google.serper.dev/search',
      { q: 'site:medium.com ai agents', num: 10 },
      {
        headers: {
          'X-API-KEY': 'test-serper-key',
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.status).toBe('ok');
    expect(res.body.sources[0]).toMatchObject({
      type: 'MediumResult',
      title: 'Medium result',
      url: 'https://medium.com/@example/post',
      content: 'A useful snippet',
      confidence: 1,
      sourceId: 'medium-0',
    });
    expect(typeof res.body.sources[0].timestamp).toBe('string');
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });

  it('returns fail-soft 200 when upstream search fails', async () => {
    process.env.SERPER_API_KEY = 'test-serper-key';
    axios.post.mockRejectedValue(new Error('Serper unavailable'));

    const req = createMockReq({ method: 'POST', body: { query: 'seed rounds' } });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      sources: [],
      status: 'fail-soft',
      degradedSources: ['medium'],
      message: 'Search failed',
      error: 'Serper unavailable',
    }));
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });
});
