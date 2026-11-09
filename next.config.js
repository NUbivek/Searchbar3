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
};

module.exports = nextConfig;
