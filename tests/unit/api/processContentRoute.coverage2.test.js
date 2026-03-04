const handler = require('../../../src/pages/api/process-content').default;
const { createMockReq, createMockRes } = require('./testUtils');

describe('/api/process-content', () => {
  it('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns 400 for invalid request bodies', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { query: '', results: null },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'Invalid request. Query and results array are required.',
    });
  });

  it('returns a successful empty processedContent array for empty results', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { query: 'founders', results: [] },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      processedContent: [],
    });
  });

  it('returns 500 when request parsing throws unexpectedly', async () => {
    const req = { method: 'POST' };
    Object.defineProperty(req, 'body', {
      get() {
        throw new Error('boom');
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'Failed to process content',
      message: 'boom',
    });
  });
});
