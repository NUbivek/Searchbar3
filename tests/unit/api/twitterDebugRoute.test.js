const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/auth/twitter/debug').default;

describe('/api/auth/twitter/debug', () => {
  const envKeys = [
    'TWITTER_CLIENT_ID',
    'TWITTER_API_KEY',
    'TWITTER_CLIENT_SECRET',
    'TWITTER_REDIRECT_URI',
    'NEXT_PUBLIC_TWITTER_CLIENT_ID',
    'NODE_ENV',
  ];
  const originalEnv = {};

  beforeAll(() => {
    envKeys.forEach((key) => {
      originalEnv[key] = process.env[key];
    });
  });

  beforeEach(() => {
    envKeys.forEach((key) => delete process.env[key]);
  });

  afterAll(() => {
    envKeys.forEach((key) => {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    });
  });

  test('reports missing configuration suggestions', async () => {
    const req = createMockReq({ headers: {} });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.environment).toMatchObject({
      hasClientId: false,
      hasClientSecret: false,
      hasRedirectUri: false,
      hasPublicClientId: false,
    });
    expect(res.body.oauthConfig.configuredRedirectUri).toBe(
      'http://localhost:3000/api/auth/twitter/callback'
    );
    expect(res.body.troubleshooting.suggestions).toEqual(
      expect.arrayContaining([
        'Missing Twitter Client ID: Add TWITTER_CLIENT_ID to your .env.local file',
        'Missing Twitter Client Secret: Add TWITTER_CLIENT_SECRET to your .env.local file',
        'Consider adding TWITTER_REDIRECT_URI to your .env.local file for explicit configuration',
      ])
    );
  });

  test('surfaces cookie-based auth state and client id masking', async () => {
    process.env.TWITTER_API_KEY = 'abcde12345';
    process.env.TWITTER_CLIENT_SECRET = 'secret';
    process.env.TWITTER_REDIRECT_URI = 'https://example.com/callback';
    process.env.NEXT_PUBLIC_TWITTER_CLIENT_ID = 'public-id';
    process.env.NODE_ENV = 'test';

    const req = createMockReq({
      headers: {
        cookie: 'twitter_access_token=1; twitter_refresh_token=1; twitter_code_verifier=1; twitter_auth_state=1; twitter_error=denied',
      },
      query: { error: 'client_id_invalid' },
    });
    const res = createMockRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.environment).toMatchObject({
      hasClientId: true,
      hasClientSecret: true,
      hasRedirectUri: true,
      hasPublicClientId: true,
      mode: 'test',
    });
    expect(res.body.oauthConfig).toMatchObject({
      configuredRedirectUri: 'https://example.com/callback',
      clientId: 'abcde...',
    });
    expect(res.body.authState).toMatchObject({
      hasTwitterAccessToken: true,
      hasTwitterRefreshToken: true,
      hasTwitterCodeVerifier: true,
      hasTwitterAuthState: true,
      recentError: 'denied',
    });
    expect(res.body.troubleshooting.suggestions).toEqual(
      expect.arrayContaining([
        'Recent Twitter error detected: denied',
        'Client ID error detected in URL. Make sure your TWITTER_CLIENT_ID is correct and matches the one in your Twitter Developer Portal',
      ])
    );
  });
});
