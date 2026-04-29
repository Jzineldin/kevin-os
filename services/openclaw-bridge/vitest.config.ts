import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        // Ensure each fork inherits parent's full process.env (including AWS_*)
        isolate: false,
      },
    },
    // Longer timeout for live integration tests
    testTimeout: 30_000,
  },
});
