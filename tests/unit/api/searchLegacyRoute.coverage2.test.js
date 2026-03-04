jest.mock('../../../src/utils/search-legacy', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('../../../src/utils/llm-exports', () => ({
  processWithLLM: jest.fn(),
}));

const handler = require('../../../src/pages/api/search-legacy').default;
const unifiedSearch = require('../../../src/utils/search-legacy').default;
const { processWithLLM } = require('../../../src/utils/llm-exports');

function createMockReq(overrides = {}) {
  return {
    method: 'POST',
    body: {},
    ...overrides,
  };
}

function createMockRes() {
  return {
    statusCode: 200,
    jsonPayload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.jsonPayload = payload;
      return this;
    },
  };
}

describe('/api/search-legacy handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.jsonPayload).toEqual({ error: 'Method not allowed' });
  });

  it('returns 400 when query is missing', async () => {
    const req = createMockReq({ body: { sources: ['web'] } });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.jsonPayload).toEqual({ error: 'Query parameter is required' });
  });

  it('returns 400 when no sources are selected', async () => {
    const req = createMockReq({ body: { query: 'ai founders', sources: [] } });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.jsonPayload).toEqual({
      error: 'At least one source must be selected',
    });
  });

  it('returns empty results when unified search finds nothing', async () => {
    unifiedSearch.mockResolvedValue([]);

    const req = createMockReq({
      body: { query: 'ai founders', sources: ['web'] },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(unifiedSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'ai founders',
        mode: 'open',
        sources: ['web'],
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.results).toEqual([]);
    expect(res.jsonPayload.query).toBe('ai founders');
    expect(typeof res.jsonPayload.executionTime).toBe('number');
  });

  it('returns synthesized results when LLM processing succeeds', async () => {
    unifiedSearch.mockResolvedValue([
      {
        title: 'Founder signal',
        link: 'https://example.com/founder',
        snippet: 'A relevant source',
      },
    ]);
    processWithLLM.mockResolvedValue({
      content: 'Summarized answer',
      followUpQuestions: ['Who invested?'],
    });

    const req = createMockReq({
      body: { query: 'ai founders', sources: ['web'], model: 'mixtral-8x7b' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(processWithLLM).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.results).toHaveLength(1);
    expect(res.jsonPayload.results[0].synthesizedAnswer).toEqual({
      summary: 'Summarized answer',
      sources: [
        {
          title: 'Founder signal',
          url: 'https://example.com/founder',
        },
      ],
      followUpQuestions: ['Who invested?'],
    });
  });

  it('falls back to raw search results when LLM processing fails', async () => {
    const rawResults = [
      {
        title: 'Founder signal',
        link: 'https://example.com/founder',
      },
    ];
    unifiedSearch.mockResolvedValue(rawResults);
    processWithLLM.mockRejectedValue(new Error('LLM unavailable'));

    const req = createMockReq({
      body: { query: 'ai founders', sources: ['web'], model: 'mixtral-8x7b' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonPayload.results).toEqual(rawResults);
  });

  it('returns 500 when unified search throws', async () => {
    unifiedSearch.mockRejectedValue(new Error('Search failed'));

    const req = createMockReq({
      body: { query: 'ai founders', sources: ['web'] },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.jsonPayload).toEqual({
      error: 'An error occurred during search',
      details: 'Search failed',
    });
  });
});
