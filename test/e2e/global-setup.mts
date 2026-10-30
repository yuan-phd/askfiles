// Starts the page server. The pages talk to stubs only: the Ask page answers through the shell's
// pipeline (src/main/answer), which the bridge stub stands in for, and the real-backend checks of
// that pipeline are vitest integration tests (test/integration/answer.test.ts).
import { startStaticServer } from './static-server.mjs';

export default async function globalSetup() {
  const page = await startStaticServer();
  process.env.ASKFILES_PAGE_URL = page.url;
  return page.stop;
}
