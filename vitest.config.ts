import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/live/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
    testTimeout: 10_000,
  },
});
