import handler from '../../../src/pages/api/openSearch';

function createMockReq({ method = 'POST', body = {} } = {}) {
  return {
    method,
    body,
  };
}

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(name, value) {
      this.headers[name] = value;
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
    },
  };
}

describe('/api/openSearch simplified route', () => {
  it('returns 200 for OPTIONS requests', async () => {
    const req = createMockReq({ method: 'OPTIONS' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.ended).toBe(true);
    expect(res.headers['Content-Type']).toBe('application/json');
  });

  it('returns 405 for non-POST requests', async () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({
      error: 'Method not allowed',
      allowedMethods: ['POST'],
    });
  });

  it('returns 400 when query is missing', async () => {
    const req = createMockReq({ body: {} });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'Query is required',
    });
  });

  it('returns normalized simplified response for valid requests', async () => {
    const req = createMockReq({
      body: {
        query: 'workflow tools',
      },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      query: 'workflow tools',
      model: 'mistral-7b',
      sources: ['Web'],
      message: 'Search processing has been simplified. No results will be returned.',
      results: [],
    });
    expect(typeof res.body.timestamp).toBe('string');
  });
});
