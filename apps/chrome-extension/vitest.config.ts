import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // jsdom required by Plan 05-02 LinkedIn content-script tests (MutationObserver,
    // document.body, location.href). Plan 05-00 scaffold defaulted to node;
    // jsdom adds ~30 ms cold-start which is fine for this small suite.
    environment: 'jsdom',
  },
});
