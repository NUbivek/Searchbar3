const handler = require('../../../src/pages/api/relay/twitter').default;

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

describe('/api/relay/twitter', () => {
  it('renders the twitter relay page with the callback parameters', () => {
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
    expect(res.body).toContain('Twitter OAuth Relay');
    expect(res.body).toContain('abc1234567...');
    expect(res.body).toContain('state-token');
    expect(res.body).toContain('/api/auth/twitter/callback');
    expect(res.body).toContain('http://localhost:3001');
  });
});
