const handler = require('../../../src/pages/api/openSearch').default;

describe('/api/openSearch', () => {
  function createRes() {
    return {
      statusCode: 200,
      headers: {},
      body: null,
      ended: false,
      setHeader(key, value) {
        this.headers[key] = value;
        return this;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
      end() {
        this.ended = true;
        return this;
      }
    };
  }

  it('returns 200 for OPTIONS requests', async () => {
    const req = { method: 'OPTIONS', url: '/api/openSearch', body: {} };
    const res = createRes();

    await handler(req, res);

    expect(res.headers['Content-Type']).toBe('application/json');
    expect(res.statusCode).toBe(200);
    expect(res.ended).toBe(true);
  });

  it('returns 405 for non-POST requests', async () => {
    const req = { method: 'GET', url: '/api/openSearch', body: {} };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({
      error: 'Method not allowed',
      allowedMethods: ['POST']
    });
  });

  it('returns 400 when query is missing', async () => {
    const req = { method: 'POST', url: '/api/openSearch', body: { sources: ['Web'] } };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Query is required' });
  });

  it('returns simplified normalized response for valid requests', async () => {
    const req = {
      method: 'POST',
      url: '/api/openSearch',
      body: {
        query: 'workflow automation',
        sources: ['Web', 'Twitter']
      }
    };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      query: 'workflow automation',
      model: 'mistral-7b',
      sources: ['Web', 'Twitter'],
      message: 'Search processing has been simplified. No results will be returned.',
      results: []
    });
    expect(typeof res.body.timestamp).toBe('string');
  });
});
