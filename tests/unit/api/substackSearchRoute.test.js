jest.mock('axios', () => ({
  post: jest.fn(),
}));

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    error: jest.fn(),
  },
}));

const axios = require('axios');
const { validateSearchResponseV1 } = require('../../../src/utils/contracts/searchResponse');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/search/substack').default;

describe('/api/search/substack', () => {
  const originalSerperKey = process.env.SERPER_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SERPER_API_KEY;
  });

  afterAll(() => {
    if (originalSerperKey) {
      process.env.SERPER_API_KEY = originalSerperKey;
    } else {
      delete process.env.SERPER_API_KEY;
    }
  });

  test('rejects non-POST requests', async () => {
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

  test('returns fail-soft when Serper is not configured', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { query: 'startup operators' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        status: 'fail-soft',
        degradedSources: ['substack'],
        message: 'Search failed',
        error: 'Serper API key not configured',
      })
    );
    expect(res.body.sources).toEqual([]);
  });

  test('returns normalized substack sources on success', async () => {
    process.env.SERPER_API_KEY = 'test-key';
    axios.post.mockResolvedValue({
      data: {
        organic: [
          {
            title: 'Great Substack post',
            link: 'https://example.substack.com/p/great-post',
            snippet: 'Useful summary',
          },
          {
            title: 'Ignored without link',
          },
        ],
      },
    });

    const req = createMockReq({
      method: 'POST',
      body: { query: 'startup operators' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.post).toHaveBeenCalledWith(
      'https://google.serper.dev/search',
      expect.objectContaining({
        q: 'site:substack.com startup operators',
        num: 10,
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-API-KEY': 'test-key',
        }),
        timeout: 10000,
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.sources).toHaveLength(1);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.status).toBe('ok');
    expect(res.body.sources[0]).toEqual(
      expect.objectContaining({
        type: 'SubstackResult',
        title: 'Great Substack post',
        url: 'https://example.substack.com/p/great-post',
        content: 'Useful summary',
        sourceId: 'substack-0',
      })
    );
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });
});
