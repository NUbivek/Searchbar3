jest.mock('../../../src/utils/search-legacy', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('../../../src/utils/llmProcessing', () => ({
  processWithLLM: jest.fn(),
}));

jest.mock('../../../src/utils/fallbackSynthesizer', () => ({
  synthesizeFallbackContent: jest.fn(() => 'fallback summary'),
}));

jest.mock('../../../src/utils/isLLMResult', () => ({
  isLLMResult: jest.fn(() => false),
}));

jest.mock('../../../src/utils/deepWebSearch', () => ({
  performDeepWebSearch: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const unifiedSearch = require('../../../src/utils/search-legacy').default;
const { validateSearchResponseV1 } = require('../../../src/utils/contracts/searchResponse');
const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/search/index').default;

describe('/api/search', () => {
  const originalSerperKey = process.env.SERPER_API_KEY;
  const originalBaseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SERPER_API_KEY;
    process.env.NEXT_PUBLIC_BASE_URL = 'http://localhost:3001';
    global.fetch = jest.fn().mockResolvedValue({
      json: jest.fn().mockResolvedValue({ results: [] }),
    });
    unifiedSearch.mockResolvedValue({
      results: [],
      providerStatuses: [],
    });
  });

  afterAll(() => {
    if (originalSerperKey) {
      process.env.SERPER_API_KEY = originalSerperKey;
    } else {
      delete process.env.SERPER_API_KEY;
    }

    if (originalBaseUrl) {
      process.env.NEXT_PUBLIC_BASE_URL = originalBaseUrl;
    } else {
      delete process.env.NEXT_PUBLIC_BASE_URL;
    }

    global.fetch = originalFetch;
  });

  test('rejects non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body.error).toBe('Method not allowed');
  });

  test('requires a query', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {},
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Query is required');
  });

  test('returns fail-soft response when no sources return results', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'acme automation',
        selectedSources: ['web'],
        customUrls: [],
        uploadedFiles: [],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(unifiedSearch).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('fail-soft');
    expect(res.body.results).toEqual([]);
    expect(res.body.degradedSources).toContain('web');
    expect(res.body.failSoftContent).toBeTruthy();
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });
});
