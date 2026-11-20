import { defineConfig } from 'vitest/config';

// Integration tests check RUN_INTEGRATION themselves and skip with a printed reason.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.{ts,mjs,js}'],
    passWithNoTests: true,
    // Builds upstream-build/run once, and fails the run if upstream/ changed (scripts/lib/upstream-copy.mjs).
    globalSetup: ['test/integration/global-setup.mts'],
    // All files share one CPU-bound Ollama, so they run one after another.
    fileParallelism: false,
    testTimeout: 600_000,
  },
});
