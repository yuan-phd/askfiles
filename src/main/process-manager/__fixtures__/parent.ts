// Parent process for the parent-signal tests: starts a manager with fake children, prints the
// child pids as one JSON line, then waits to be signalled. With --exit it calls process.exit.
// With --windows it uses the Windows stop path (fake taskkill) and Ollama starts a grandchild.
import { ProcessManager } from '../manager.js';
import { fake, fakeConfig, fakeWindowsConfig } from './helpers.js';

const dir = process.argv[2]!;
const windows = process.argv.includes('--windows');
const m = new ProcessManager(
  (windows ? fakeWindowsConfig : fakeConfig)(dir, {
    handleParentSignals: true,
    // The server ignores SIGTERM so the test also covers the kill signal on the parent's path.
    server: fake(dir, 'server', '--port-env', 'SERVER_PORT', '--ignore-sigterm'),
    ...(windows ? { ollama: fake(dir, 'ollama', '--port-env', 'OLLAMA_HOST', '--grandchild') } : {}),
  }),
);
const s = await m.start();
console.log(JSON.stringify(Object.values(s.processes).map((p) => p.pid)));
if (process.argv.includes('--exit')) process.exit(0);
setInterval(() => {}, 1000);
