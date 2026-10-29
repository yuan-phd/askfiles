// Parent process for the parent-signal tests: starts a manager with fake children, prints the
// child pids as one JSON line, then waits to be signalled. With --exit it calls process.exit.
import { ProcessManager } from "../manager.js";
import { fake, fakeConfig } from "./helpers.js";

const dir = process.argv[2]!;
const m = new ProcessManager(
  fakeConfig(dir, {
    handleParentSignals: true,
    // The server ignores SIGTERM so the test also covers the kill signal on the parent's path.
    server: fake(dir, "server", "--port-env", "SERVER_PORT", "--ignore-sigterm"),
  }),
);
const s = await m.start();
console.log(JSON.stringify(Object.values(s.processes).map((p) => p.pid)));
if (process.argv.includes("--exit")) process.exit(0);
setInterval(() => {}, 1000);
