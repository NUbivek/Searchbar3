import handler from '../../../src/pages/api/auth/linkedin/debug';

describe('/api/auth/linkedin/debug', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function createRes() {
    const res = {
      statusCode: 200,
      jsonBody: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.jsonBody = payload;
        return this;
      },
    };

    return res;
  }

  it('returns diagnostics and suggestions when config is missing', async () => {
    delete process.env.LINKEDIN_CLIENT_ID;
    delete process.env.LINKEDIN_CLIENT_SECRET;
    delete process.env.NEXT_PUBLIC_LINKEDIN_CLIENT_ID;

    const req = {
      headers: {
        host: 'localhost:3000',
      },
      cookies: {},
    };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.environment.hasClientId).toBe(false);
    expect(res.jsonBody.environment.hasClientSecret).toBe(false);
    expect(res.jsonBody.request.baseUrl).toBe('http://localhost:3000');
    expect(res.jsonBody.troubleshooting.suggestions).toEqual(
      expect.arrayContaining([
        expect.stringContaining('LINKEDIN_CLIENT_ID'),
        expect.stringContaining('LINKEDIN_CLIENT_SECRET'),
        expect.stringContaining('NEXT_PUBLIC_LINKEDIN_CLIENT_ID'),
      ])
    );
  });

  it('includes host info, redirect uris, and auth state when configured', async () => {
    process.env.LINKEDIN_CLIENT_ID = 'client-1234567890';
    process.env.LINKEDIN_CLIENT_SECRET = 'super-secret';
    process.env.NEXT_PUBLIC_LINKEDIN_CLIENT_ID = 'public-client';

    const req = {
      headers: {
        host: 'airesearch.bivek.ai',
        'x-forwarded-proto': 'https',
        'user-agent': 'jest',
      },
      cookies: {
        linkedin_access_token: 'token-value-123',
        linkedin_user_id: 'user-42',
      },
    };
    const res = createRes();

    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.request.baseUrl).toBe('https://airesearch.bivek.ai');
    expect(res.jsonBody.oauthConfig.configuredRedirectUri).toBe(
      'https://airesearch.bivek.ai/api/auth/linkedin/callback'
    );
    expect(res.jsonBody.oauthConfig.possibleRedirectUris).toEqual(
      expect.arrayContaining([
        'https://airesearch.bivek.ai/api/auth/linkedin/callback',
        'http://localhost:3000/api/auth/linkedin/callback',
      ])
    );
    expect(res.jsonBody.authState).toEqual({
      hasLinkedInToken: true,
      hasLinkedInUserId: true,
      tokenLength: 'token-value-123'.length,
    });
    expect(res.jsonBody.environment.clientId).toBe('clie...7890');
    expect(res.jsonBody.troubleshooting.suggestions).toEqual([
      'Frontend is using hardcoded redirect URI. Add NEXT_PUBLIC_LINKEDIN_REDIRECT_URI to your .env.local file.',
    ]);
  });
});
