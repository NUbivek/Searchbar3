const handlerModule = require('../../../src/pages/api/auth/twitter/logout.js');
const { createMockReq } = require('./testUtils');

const handler = handlerModule.default || handlerModule;

function createMockResWithHeaders() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
  };

  return res;
}

describe('/api/auth/twitter/logout', () => {
  it('returns 405 for non-GET requests', () => {
    const req = createMockReq({ method: 'POST' });
    const res = createMockResWithHeaders();

    handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('clears auth cookies and returns success for GET requests', () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockResWithHeaders();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'Logged out of Twitter',
    });

    expect(Array.isArray(res.headers['Set-Cookie'])).toBe(true);
    expect(res.headers['Set-Cookie']).toEqual(
      expect.arrayContaining([
        expect.stringContaining('twitter_auth_state=;'),
        expect.stringContaining('twitter_code_verifier=;'),
        expect.stringContaining('twitter_access_token=;'),
      ])
    );
  });
});
