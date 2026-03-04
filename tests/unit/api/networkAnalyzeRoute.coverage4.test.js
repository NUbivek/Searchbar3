jest.mock('../../../src/utils/networkLLMUtils', () => ({
  processNetworkQuery: jest.fn(),
  generateIndustryClassification: jest.fn(),
}));

const handler = require('../../../src/pages/api/network/analyze').default;
const {
  processNetworkQuery,
  generateIndustryClassification,
} = require('../../../src/utils/networkLLMUtils');
const { createMockReq, createMockRes } = require('./testUtils');

describe('/api/network/analyze route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    generateIndustryClassification.mockImplementation(() => 'generic');
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
      body: { query: 'founder' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Network data is required' });
  });

  it('returns filtered matches for linkedin-connected data', async () => {
    processNetworkQuery.mockResolvedValue({
      matches: [
        {
          id: 'person-1',
          score: 0.92,
          reasoning: 'Strong operator fit',
        },
      ],
    });

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'operator',
        networkData: {
          linkedInConnected: true,
          connections: [
            { id: 'person-1', name: 'Alice Smith' },
            { id: 'person-2', name: 'Bob Jones' },
          ],
        },
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(processNetworkQuery).toHaveBeenCalledWith(
      'operator',
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: 'user' }),
          expect.objectContaining({ id: 'person-1' }),
          expect.objectContaining({ id: 'person-2' }),
        ]),
        links: expect.arrayContaining([
          expect.objectContaining({ source: 'user', target: 'person-1' }),
          expect.objectContaining({ source: 'user', target: 'person-2' }),
        ]),
      }),
      'linkedin'
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.responseText).toBe(
      'Found 1 connections matching your search: "operator"'
    );
    expect(res.body.filteredConnections).toEqual([
      expect.objectContaining({
        id: 'person-1',
        relevance: 'Medium',
        reasoning: 'Strong operator fit',
        category: '',
      }),
    ]);
  });

  it('returns a no-results response when no matches are found', async () => {
    processNetworkQuery.mockResolvedValue({ matches: [] });

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'fintech',
        networkData: {
          twitterConnected: true,
          connections: [{ id: 'person-1', name: 'Alice Smith' }],
        },
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(processNetworkQuery).toHaveBeenCalledWith(
      'fintech',
      expect.any(Object),
      'twitter'
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.responseText).toBe(
      'No connections found matching your search: "fintech"'
    );
    expect(res.body.filteredConnections || []).toEqual([]);
  });

  it('returns 500 when analysis fails', async () => {
    processNetworkQuery.mockRejectedValue(new Error('upstream failed'));

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'operator',
        networkData: {
          connections: [{ id: 'person-1', name: 'Alice Smith' }],
        },
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'Failed to process network analysis',
      details: 'upstream failed',
    });
  });
});
