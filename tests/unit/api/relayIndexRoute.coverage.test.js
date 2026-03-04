import handler from '../../../src/pages/api/relay/index';

function createMockRes() {
  const res = {
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

  return res;
}

describe('/api/relay/index', () => {
  it('returns the relay info page as html', async () => {
    const req = { method: 'GET' };
    const res = createMockRes();

    await handler(req, res);

    expect(res.headers['Content-Type']).toBe('text/html');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('OAuth Relay System');
    expect(res.body).toContain('research.bivek.ai');
    expect(res.body).toContain('/api/auth/twitter/callback');
    expect(res.body).toContain('/api/auth/linkedin/callback');
    expect(res.body).toContain('/api/relay/reddit');
  });
});
