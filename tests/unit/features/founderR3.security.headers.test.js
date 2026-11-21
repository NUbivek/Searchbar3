/**
 * Round 3, security-headers (next.config.js): every response carries the standard safe headers. No
 * content-security policy, since one could break pages and that cannot be verified here.
 */
const nextConfig = require('../../../next.config');

describe('security-headers', () => {
  test('every path gets nosniff, same-origin framing only, a strict referrer policy and no camera, microphone or location', async () => {
    expect(typeof nextConfig.headers).toBe('function');
    const rules = await nextConfig.headers();
    const all = rules.find((r) => r.source === '/:path*');
    expect(all).toBeDefined();
    const h = Object.fromEntries(all.headers.map(({ key, value }) => [key.toLowerCase(), value]));
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('SAMEORIGIN');
    // no content-security policy: it could not be checked here that every page still loads under one
    expect(h['content-security-policy']).toBeUndefined();
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(h['permissions-policy']).toMatch(/camera=\(\)/);
    expect(h['permissions-policy']).toMatch(/microphone=\(\)/);
    expect(h['permissions-policy']).toMatch(/geolocation=\(\)/);
  });

  test('the settings the site already had are kept', () => {
    expect(nextConfig.reactStrictMode).toBe(true);
    expect(nextConfig.env).toHaveProperty('NEXT_PUBLIC_DEBUG_MODE');
  });
});
