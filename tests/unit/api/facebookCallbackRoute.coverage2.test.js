import handler from '../../../src/pages/api/auth/facebook/callback';

describe('/api/auth/facebook/callback', () => {
  function createRes() {
    return {
      redirect: jest.fn(),
    };
  }

  it('redirects non-GET requests back to the network page', async () => {
    const req = { method: 'POST', query: {} };
    const res = createRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=Method%20not%20allowed');
  });

  it('redirects with encoded provider error message', async () => {
    const req = {
      query: {
        error: 'access_denied',
        error_description: 'Denied by user',
      },
    };
    const res = createRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=Denied%20by%20user');
  });

  it('redirects when authorization code is missing', async () => {
    const req = { query: {} };
    const res = createRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=No authorization code received');
  });

  it('redirects with code and facebook source on success', async () => {
    const req = {
      query: {
        code: 'abc123',
      },
    };
    const res = createRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?code=abc123&source=facebook');
  });
});
