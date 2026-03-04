import handler from '../../../src/pages/api/network/analyze';
import { processNetworkQuery } from '../../../src/utils/networkLLMUtils';

jest.mock('../../../src/utils/networkLLMUtils', () => ({
  processNetworkQuery: jest.fn(),
  generateIndustryClassification: jest.fn(),
}));

function createReq(overrides = {}) {
  return {
    method: 'POST',
    body: {},
    ...overrides,
  };
}

function createRes() {
  const res = {};
  res.statusCode = 200;
  res.body = null;
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.json = jest.fn((payload) => {
    res.body = payload;
    return res;
  });
  return res;
}

describe('/api/network/analyze', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 405 for non-POST requests', async () => {
    const req = createReq({ method: 'GET' });
    const res = createRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns 400 when query is missing', async () => {
    const req = createReq({ body: { networkData: { connections: [] } } });
    const res = createRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toEqual({ error: 'Query is required' });
  });

  it('returns 400 when network data is missing', async () => {
    const req = createReq({ body: { query: 'fintech' } });
    const res = createRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toEqual({ error: 'Network data is required' });
  });

  it('returns filtered connections and response text on success', async () => {
    processNetworkQuery.mockResolvedValue({
      matches: [
        { id: '1', relevance: 0.95, reasoning: 'Strong match', category: 'fintech' },
      ],
    });

    const req = createReq({
      body: {
        query: 'fintech',
        networkData: {
          linkedInConnected: true,
          user: { firstName: 'Bivek' },
          connections: [
            { id: '1', firstName: 'Alice', lastName: 'Smith' },
            { id: '2', firstName: 'Bob', lastName: 'Jones' },
          ],
          networksData: { total: 2 },
        },
      },
    });
    const res = createRes();

    await handler(req, res);

    expect(processNetworkQuery).toHaveBeenCalledWith(
      'fintech',
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: 'user', name: 'Bivek' }),
          expect.objectContaining({ id: '1', name: 'Alice' }),
        ]),
        links: expect.arrayContaining([
          expect.objectContaining({ source: 'user', target: '1' }),
        ]),
      }),
      'linkedin'
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.body.filteredConnections).toEqual([
      expect.objectContaining({
        id: '1',
        firstName: 'Alice',
        lastName: 'Smith',
        relevance: 0.95,
        reasoning: 'Strong match',
      }),
    ]);
    expect(res.body.responseText).toBe('Found 1 connections matching your search: "fintech"');
  });

  it('returns 500 when processing fails', async () => {
    processNetworkQuery.mockRejectedValue(new Error('LLM down'));

    const req = createReq({
      body: {
        query: 'ai',
        networkData: {
          twitterConnected: true,
          twitterUser: { username: 'bivek' },
          connections: [],
          networksData: { total: 0 },
        },
      },
    });
    const res = createRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.body).toEqual({
      error: 'Failed to process network analysis',
      details: 'LLM down',
    });
  });
});
