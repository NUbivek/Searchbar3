import handler from '../../../src/pages/api/auth/linkedin/logout';

describe('/api/auth/linkedin/logout', () => {
  function createRes() {
    const res = {
      statusCode: 200,
      headers: {},
      body: undefined,
      status(code) {
        this.statusCode = code;
        return this;
      },
      setHeader(name, value) {
        this.headers[name] = value;
      },
      json(payload) {
        this.body = payload;
        return this;
      }
    };

    return res;
  }

  it('returns 405 for non-GET requests', () => {
    const req = { method: 'POST' };
    const res = createRes();

    handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('clears LinkedIn cookies and returns success for GET', () => {
    const req = { method: 'GET' };
    const res = createRes();

    handler(req, res);

    expect(res.headers['Set-Cookie']).toEqual([
      'linkedin_access_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      'linkedin_user_id=; Path=/; Max-Age=0; SameSite=Lax'
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: 'Logged out from LinkedIn'
    });
  });
});
