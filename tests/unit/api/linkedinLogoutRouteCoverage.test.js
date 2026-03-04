import handler from '../../../src/pages/api/auth/linkedin/logout';

function createMockRes() {
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
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };

  return res;
}

describe('/api/auth/linkedin/logout', () => {
  it('returns 405 for non-GET requests', () => {
    const req = { method: 'POST' };
    const res = createMockRes();

    handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
  });

  it('clears cookies and returns success for GET requests', () => {
    const req = { method: 'GET' };
    const res = createMockRes();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Set-Cookie']).toEqual([
      'linkedin_access_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      'linkedin_user_id=; Path=/; Max-Age=0; SameSite=Lax'
    ]);
    expect(res.body).toEqual({
      success: true,
      message: 'Logged out from LinkedIn'
    });
  });
});
