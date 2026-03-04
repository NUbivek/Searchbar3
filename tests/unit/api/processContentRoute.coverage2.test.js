const handler =
  require('../../../src/pages/api/process-content').default;
const { createMockReq, createMockRes } = require('./testUtils');

describe('/api/process-content', () => {
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
      body: { results: [] },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'Invalid request. Query and results array are required.',
    });
  });

  it('returns 400 when results is not an array', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { query: 'ai infra', results: null },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'Invalid request. Query and results array are required.',
    });
  });

  it('returns a successful empty processed payload for empty results', async () => {
    const req = createMockReq({
      method: 'POST',
      body: { query: 'ai infra', results: [] },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      processedContent: [],
    });
  });

  it('returns a normalized successful payload for valid results', async () => {
    const req = createMockReq({
      method: 'POST',
      body: {
        query: 'ai infra',
        results: [
          {
            title: 'Acme AI',
            snippet: 'Building workflow tooling for teams.',
            source: 'web',
            link: 'https://example.com/acme-ai',
          },
        ],
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.processedContent)).toBe(true);
  });
});
