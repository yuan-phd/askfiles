import { defineConfig } from 'vitest/config';

// Integration tests check RUN_INTEGRATION themselves and skip with a printed reason.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.{ts,mjs,js}'],
    passWithNoTests: true,
    testTimeout: 600_000,
  },
});
