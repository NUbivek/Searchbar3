import handler from '../../../src/pages/api/network/llm-search';
import { createMockReq, createMockRes } from './testUtils';

jest.mock('together', () => {
  const create = jest.fn();
  return {
    TogetherAI: jest.fn().mockImplementation(() => ({
      chat: {
        completions: { create },
      },
    })),
    __createMock: create,
  };
});

const { __createMock } = jest.requireMock('together');

function createRequestResponse(reqOverrides = {}) {
  return {
    req: createMockReq(reqOverrides),
    res: createMockRes(),
  };
}

function sampleNetworkData() {
  return {
    nodes: [
      { id: 'user', label: 'Me' },
      { id: '1', label: 'Alice', title: 'Founder', company: 'Alpha' },
      { id: '2', label: 'Bob', title: 'Investor', company: 'Beta' },
      { id: 'skip', label: 'Ignored', type: 'edge-node' },
    ],
    links: [],
  };
}

describe('/api/network/llm-search', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 405 for non-POST requests', async () => {
    const { req, res } = createRequestResponse({ method: 'GET' });

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns 400 when query is missing', async () => {
    const { req, res } = createRequestResponse({
      method: 'POST',
      body: { networkData: sampleNetworkData(), source: 'linkedin' },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Search query is required' });
  });

  it('returns 400 when network data is missing', async () => {
    const { req, res } = createRequestResponse({
      method: 'POST',
      body: { query: 'find founders', source: 'linkedin' },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Network data is required' });
  });

  it('returns 400 for invalid source', async () => {
    const { req, res } = createRequestResponse({
      method: 'POST',
      body: { query: 'find founders', networkData: sampleNetworkData(), source: 'github' },
    });

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'Valid source is required (linkedin, twitter, or facebook)',
    });
  });

  it('returns fail-soft 200 when the LLM response is not valid JSON', async () => {
    __createMock.mockResolvedValue({
      choices: [{ message: { content: 'not-json' } }],
    });

    const { req, res } = createRequestResponse({
      method: 'POST',
      body: { query: 'find founders', networkData: sampleNetworkData(), source: 'linkedin' },
    });

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

  it('returns fail-soft 200 when the Together client throws', async () => {
    __createMock.mockRejectedValue(new Error('upstream down'));

    const { req, res } = createRequestResponse({
      method: 'POST',
      body: { query: 'find founders', networkData: sampleNetworkData(), source: 'linkedin' },
    });

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
      details: 'upstream down',
    });
  });

  it('returns 200 and enriches matches with node data', async () => {
    __createMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Matched people',
              matches: [
                { id: '1', relevance: 0.9 },
                { id: 'missing', relevance: 0.3 },
              ],
            }),
          },
        },
      ],
    });

    const { req, res } = createRequestResponse({
      method: 'POST',
      body: { query: 'find founders', networkData: sampleNetworkData(), source: 'linkedin' },
    });

    await handler(req, res);

    expect(__createMock).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      summary: 'Matched people',
      matches: [
        {
          id: '1',
          relevance: 0.9,
          nodeData: { id: '1', label: 'Alice', title: 'Founder', company: 'Alpha' },
        },
        {
          id: 'missing',
          relevance: 0.3,
          nodeData: null,
        },
      ],
    });
  });
});
