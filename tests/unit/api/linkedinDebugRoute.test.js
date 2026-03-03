const { createMockReq, createMockRes } = require('./testUtils');
const handler = require('../../../src/pages/api/auth/linkedin/debug').default;

describe('/api/auth/linkedin/debug', () => {
  const envKeys = [
    'LINKEDIN_CLIENT_ID',
    'NEXT_PUBLIC_LINKEDIN_CLIENT_ID',
    'LINKEDIN_CLIENT_SECRET',
    'LINKEDIN_REDIRECT_URI',
    'NEXT_PUBLIC_LINKEDIN_REDIRECT_URI',
    'NEXT_PUBLIC_APP_URL',
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

  test('reports missing configuration and hardcoded frontend fallbacks', () => {
    const req = createMockReq({
      headers: { host: 'app.example.com' },
    });
    const res = createMockRes();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.environment).toMatchObject({
      hasClientId: false,
      hasClientSecret: false,
      clientId: 'Not configured',
      clientIdLength: 0,
    });
    expect(res.body.oauthConfig.configuredRedirectUri).toBe(
      'http://app.example.com/api/auth/linkedin/callback'
    );
    expect(res.body.oauthConfig.frontendConfig).toEqual({
      usesHardcodedClientId: true,
      usesHardcodedRedirectUri: true,
    });
    expect(res.body.troubleshooting.suggestions).toEqual(
      expect.arrayContaining([
        'LinkedIn Client ID is missing. Add LINKEDIN_CLIENT_ID to your .env.local file.',
        'LinkedIn Client Secret is missing. Add LINKEDIN_CLIENT_SECRET to your .env.local file.',
        'Frontend is using hardcoded LinkedIn Client ID. Add NEXT_PUBLIC_LINKEDIN_CLIENT_ID to your .env.local file.',
        'Frontend is using hardcoded redirect URI. Add NEXT_PUBLIC_LINKEDIN_REDIRECT_URI to your .env.local file.',
      ])
    );
  });

  test('reports auth cookies and explicit redirect configuration', () => {
    process.env.LINKEDIN_CLIENT_ID = 'abcd1234wxyz';
    process.env.LINKEDIN_CLIENT_SECRET = 'secret';
    process.env.LINKEDIN_REDIRECT_URI = 'https://app.example.com/auth/callback';
    process.env.NEXT_PUBLIC_LINKEDIN_CLIENT_ID = 'public-client';
    process.env.NEXT_PUBLIC_LINKEDIN_REDIRECT_URI = 'https://app.example.com/frontend/callback';
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
    process.env.NODE_ENV = 'test';

    const req = createMockReq({
      headers: {
        host: 'app.example.com',
        'x-forwarded-proto': 'https',
        referer: 'https://app.example.com/network',
        origin: 'https://app.example.com',
      },
      cookies: {
        linkedin_access_token: 'token-value',
      },
    });
    const res = createMockRes();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.environment).toMatchObject({
      nodeEnv: 'test',
      hasClientId: true,
      hasClientSecret: true,
      clientId: 'abcd...wxyz',
      clientIdLength: 12,
    });
    expect(res.body.request).toMatchObject({
      host: 'app.example.com',
      protocol: 'https',
      baseUrl: 'https://app.example.com',
    });
    expect(res.body.oauthConfig).toMatchObject({
      configuredRedirectUri: 'https://app.example.com/auth/callback',
      frontendConfig: {
        usesHardcodedClientId: false,
        usesHardcodedRedirectUri: false,
      },
    });
    expect(res.body.authState).toMatchObject({
      hasLinkedInToken: true,
      hasLinkedInUserId: false,
      tokenLength: 'token-value'.length,
    });
    expect(res.body.troubleshooting.suggestions).toEqual(
      expect.arrayContaining([
        'LinkedIn access token exists but user ID cookie is missing. This may indicate an issue with the token exchange process.',
      ])
    );
  });
});
