const { createMockReq, createMockRes } = require('./testUtils');

const mockCreate = jest.fn();

jest.mock('together', () => {
  return {
    TogetherAI: jest.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    })),
  };
});

const handler = require('../../../src/pages/api/network/llm-search').default;

describe('/api/network/llm-search', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('requires a query', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        networkData: { nodes: [] },
        source: 'linkedin',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Search query is required' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('requires network data', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'investors',
        source: 'linkedin',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Network data is required' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('requires a supported source', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'investors',
        networkData: { nodes: [] },
        source: 'github',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'Valid source is required (linkedin, twitter, or facebook)',
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('returns a fail-soft parse response when the model response is not valid JSON', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: 'not-json',
          },
        },
      ],
    });

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'operators',
        source: 'linkedin',
        networkData: {
          nodes: [{ id: '1', name: 'Avery', company: 'Acme', position: 'Operator' }],
        },
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      matches: [],
      summary: 'Unable to process network search with LLM right now.',
      relatedIndustries: [],
      suggestedConnections: [],
      degradedSources: ['network-llm'],
      error: 'Failed to parse LLM response',
      rawResponse: 'not-json',
    });
  });

  test('returns fail-soft provider failures with details', async () => {
    mockCreate.mockRejectedValueOnce(new Error('provider down'));

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'operators',
        source: 'twitter',
        networkData: {
          nodes: [{ id: '1', name: 'Avery', handle: '@avery' }],
        },
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      matches: [],
      summary: 'Unable to process network search with LLM right now.',
      relatedIndustries: [],
      suggestedConnections: [],
      degradedSources: ['network-llm'],
      error: 'An error occurred while processing your query',
      details: 'provider down',
    });
  });

  test('returns enhanced matches with attached node data', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              matches: [
                {
                  id: '2',
                  name: 'Jordan',
                  relevance: 'High',
                  reasoning: 'Strong fit',
                },
              ],
              summary: 'Found a strong match.',
              relatedIndustries: ['SaaS'],
              suggestedConnections: ['3'],
            }),
          },
        },
      ],
    });

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'saas operators',
        source: 'linkedin',
        networkData: {
          nodes: [
            { id: 'user', name: 'You', type: 'user' },
            { id: '2', name: 'Jordan', company: 'Acme', position: 'COO' },
            { id: '3', name: 'Lee', company: 'Beta', position: 'VP Ops' },
          ],
        },
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(mockCreate).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body.summary).toBe('Found a strong match.');
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0]).toEqual({
      id: '2',
      name: 'Jordan',
      relevance: 'High',
      reasoning: 'Strong fit',
      nodeData: { id: '2', name: 'Jordan', company: 'Acme', position: 'COO' },
    });
  });
});
