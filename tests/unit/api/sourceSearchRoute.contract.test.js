jest.mock('axios', () => ({
  get: jest.fn(),
}));

const axios = require('axios');
const { validateSearchResponseV1 } = require('../../../src/utils/contracts/searchResponse');
const handler = require('../../../src/pages/api/sourceSearch').default;
const { createMockReq, createMockRes } = require('./testUtils');

describe('/api/sourceSearch contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns contract-compliant success payload for supported source', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        items: [{ id: 'x-1', title: 'Result' }],
        providerMeta: { name: 'x-api' },
      },
    });

    const req = createMockReq({
      method: 'GET',
      query: {
        source: 'X',
        query: 'founders',
        apiKey: 'token',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.get).toHaveBeenCalledWith(
      'https://api.twitter.com/2/tweets/search/recent',
      {
        headers: { Authorization: 'Bearer token' },
        params: { query: 'founders', max_results: 10 },
        timeout: 10000,
      }
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.results).toEqual([{ id: 'x-1', title: 'Result' }]);
    expect(res.body.legacyResults).toEqual({
      items: [{ id: 'x-1', title: 'Result' }],
      providerMeta: { name: 'x-api' },
    });
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });

  test('returns contract-compliant fail-soft payload for upstream errors', async () => {
    axios.get.mockRejectedValueOnce(new Error('x upstream down'));

    const req = createMockReq({
      method: 'GET',
      query: {
        source: 'X',
        query: 'founders',
        apiKey: 'token',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(axios.get).toHaveBeenCalledWith(
      'https://api.twitter.com/2/tweets/search/recent',
      {
        headers: { Authorization: 'Bearer token' },
        params: { query: 'founders', max_results: 10 },
        timeout: 10000,
      }
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('fail-soft');
    expect(res.body.degradedSources).toEqual(['x']);
    expect(validateSearchResponseV1(res.body).valid).toBe(true);
  });
});
