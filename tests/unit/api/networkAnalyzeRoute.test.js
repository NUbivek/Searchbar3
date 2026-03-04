const { createMockReq, createMockRes } = require('./testUtils');

const mockProcessNetworkQuery = jest.fn();
const mockGenerateIndustryClassification = jest.fn();

jest.mock('../../../src/utils/networkLLMUtils', () => ({
  processNetworkQuery: mockProcessNetworkQuery,
  generateIndustryClassification: mockGenerateIndustryClassification,
}));

const handler = require('../../../src/pages/api/network/analyze').default;

describe('/api/network/analyze', () => {
  beforeEach(() => {
    mockProcessNetworkQuery.mockReset();
    mockGenerateIndustryClassification.mockReset();
  });

  test('rejects non-post requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  test('requires a query', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { networkData: { connections: [] } },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Query is required' });
  });

  test('requires network data', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { query: 'find founders', networkData: null },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Network data is required' });
  });

  test('returns fail-soft 200 when processing fails', async () => {
    mockProcessNetworkQuery.mockRejectedValueOnce(new Error('llm down'));

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find operators',
        networkData: {
          user: { firstName: 'Casey' },
          linkedInConnected: true,
          connections: [{ id: 'c1', firstName: 'Alex', company: 'Acme' }],
        },
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(mockProcessNetworkQuery).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      status: 'fail-soft',
      matches: [],
      filteredConnections: [],
      summary: 'Network analysis is temporarily unavailable.',
      responseText: 'Could not process network analysis for "find operators" right now.',
      degradedSources: ['network-analyze'],
      error: 'Failed to process network analysis',
      details: 'llm down',
    });
  });

  test('returns filtered connections and response text on success', async () => {
    mockProcessNetworkQuery.mockResolvedValueOnce({
      matches: [
        {
          id: 'c1',
          relevance: 'High',
          reasoning: 'Operator with relevant experience',
          industry: 'SaaS',
        },
      ],
      summary: 'One strong match',
    });

    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'find operators',
        networkData: {
          user: { firstName: 'Casey' },
          linkedInConnected: true,
          connections: [
            {
              id: 'c1',
              firstName: 'Alex',
              company: 'Acme',
              position: 'Operator',
            },
            {
              id: 'c2',
              firstName: 'Blair',
              company: 'Beta',
              position: 'Engineer',
            },
          ],
        },
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(mockProcessNetworkQuery).toHaveBeenCalledWith(
      'find operators',
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: 'user', name: 'Casey', type: 'user' }),
          expect.objectContaining({ id: 'c1', name: 'Alex', company: 'Acme' }),
          expect.objectContaining({ id: 'c2', name: 'Blair', company: 'Beta' }),
        ]),
        links: expect.arrayContaining([
          expect.objectContaining({ source: 'user', target: 'c1', type: 'linkedin' }),
          expect.objectContaining({ source: 'user', target: 'c2', type: 'linkedin' }),
        ]),
      }),
      'linkedin'
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.summary).toBe('One strong match');
    expect(res.body.responseText).toBe('Found 1 connections matching your search: "find operators"');
    expect(res.body.filteredConnections).toEqual([
      expect.objectContaining({
        id: 'c1',
        relevance: 'High',
        reasoning: 'Operator with relevant experience',
        category: 'SaaS',
      }),
    ]);
  });
});
