/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  images: { unoptimized: true },
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
