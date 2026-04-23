import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@kos/db', '@kos/contracts'],
  experimental: {
    typedRoutes: true,
  },
};

export default config;
