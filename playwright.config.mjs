import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  globalSetup: "./test/e2e/global-setup.mjs",
  // One worker: the real-model test shares one CPU-bound Ollama with nothing else.
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1200, height: 860 },
    trace: "retain-on-failure",
  },
});
