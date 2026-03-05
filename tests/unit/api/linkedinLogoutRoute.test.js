const handler = require('../../../src/pages/api/auth/linkedin/logout').default;
const { createMockReq } = require('./testUtils');

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe('/api/auth/linkedin/logout', () => {
  it('rejects non-GET requests', () => {
    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
    expect(res.headers['Set-Cookie']).toBeUndefined();
  });

  it('clears linkedin cookies and returns success', () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'Logged out from LinkedIn',
    });
    expect(res.headers['Set-Cookie']).toEqual([
      expect.stringContaining('linkedin_access_token=;'),
      expect.stringContaining('linkedin_user_id=;'),
    ]);
    expect(res.headers['Set-Cookie'][0]).toContain('Max-Age=0');
    expect(res.headers['Set-Cookie'][1]).toContain('Max-Age=0');
  });
});
