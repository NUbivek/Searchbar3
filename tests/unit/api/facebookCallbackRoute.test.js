const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/auth/facebook/callback').default;

function createRedirectRes() {
  const res = createMockRes();
  res.redirectTarget = null;
  res.redirect = jest.fn((target) => {
    res.redirectTarget = target;
    return res;
  });
  return res;
}

describe('/api/auth/facebook/callback', () => {
  test('redirects with auth error from facebook', async () => {
    const req = createMockReq({
      query: {
        error: 'access_denied',
        error_description: 'User denied access',
      },
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=User%20denied%20access');
  });

  test('redirects when no authorization code is received', async () => {
    const req = createMockReq({ query: {} });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?error=No authorization code received');
  });

  test('redirects with code for frontend token exchange', async () => {
    const req = createMockReq({
      query: {
        code: 'facebook-auth-code',
        state: 'csrf-state',
      },
    });
    const res = createRedirectRes();

    await handler(req, res);

    expect(res.redirect).toHaveBeenCalledWith('/network?code=facebook-auth-code&source=facebook');
  });
});
