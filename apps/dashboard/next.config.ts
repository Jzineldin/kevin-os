import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@kos/db', '@kos/contracts'],
  // Next 15.5 promoted `typedRoutes` to a top-level stable key.
  typedRoutes: true,
};

export default config;
