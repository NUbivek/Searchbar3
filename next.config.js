/**
 * Headers sent with every response. Only ones that cannot break a page: no
 * content-security policy, since whether every page still loads under one has
 * not been checked.
 * - nosniff: a browser never runs a file as a different type than it was sent as.
 * - SAMEORIGIN framing: another site cannot frame these pages and trick a
 *   signed-in user into clicking (starting a check, for example).
 * - strict-origin-when-cross-origin: a linked site sees only this site's
 *   address, never the page path or the name searched in its query string.
 * - No camera, microphone or location: no page uses them.
 * HSTS is left to the host, which already sends it on its own domains.
 */
const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `NEXT_DIST_DIR=.next-build npm run build` keeps a production build out of
  // the folder a running `next dev` uses (otherwise the dev server breaks).
  distDir: process.env.NEXT_DIST_DIR || '.next',
  env: {
    NEXT_PUBLIC_DEBUG_MODE: process.env.NEXT_PUBLIC_DEBUG_MODE || 'false',
    NEXT_PUBLIC_SHOW_METRICS: process.env.NEXT_PUBLIC_SHOW_METRICS || 'false',
  },
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
};

module.exports = nextConfig;
