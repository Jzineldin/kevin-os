import path from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/unit/setup.ts'],
    include: [
      'tests/unit/**/*.test.{ts,tsx}',
      'tests/integration/**/*.test.{ts,tsx}',
      // Phase 11-02: co-located unit tests next to mission-control primitives
      // (Pill / StatTile / ChannelHealth). Plan 11-02 acceptance criterion
      // requires the tests to live alongside their components, not in
      // tests/unit/, so vitest must discover them under src/.
      'src/**/*.test.{ts,tsx}',
    ],
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
});
