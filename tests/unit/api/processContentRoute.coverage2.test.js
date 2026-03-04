const handler = require('../../../src/pages/api/process-content').default;
const { createMockReq, createMockRes } = require('./testUtils');

describe('/api/process-content', () => {
  test('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  test('returns 400 when query or results are missing', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { query: 'test query' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'Invalid request. Query and results array are required.',
    });
  });

  test('returns success with empty processedContent when results are empty', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { query: 'test query', results: [] },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      processedContent: [],
    });
  });
});
