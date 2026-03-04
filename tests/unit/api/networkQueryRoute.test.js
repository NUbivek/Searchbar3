const { createMockReq, createMockRes } = require('./testUtils');

const mockCreateCompletion = jest.fn();

jest.mock('together', () => {
  return {
    TogetherAI: jest.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: mockCreateCompletion,
        },
      },
    })),
  };
});

const handler = require('../../../src/pages/api/network/query').default;

describe('network query route', () => {
  beforeEach(() => {
    mockCreateCompletion.mockReset();
  });

  it('rejects non-post requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('requires a query', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { networkData: { nodes: [] }, source: 'linkedin' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Query is required' });
  });

  it('requires valid network data', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { query: 'founders', networkData: null, source: 'linkedin' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Valid network data is required' });
  });

  it('requires a supported source', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'founders',
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
  });

  it('returns a fail-soft parse response when the llm returns invalid json', async () => {
    mockCreateCompletion.mockResolvedValue({
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
        query: 'find operators',
        source: 'linkedin',
        networkData: {
          nodes: [
            { id: 'user', name: 'Me' },
            { id: 'a1', name: 'Alice', company: 'Acme', position: 'Founder' },
          ],
        },
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(mockCreateCompletion).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      matches: [],
      summary: 'Unable to process network query with LLM right now.',
      relatedIndustries: [],
      suggestedConnections: [],
      degradedSources: ['network-llm'],
      error: 'Failed to parse LLM response',
      rawResponse: 'not-json',
    });
  });

  it('returns enhanced matches on success', async () => {
    mockCreateCompletion.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              matches: [
                {
                  id: 'a1',
                  name: 'Alice',
                  relevance: 'High',
                  reasoning: 'Strong match',
                },
              ],
              summary: 'One relevant match',
              relatedIndustries: ['AI'],
              suggestedConnections: [],
            }),
          },
        },
      ],
    });

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find ai founders',
        source: 'linkedin',
        networkData: {
          nodes: [
            { id: 'user', name: 'Me' },
            {
              id: 'a1',
              name: 'Alice',
              company: 'Acme',
              position: 'Founder',
              location: 'SF',
            },
          ],
        },
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(mockCreateCompletion).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body.summary).toBe('One relevant match');
    expect(res.body.matches).toHaveLength(1);
    expect(res.body.matches[0]).toMatchObject({
      id: 'a1',
      name: 'Alice',
      relevance: 'High',
      nodeData: {
        id: 'a1',
        name: 'Alice',
        company: 'Acme',
        position: 'Founder',
        location: 'SF',
      },
    });
  });
});
