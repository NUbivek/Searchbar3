jest.mock('axios', () => ({
  get: jest.fn(),
}));

const axios = require('axios');
const handler = require('../../../src/pages/api/sourceSearch').default;
const { createMockReq, createMockRes } = require('./testUtils');

describe('/api/sourceSearch fail-soft behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns fail-soft payload for unsupported source values', async () => {
    const req = createMockReq({
      method: 'GET',
      query: { source: 'UnknownNet', query: 'founders' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      source: 'UnknownNet',
      results: [],
      status: 'fail-soft',
      degradedSources: ['unknownnet'],
      error: 'Unsupported source: UnknownNet',
    });
  });

  test('returns fail-soft payload when upstream provider call throws', async () => {
    axios.get.mockRejectedValueOnce(new Error('linkedin upstream down'));

    const req = createMockReq({
      method: 'GET',
      query: { source: 'LinkedIn', query: 'operators', apiKey: 'token' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      source: 'LinkedIn',
      results: [],
      status: 'fail-soft',
      degradedSources: ['linkedin'],
      error: 'linkedin upstream down',
    });
  });
});
