// Boots the real Ollama, collector and server through the process manager.
// Needs RUN_INTEGRATION=1, an ollama binary on PATH (or OLLAMA_BIN) and the upstream packages
// installed (scripts/install_pkgs.sh). Prints the ss output used for the bind check.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProcessManager } from "../../src/main/process-manager/index.ts";
import { isAlive } from "../../src/main/process-manager/__fixtures__/helpers.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER = path.join(ROOT, "upstream", "server");
const COLLECTOR = path.join(ROOT, "upstream", "collector");
const PRISMA_CLI = path.join(SERVER, "node_modules", "prisma", "build", "index.js");
const PATCH = path.join(ROOT, "patches", "001-bind-localhost.patch");

function which(bin: string): string | null {
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(d, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return null;
}

const OLLAMA = process.env.OLLAMA_BIN ?? which("ollama");

function skipReason(): string | null {
  if (process.env.RUN_INTEGRATION !== "1") return "RUN_INTEGRATION is not 1";
  if (!OLLAMA) return "no ollama binary on PATH and OLLAMA_BIN is not set";
  for (const p of [path.join(SERVER, "node_modules"), path.join(COLLECTOR, "node_modules"), PRISMA_CLI]) {
    if (!fs.existsSync(p)) return `${path.relative(ROOT, p)} is missing; run scripts/install_pkgs.sh`;
  }
  return null;
}

const reason = skipReason();
// Written to stderr because vitest does not show console output from test collection.
if (reason) process.stderr.write(`[integration] process-manager skipped: ${reason}\n`);

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { agent: new http.Agent() }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

/** Every pid whose process group is one of `groups`. */
function groupMembers(groups: number[]): number[] {
  const out = execFileSync("ps", ["-eo", "pid=,pgid="], { encoding: "utf8" });
  return out
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([pid, pgid]) => pid && groups.includes(pgid!))
    .map(([pid]) => pid!);
}

interface Listener {
  local: string;
  pids: number[];
  line: string;
}

function listeners(): Listener[] {
  const out = execFileSync("ss", ["-ltnpH"], { encoding: "utf8" });
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const cols = line.trim().split(/\s+/);
      const pids = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
      return { local: cols[3]!, pids, line: line.trim() };
    });
}

describe.skipIf(reason !== null)("process manager with real ollama, collector and server", () => {
  let applied = false;
  let manager: ProcessManager | null = null;
  const gitApply = (...args: string[]) =>
    spawnSync("git", ["apply", ...args, "--directory=upstream", PATCH], { cwd: ROOT, encoding: "utf8" });

  beforeAll(() => {
    // scripts/build.sh applies patches/ before anything runs. Do the same when it has not happened.
    if (gitApply("--check", "--reverse").status === 0) {
      console.log("[integration] bind patch already applied");
      return;
    }
    const r = gitApply();
    if (r.status !== 0) throw new Error(`git apply failed: ${r.stderr}`);
    applied = true;
    console.log("[integration] applied bind patch for this run; it is reverted afterwards");
  });

  afterAll(async () => {
    await manager?.stop();
    if (applied) {
      const r = gitApply("--reverse");
      if (r.status !== 0) console.log(`[integration] could not revert the bind patch: ${r.stderr}`);
    }
  });

  it("answers /api/ping, listens on 127.0.0.1 only, and leaves no child after stop", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "askfiles-it-"));
    const m = new ProcessManager({
      dataDir: path.join(dir, "data"),
      logDir: path.join(dir, "logs"),
      ollama: { command: OLLAMA!, args: ["serve"], cwd: dir, env: { OLLAMA_MODELS: path.join(dir, "models") } },
      collector: { command: process.execPath, args: [path.join(COLLECTOR, "index.js")], cwd: COLLECTOR },
      migrate: {
        command: process.execPath,
        args: [PRISMA_CLI, "migrate", "deploy", "--schema=./prisma/schema.prisma"],
        cwd: SERVER,
      },
      server: { command: process.execPath, args: [path.join(SERVER, "index.js")], cwd: SERVER },
      signals: { term: "SIGTERM", kill: "SIGKILL" },
      killProcessGroup: true,
      handleParentSignals: false,
      timeoutsMs: { ollama: 60_000, collector: 120_000, migrate: 180_000, server: 240_000 },
    });
    manager = m;
    m.on("state", (e) =>
      console.log(`[integration] ${e.at} ${e.process} ${e.state}${e.port ? ` port ${e.port}` : ""}${e.detail ? ` (${e.detail})` : ""}`),
    );
    console.log(`[integration] logs in ${path.join(dir, "logs")}`);

    const t0 = Date.now();
    const status = await m.start();
    console.log(`[integration] running after ${Date.now() - t0} ms`);
    const ports = status.ports!;

    const ping = await get(`http://127.0.0.1:${ports.server}/api/ping`);
    console.log(`[integration] GET /api/ping -> ${ping.status} ${ping.body}`);
    expect(ping.status).toBe(200);

    const groups = Object.values(status.processes).map((p) => p.pid!);
    const members = groupMembers(groups);
    const ours = listeners().filter((l) => l.pids.some((p) => members.includes(p)));
    console.log(`[integration] ss -ltnp, sockets owned by the three process groups:\n${ours.map((l) => l.line).join("\n")}`);
    expect(ours.length).toBeGreaterThan(0);
    for (const l of ours) expect(l.local).toMatch(/^127\.0\.0\.1:\d+$/);
    const locals = ours.map((l) => l.local);
    expect(locals).toContain(`127.0.0.1:${ports.server}`);
    expect(locals).toContain(`127.0.0.1:${ports.collector}`);
    expect(locals).toContain(`127.0.0.1:${ports.ollama}`);
    // Nobody else holds the ports on another address either.
    for (const p of Object.values(ports)) {
      for (const l of listeners().filter((l) => l.local.endsWith(`:${p}`))) expect(l.local).toBe(`127.0.0.1:${p}`);
    }

    await m.stop();
    const left = members.filter(isAlive);
    console.log(`[integration] after stop: ${members.length} group members before, ${left.length} alive, ${groupMembers(groups).length} left in the groups`);
    expect(left).toEqual([]);
    expect(groupMembers(groups)).toEqual([]);
  }, 600_000);
});
