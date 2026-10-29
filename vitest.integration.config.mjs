import { defineConfig } from 'vitest/config';

// Integration tests check RUN_INTEGRATION themselves and skip with a printed reason.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.{ts,mjs,js}'],
    passWithNoTests: true,
    // Every file applies the patches to upstream/ for its run and reverts them afterwards, and all
    // share one CPU-bound Ollama, so files run one after another.
    fileParallelism: false,
    testTimeout: 600_000,
  },
});
