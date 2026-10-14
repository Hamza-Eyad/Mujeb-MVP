import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Live tests call paid provider APIs. They only run through `npm run test:live`
// and read keys from `.env` (never from tracked files).
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
