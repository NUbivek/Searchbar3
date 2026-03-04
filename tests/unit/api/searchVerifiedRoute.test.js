jest.mock('../../../src/utils/logger.js', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

const mockSourceHandlers = {
  linkedin: jest.fn(),
  twitter: jest.fn(),
  custom: jest.fn(),
  file: jest.fn(),
  verifiedData: jest.fn(),
};

jest.mock('../../../src/utils/sourceIntegration.js', () => ({
  sourceHandlers: mockSourceHandlers,
}));

jest.mock('../../../src/utils/searchUtils.js', () => ({
  performSimpleVerifiedSearch: jest.fn(),
}));

jest.mock('../../../src/utils/verifiedDataSources.js', () => ({
  getAllVerifiedSources: jest.fn(),
}));

const { createMockReq, createMockRes } = require('./testUtils');

describe('/api/search/verified', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    Object.values(mockSourceHandlers).forEach((handler) => handler.mockReset());
  });

  async function loadHandler() {
    const mod = await import('../../../src/pages/api/search/verified.js');
    return mod.default;
  }

  it('returns 405 for non-POST requests', async () => {
    const handler = await loadHandler();
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns 400 when query is missing', async () => {
    const handler = await loadHandler();
    const req = createMockReq({
      method: 'POST',
      body: { query: '', sources: ['linkedin'] },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Query is required' });
  });

  it('returns empty results when no sources or uploaded inputs are provided', async () => {
    const handler = await loadHandler();
    const req = createMockReq({
      method: 'POST',
      body: { query: 'seed investors', sources: [] },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ results: [] });
  });

  it('flattens fulfilled source results and sorts by relevance', async () => {
    mockSourceHandlers.linkedin.mockResolvedValue([
      { title: 'LinkedIn item', relevance: 3 },
      { title: 'Lower relevance', relevance: 1 },
    ]);
    mockSourceHandlers.twitter.mockImplementation(async () => {
      throw new Error('twitter failed');
    });
    mockSourceHandlers.custom.mockResolvedValue([
      { title: 'Custom item', relevance: 5 },
    ]);
    mockSourceHandlers.file.mockResolvedValue([
      { title: 'File item', relevance: 4 },
    ]);
    mockSourceHandlers.verifiedData.mockResolvedValue([
      { title: 'Verified data item', relevance: 2 },
    ]);

    const handler = await loadHandler();
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'ai startups',
        sources: ['linkedin', 'twitter'],
        customUrls: ['https://example.com'],
        uploadedFiles: [{ name: 'deck.pdf' }],
        verifiedDataSources: ['verified-db'],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      results: [
        { title: 'Custom item', relevance: 5 },
        { title: 'File item', relevance: 4 },
        { title: 'LinkedIn item', relevance: 3 },
        { title: 'Verified data item', relevance: 2 },
        { title: 'Lower relevance', relevance: 1 },
      ],
    });
    expect(mockSourceHandlers.linkedin).toHaveBeenCalledWith('ai startups');
    expect(mockSourceHandlers.twitter).toHaveBeenCalledWith('ai startups');
    expect(mockSourceHandlers.custom).toHaveBeenCalledWith('ai startups', ['https://example.com']);
    expect(mockSourceHandlers.file).toHaveBeenCalledWith('ai startups', [{ name: 'deck.pdf' }]);
    expect(mockSourceHandlers.verifiedData).toHaveBeenCalledWith('ai startups', ['verified-db']);
  });

  it('returns 500 when the outer handler throws', async () => {
    const handler = await loadHandler();
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'ai startups',
        sources: {
          length: 1,
          map() {
            throw new Error('map exploded');
          },
        },
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'map exploded' });
  });
});
