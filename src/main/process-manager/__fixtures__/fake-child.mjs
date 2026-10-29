// Stand-in for ollama, collector, migrate and server in unit tests. Behaviour comes from arguments:
//   --name <n>              label used in the record file
//   --port-env <VAR>        listen on the port in this variable ("port" or "host:port"), answer 200 to every path
//   --healthy-after <ms>    delay before listening
//   --never-healthy         never listen
//   --crash-after <ms>      exit with code 1 after this delay
//   --crash-once <file>     with --crash-after, crash only on the run that creates this marker file
//   --exit-after <ms>       exit with --exit-code (default 0) after this delay, for one-shot steps
//   --ignore-sigterm        keep running on SIGTERM
//   --grandchild            spawn a child that ignores SIGTERM, to test process group cleanup
//   --print-lines <n>       print n numbered lines to stdout at start
//   --record <file>         append one JSON line per event
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";

const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(k);
  return i === -1 ? undefined : args[i + 1];
};
const flag = (k) => args.includes(k);
const name = opt("--name") ?? "fake";
const recordFile = opt("--record");
const record = (event, extra = {}) => {
  if (recordFile) fs.appendFileSync(recordFile, JSON.stringify({ name, event, pid: process.pid, t: Date.now(), ...extra }) + "\n");
};

record("start", { env: { STORAGE_DIR: process.env.STORAGE_DIR, JWT_SECRET: process.env.JWT_SECRET } });

const lines = Number(opt("--print-lines") ?? 0);
for (let i = 1; i <= lines; i++) console.log(`${name} line ${i}`);

if (flag("--ignore-sigterm")) process.on("SIGTERM", () => console.log(`${name} ignoring SIGTERM`));
else process.on("SIGTERM", () => process.exit(0));

if (flag("--grandchild")) {
  const g = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  record("grandchild", { grandchild: g.pid });
}

const portEnv = opt("--port-env");
if (portEnv && !flag("--never-healthy")) {
  const raw = process.env[portEnv] ?? "";
  const [host, port] = raw.includes(":") ? [raw.slice(0, raw.lastIndexOf(":")), raw.slice(raw.lastIndexOf(":") + 1)] : ["127.0.0.1", raw];
  setTimeout(() => {
    http.createServer((_, res) => res.end("ok")).listen(Number(port), host, () => record("listening", { port: Number(port) }));
  }, Number(opt("--healthy-after") ?? 0));
}

// With --crash-once <marker>, only the first run (the one that creates the marker) crashes.
const marker = opt("--crash-once");
const firstRun = marker ? !fs.existsSync(marker) : true;
if (marker && firstRun) fs.writeFileSync(marker, "");
const crash = opt("--crash-after");
if (crash && firstRun) setTimeout(() => process.exit(1), Number(crash));

const exitAfter = opt("--exit-after");
if (exitAfter) setTimeout(() => process.exit(Number(opt("--exit-code") ?? 0)), Number(exitAfter));

setInterval(() => {}, 1000);
