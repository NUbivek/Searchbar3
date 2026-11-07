/** @type {import('next').NextConfig} */
const isStaticExport = process.env.STATIC_EXPORT === '1';

const nextConfig = {
  reactStrictMode: true,
  ...(isStaticExport ? { output: 'export' } : {}),
  images: { unoptimized: isStaticExport },
  swcMinify: false,
  env: {
    NEXT_PUBLIC_DEBUG_MODE: process.env.NEXT_PUBLIC_DEBUG_MODE || 'false',
    NEXT_PUBLIC_SHOW_METRICS: process.env.NEXT_PUBLIC_SHOW_METRICS || 'false',
  },
  webpack: (config) => {
    config.module.rules.push({
      test: /\.txt$/,
      use: 'raw-loader',
    });
    return config;
  },
};

module.exports = nextConfig;
