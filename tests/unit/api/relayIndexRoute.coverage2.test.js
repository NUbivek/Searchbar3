import handler from '../../../src/pages/api/relay/index';

describe('/api/relay additional coverage', () => {
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

  it('renders the relay page with production and local relay guidance', async () => {
    const req = { method: 'GET' };
    const res = createMockRes();

    await handler(req, res);

    expect(res.headers['Content-Type']).toBe('text/html');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('https://research.bivek.ai/api/relay/reddit');
    expect(res.body).toContain('Local Development Setup');
    expect(res.body).toContain('NEXT_PUBLIC_BASE_URL=http://localhost:3001');
    expect(res.body).toContain('NEXT_PUBLIC_PRODUCTION_URL=https://research.bivek.ai');
  });
});
