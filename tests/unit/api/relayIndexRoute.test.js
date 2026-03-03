const handler = require('../../../src/pages/api/relay/index').default;

function createMockRes() {
  const res = {};
  res.statusCode = 200;
  res.headers = {};
  res.body = undefined;
  res.setHeader = jest.fn((key, value) => {
    res.headers[key] = value;
    return res;
  });
  res.status = jest.fn((code) => {
    res.statusCode = code;
    return res;
  });
  res.send = jest.fn((payload) => {
    res.body = payload;
    return res;
  });
  return res;
}

describe('/api/relay/index', () => {
  it('returns the relay setup HTML page', () => {
    const req = { method: 'GET' };
    const res = createMockRes();

    handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/html');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledTimes(1);
    expect(typeof res.body).toBe('string');
    expect(res.body).toContain('OAuth Relay System');
    expect(res.body).toContain('https://research.bivek.ai/api/auth/twitter/callback');
    expect(res.body).toContain('https://research.bivek.ai/api/relay/reddit');
    expect(res.body).toContain('NEXT_PUBLIC_USE_PRODUCTION_CALLBACKS=true');
  });
});
