import handler from '../../../src/pages/api/auth/linkedin/logout';

describe('/api/auth/linkedin/logout', () => {
  function createMockRes() {
    const res = {};
    res.statusCode = 200;
    res.headers = {};
    res.status = jest.fn((code) => {
      res.statusCode = code;
      return res;
    });
    res.setHeader = jest.fn((name, value) => {
      res.headers[name] = value;
      return res;
    });
    res.json = jest.fn((payload) => {
      res.body = payload;
      return res;
    });
    return res;
  }

  it('returns 405 for non-GET requests', async () => {
    const req = { method: 'POST' };
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.json).toHaveBeenCalledWith({ error: 'Method not allowed' });
  });

  it('clears linkedin auth cookies and returns success for GET', async () => {
    const req = { method: 'GET' };
    const res = createMockRes();

    await handler(req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', [
      'linkedin_access_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      'linkedin_user_id=; Path=/; Max-Age=0; SameSite=Lax'
    ]);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: 'Logged out from LinkedIn'
    });
  });
});
