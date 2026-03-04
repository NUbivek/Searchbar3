import handler from '../../../src/pages/api/relay/index';

describe('/api/relay', () => {
  function createMockReq(overrides = {}) {
    return {
      method: 'GET',
      ...overrides,
    };
  }

  function createMockRes() {
    return {
      headers: {},
      statusCode: 200,
      body: '',
      setHeader(name, value) {
        this.headers[name] = value;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      send(payload) {
        this.body = payload;
        return this;
      },
    };
  }

  it('returns the OAuth relay landing page HTML', async () => {
    const req = createMockReq();
    const res = createMockRes();

    await handler(req, res);

    expect(res.headers['Content-Type']).toBe('text/html');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('OAuth Relay System');
    expect(res.body).toContain('https://research.bivek.ai/api/auth/twitter/callback');
    expect(res.body).toContain('NEXT_PUBLIC_USE_PRODUCTION_CALLBACKS=true');
  });
});
