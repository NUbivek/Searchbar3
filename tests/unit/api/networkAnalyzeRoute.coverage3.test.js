const { createMockReq, createMockRes } = require('./testUtils');

jest.mock('../../../src/utils/networkLLMUtils', () => ({
  processNetworkQuery: jest.fn(),
  generateIndustryClassification: jest.fn(),
}));

const {
  processNetworkQuery,
  generateIndustryClassification,
} = require('../../../src/utils/networkLLMUtils');
const handler = require('../../../src/pages/api/network/analyze').default;

describe('/api/network/analyze', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    generateIndustryClassification.mockReturnValue('General');
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

  it('returns 400 when network data is invalid', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { query: 'find fintech', networkData: {} },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'Network data is required',
    });
  });

  it('returns filtered connections for a successful LinkedIn analysis', async () => {
    processNetworkQuery.mockResolvedValue({
      matches: [
        {
          id: 'c1',
          relevance: 'High',
          reasoning: 'Strong operator fit',
          industry: 'SaaS',
        },
      ],
      summary: 'ok',
    });

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find operators in SaaS',
        networkData: {
          linkedInConnected: true,
          user: { firstName: 'Bivek' },
          connections: [
            {
              id: 'c1',
              firstName: 'Alice',
              lastName: 'Ng',
              company: 'Acme',
              position: 'CEO',
            },
          ],
        },
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(processNetworkQuery).toHaveBeenCalledWith(
      'find operators in SaaS',
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: 'user', name: 'Bivek' }),
          expect.objectContaining({ id: 'c1', name: 'Alice' }),
        ]),
        links: expect.arrayContaining([
          expect.objectContaining({ source: 'user', target: 'c1', type: 'linkedin' }),
        ]),
      }),
      'linkedin'
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.responseText).toContain('Found 1 connections');
    expect(res.body.filteredConnections).toHaveLength(1);
    expect(res.body.filteredConnections[0]).toEqual(
      expect.objectContaining({
        id: 'c1',
        relevance: 'High',
        reasoning: 'Strong operator fit',
        category: 'SaaS',
      })
    );
  });

  it('returns 500 when analysis throws', async () => {
    processNetworkQuery.mockRejectedValue(new Error('boom'));

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find operators',
        networkData: {
          twitterConnected: true,
          twitterUser: { username: 'bivek' },
          connections: [],
        },
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'Failed to process network analysis',
      details: 'boom',
    });
  });
});
