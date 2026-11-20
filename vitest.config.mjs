import { defineConfig } from 'vitest/config';

// upstream/ carries its own jest tests, and upstream-build/ holds copies of them; never collect them here.
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,mjs,js}', 'scripts/**/*.test.{ts,mjs,js}', 'test/**/*.test.{ts,mjs,js}'],
    exclude: ['**/node_modules/**', 'upstream/**', 'upstream-build/**', 'test/integration/**'],
    // The process manager tests spawn real child processes; a few take several seconds.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
