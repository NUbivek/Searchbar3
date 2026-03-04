const { createMockReq, createMockRes } = require('./testUtils');

describe('/api/network/query', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, TOGETHER_API_KEY: 'test-key' };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.clearAllMocks();
    jest.resetModules();
  });

  function loadHandler({ createImpl } = {}) {
    const createMock = createImpl || jest.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              matches: [{ id: 'node-1', relevance: 'High', reasoning: 'fit' }],
              summary: 'ok',
              relatedIndustries: ['fintech'],
              suggestedConnections: ['node-2'],
            }),
          },
        },
      ],
    });

    jest.doMock('together', () => ({
      TogetherAI: jest.fn().mockImplementation(() => ({
        chat: {
          completions: {
            create: createMock,
          },
        },
      })),
    }));

    const handler = require('../../../src/pages/api/network/query').default;
    return { handler, createMock };
  }

  it('returns 405 for unsupported methods', async () => {
    const { handler } = loadHandler();
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns 400 when query is missing', async () => {
    const { handler } = loadHandler();
    const req = createMockReq({
      method: 'POST',
      body: {
        networkData: { nodes: [{ id: 'node-1' }] },
        source: 'linkedin',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Query is required' });
  });

  it('returns 400 when network data is invalid', async () => {
    const { handler } = loadHandler();
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find candidates',
        networkData: {},
        source: 'linkedin',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Valid network data is required' });
  });

  it('returns 400 for unsupported sources', async () => {
    const { handler } = loadHandler();
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find candidates',
        networkData: { nodes: [{ id: 'node-1' }] },
        source: 'github',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Valid source is required (linkedin, twitter, or facebook)' });
  });

  it('returns enriched results on success', async () => {
    const { handler, createMock } = loadHandler();
    const networkData = {
      nodes: [
        { id: 'node-1', name: 'Alice' },
        { id: 'node-2', name: 'Bob' },
      ],
    };
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find fintech operators',
        networkData,
        source: 'linkedin',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(createMock).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      matches: [
        {
          id: 'node-1',
          relevance: 'High',
          reasoning: 'fit',
          nodeData: { id: 'node-1', name: 'Alice' },
        },
      ],
      summary: 'ok',
      relatedIndustries: ['fintech'],
      suggestedConnections: ['node-2'],
    });
  });

  it('returns 500 when the LLM response is not valid JSON', async () => {
    const createImpl = jest.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: 'not-json',
          },
        },
      ],
    });
    const { handler } = loadHandler({ createImpl });
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find candidates',
        networkData: { nodes: [{ id: 'node-1' }] },
        source: 'twitter',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'Failed to parse LLM response',
      rawResponse: 'not-json',
    });
  });

  it('returns 500 when the upstream LLM call fails', async () => {
    const createImpl = jest.fn().mockRejectedValue(new Error('upstream failed'));
    const { handler } = loadHandler({ createImpl });
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find candidates',
        networkData: { nodes: [{ id: 'node-1' }] },
        source: 'facebook',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'An error occurred while processing the network query',
      details: 'upstream failed',
    });
  });
});
