import handler from '../../../src/pages/api/process-content';

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
  };
}

describe('/api/process-content route', () => {
  it('returns 405 for non-POST', async () => {
    const req = { method: 'GET', body: {} };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('returns 400 when query or results are invalid', async () => {
    const req = { method: 'POST', body: { query: '', results: null } };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'Invalid request. Query and results array are required.'
    });
  });

  it('returns 200 with processed content for a valid request', async () => {
    const req = {
      method: 'POST',
      body: {
        query: 'seed-stage fintech',
        results: [
          {
            title: 'Alpha raises seed round',
            link: 'https://example.com/alpha',
            snippet: 'Alpha is a fintech company raising a seed round.',
          },
        ],
      },
    };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.processedContent)).toBe(true);
  });
});
