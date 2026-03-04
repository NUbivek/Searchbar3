import handler from '../../../src/pages/api/relay/index';

describe('/api/relay/index', () => {
  function createRes() {
    return {
      statusCode: 200,
      headers: {},
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

  it('returns the relay landing page html', async () => {
    const req = { method: 'GET' };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/html');
    expect(res.body).toContain('OAuth Relay System');
    expect(res.body).toContain('How It Works');
    expect(res.body).toContain('Provider Configuration');
  });
});
