import handler from '../../../src/pages/api/relay/index';

describe('/api/relay', () => {
  function createMockRes() {
    return {
      headers: {},
      statusCode: null,
      body: null,
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

  it('returns the relay landing page HTML', async () => {
    const req = { method: 'GET' };
    const res = createMockRes();

    await handler(req, res);

    expect(res.headers['Content-Type']).toBe('text/html');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('OAuth Relay System');
    expect(res.body).toContain('https://research.bivek.ai/api/auth/twitter/callback');
    expect(res.body).toContain('NEXT_PUBLIC_USE_PRODUCTION_CALLBACKS=true');
  });

  it('returns 405 for non-GET requests', async () => {
    const req = { method: 'POST' };
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toBe('Method not allowed');
  });
});
