import { defineConfig } from 'vitest/config';

// upstream/ carries its own jest tests; never collect them here.
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,mjs,js}', 'scripts/**/*.test.{ts,mjs,js}', 'test/**/*.test.{ts,mjs,js}'],
    exclude: ['**/node_modules/**', 'upstream/**', 'test/integration/**'],
  },
});
