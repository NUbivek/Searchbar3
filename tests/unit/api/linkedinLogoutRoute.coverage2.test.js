const handler = require('../../../src/pages/api/auth/linkedin/logout').default;
const { createMockReq } = require('./testUtils');

describe('/api/auth/linkedin/logout', () => {
  function createMockRes() {
    return {
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
      },
    };
  }

  it('returns 405 for non-GET requests', () => {
    const req = createMockReq({ method: 'POST' });
    const res = createMockRes();

    handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('clears LinkedIn cookies and returns success for GET', () => {
    const req = createMockReq({ method: 'GET' });
    const res = createMockRes();

    handler(req, res);

    expect(res.headers['Set-Cookie']).toEqual([
      'linkedin_access_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      'linkedin_user_id=; Path=/; Max-Age=0; SameSite=Lax',
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'Logged out from LinkedIn',
    });
  });
});
