const handler = require('../../../src/pages/api/relay/reddit').default;

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

describe('/api/relay/reddit', () => {
  it('returns 405 for non-GET requests', () => {
    const req = {
      method: 'POST',
      query: {},
    };
    const res = createMockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.send).toHaveBeenCalledWith('Method not allowed');
  });

  it('renders the reddit relay page with the callback parameters', () => {
    const req = {
      method: 'GET',
      query: {
        code: 'abc1234567890',
        state: 'state-token',
      },
    };
    const res = createMockRes();

    handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/html');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledTimes(1);
    expect(typeof res.body).toBe('string');
    expect(res.body).toContain('Reddit OAuth Relay');
    expect(res.body).toContain('abc1234567...');
    expect(res.body).toContain('state-token');
    expect(res.body).toContain('/api/auth/reddit/callback');
    expect(res.body).toContain('http://localhost:3001');
    expect(res.body).toContain('/api/relay');
  });

  it('renders placeholder values when no callback parameters are present', () => {
    const req = {
      method: 'GET',
      query: {},
    };
    const res = createMockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledTimes(1);
    expect(res.body).toContain('Reddit OAuth Relay');
    expect(res.body).toContain('<strong>Code:</strong> None');
    expect(res.body).toContain('<strong>State:</strong> None');
    expect(res.body).toContain('/api/auth/reddit/callback');
  });
});
