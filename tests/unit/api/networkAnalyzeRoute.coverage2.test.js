jest.mock('../../../src/utils/networkLLMUtils', () => ({
  processNetworkQuery: jest.fn(),
  generateIndustryClassification: jest.fn(),
}));

const handler =
  require('../../../src/pages/api/network/analyze').default;
const {
  processNetworkQuery,
} = require('../../../src/utils/networkLLMUtils');
const { createMockReq, createMockRes } = require('./testUtils');

describe('/api/network/analyze', () => {
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
      body: { networkData: { connections: [] } },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Query is required' });
  });

  it('returns 400 when network data is missing', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { query: 'fintech founders' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Network data is required' });
  });

  it('returns filtered connections and response text on success', async () => {
    processNetworkQuery.mockResolvedValue({
      matches: [{ id: 'conn-1' }],
      responseText: 'Found one relevant connection.',
    });

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'Find AI operators',
        networkData: {
          linkedInConnected: true,
          user: { name: 'Bivek' },
          connections: [
            {
              id: 'conn-1',
              name: 'Alice',
              title: 'Operator',
              company: 'Acme',
            },
          ],
        },
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(processNetworkQuery).toHaveBeenCalledWith(
      'Find AI operators',
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: 'user' }),
          expect.objectContaining({ id: 'conn-1', name: 'Alice' }),
        ]),
        links: expect.arrayContaining([
          expect.objectContaining({ source: 'user', target: 'conn-1' }),
        ]),
      }),
      'linkedin'
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.filteredConnections).toEqual([
      expect.objectContaining({ id: 'conn-1', name: 'Alice' }),
    ]);
    expect(res.body.responseText).toBe(
      'Found 1 connections matching your search: "Find AI operators"'
    );
  });

  it('returns 500 when processing fails', async () => {
    processNetworkQuery.mockRejectedValue(new Error('LLM failed'));

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'Find operators',
        networkData: {
          twitterConnected: true,
          connections: [{ id: 'conn-2', name: 'Bob' }],
        },
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'Failed to process network analysis',
      details: 'LLM failed',
    });
  });
});
