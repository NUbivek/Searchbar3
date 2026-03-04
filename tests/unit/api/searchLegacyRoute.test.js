const { createMockReq, createMockRes } = require('./testUtils');
const { validateSearchResponseV1 } = require('../../../src/utils/contracts/searchResponse');

jest.mock('../../../src/utils/search-legacy.js', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('../../../src/utils/llm-exports.js', () => ({
  processWithLLM: jest.fn(),
}));

describe('/api/search-legacy', () => {
  let handler;
  let unifiedSearch;
  let processWithLLM;

  beforeAll(async () => {
    ({ default: handler } = await import('../../../src/pages/api/search-legacy.js'));
    ({ default: unifiedSearch } = require('../../../src/utils/search-legacy.js'));
    ({ processWithLLM } = require('../../../src/utils/llm-exports.js'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns 400 when query is missing', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { sources: ['web'] },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Query parameter is required' });
  });

  it('returns 400 when sources are empty', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { query: 'ai', sources: [] },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'At least one source must be selected' });
  });

  it('returns raw search results when model is disabled', async () => {
    unifiedSearch.mockResolvedValue([{ title: 'One result', link: 'https://example.com' }]);

    const req = createMockReq({
      method: 'POST',
      body: { query: 'ai', sources: ['web'], mode: 'verified', model: '' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(unifiedSearch).toHaveBeenCalledWith({
      query: 'ai',
      mode: 'verified',
      model: '',
      sources: ['web'],
      customUrls: [],
      uploadedFiles: [],
    });
    expect(processWithLLM).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body.query).toBe('ai');
    expect(res.body.results).toEqual([{ title: 'One result', link: 'https://example.com' }]);
    expect(typeof res.body.timestamp).toBe('string');
    expect(typeof res.body.executionTime).toBe('number');
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });

  it('wraps results in synthesizedAnswer when LLM succeeds', async () => {
    unifiedSearch.mockResolvedValue([{ title: 'One result', link: 'https://example.com' }]);
    processWithLLM.mockResolvedValue({
      content: 'Synthetic summary',
      followUpQuestions: ['what next?'],
    });

    const req = createMockReq({
      method: 'POST',
      body: { query: 'ai', sources: ['web'], model: 'together' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(unifiedSearch).toHaveBeenCalledWith({
      query: 'ai',
      mode: 'open',
      model: 'together',
      sources: ['web'],
      customUrls: [],
      uploadedFiles: [],
    });
    expect(processWithLLM).toHaveBeenCalledWith(
      'ai',
      [{ title: 'One result', link: 'https://example.com' }],
      '',
      'together'
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.results).toEqual([
      {
        synthesizedAnswer: {
          summary: 'Synthetic summary',
          sources: [
            {
              title: 'One result',
              url: 'https://example.com',
            },
          ],
          followUpQuestions: ['what next?'],
        },
      },
    ]);
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });

  it('falls back to raw results when LLM processing fails', async () => {
    unifiedSearch.mockResolvedValue([{ title: 'One result', link: 'https://example.com' }]);
    processWithLLM.mockRejectedValue(new Error('llm failure'));

    const req = createMockReq({
      method: 'POST',
      body: { query: 'ai', sources: ['web'], model: 'together' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.results).toEqual([{ title: 'One result', link: 'https://example.com' }]);
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });

  it('returns fail-soft 200 when unified search throws', async () => {
    unifiedSearch.mockRejectedValue(new Error('search failed'));

    const req = createMockReq({
      method: 'POST',
      body: { query: 'ai', sources: ['web'] },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      status: 'fail-soft',
      results: [],
      degradedSources: ['legacy-search'],
      error: 'An error occurred during search',
      details: 'search failed',
    }));
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });
});
