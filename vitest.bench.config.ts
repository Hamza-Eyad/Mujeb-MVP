import { defineConfig } from 'vitest/config';

// The barge-in bench prints its results; it runs only through `npm run bench:barge-in`.
export default defineConfig({
  test: {
    include: ['tests/bench/**/*.bench.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
