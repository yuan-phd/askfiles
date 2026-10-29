import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessManager, StartError, type StateEvent } from "./manager.js";
import { fake, fakeConfig, isAlive, readRecord, tmpDir, waitFor } from "./__fixtures__/helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const managers: ProcessManager[] = [];

function manager(cfg: ConstructorParameters<typeof ProcessManager>[0]): { m: ProcessManager; events: StateEvent[] } {
  const m = new ProcessManager(cfg);
  const events: StateEvent[] = [];
  m.on("state", (e) => events.push(e));
  managers.push(m);
  return { m, events };
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stop()));
});

describe("ProcessManager start", () => {
  it("starts ollama, collector, migrate and server in order, each after the previous is healthy", async () => {
    const dir = tmpDir();
    const { m, events } = manager(
      fakeConfig(dir, {
        ollama: fake(dir, "ollama", "--port-env", "OLLAMA_HOST", "--healthy-after", "150"),
        collector: fake(dir, "collector", "--port-env", "COLLECTOR_PORT", "--healthy-after", "150"),
        migrate: fake(dir, "migrate", "--exit-after", "100"),
        server: fake(dir, "server", "--port-env", "SERVER_PORT", "--healthy-after", "150"),
      }),
    );
    const status = await m.start();

    expect(events.map((e) => `${e.process}:${e.state}`)).toEqual([
      "ollama:starting",
      "ollama:healthy",
      "collector:starting",
      "collector:healthy",
      "server:starting",
      "server:healthy",
    ]);
    const at = (p: string, s: string) => Date.parse(events.find((e) => e.process === p && e.state === s)!.at);
    const rec = readRecord(dir).filter((r) => r.event === "start");
    const started = (n: string) => rec.find((r) => r.name === n)!.t;
    expect(started("collector")).toBeGreaterThanOrEqual(at("ollama", "healthy"));
    expect(started("migrate")).toBeGreaterThanOrEqual(at("collector", "healthy"));
    // migrate exits 100 ms after it starts; the server must not start before that.
    expect(started("server")).toBeGreaterThanOrEqual(started("migrate") + 100);

    expect(status.phase).toBe("running");
    const ports = Object.values(status.ports!);
    expect(new Set(ports).size).toBe(3);
    for (const p of ports) expect([3001, 8888, 11434]).not.toContain(p);
    expect(Object.values(status.processes).every((p) => p.state === "healthy" && p.pid)).toBe(true);
  });

  it("passes storage dir and the .env secrets to the server", async () => {
    const dir = tmpDir();
    const { m } = manager(fakeConfig(dir));
    await m.start();
    const env = readRecord(dir).find((r) => r.name === "server" && r.event === "start")!.env!;
    expect(env.STORAGE_DIR).toBe(path.join(dir, "data", "storage"));
    const file = fs.readFileSync(path.join(dir, "data", "server", ".env"), "utf8");
    expect(file).toContain(`JWT_SECRET="${env.JWT_SECRET}"`);
  });

  it("aborts with the step name and the last 50 log lines when a health check times out", async () => {
    const dir = tmpDir();
    const { m } = manager(
      fakeConfig(dir, {
        collector: fake(dir, "collector", "--never-healthy", "--print-lines", "80"),
        timeoutsMs: { collector: 400 },
      }),
    );
    const err = (await m.start().catch((e) => e)) as StartError;
    expect(err).toBeInstanceOf(StartError);
    expect(err.step).toBe("collector");
    expect(err.message).toMatch(/^collector: not healthy within 400 ms/);
    expect(err.logTail).toHaveLength(50);
    expect(err.logTail.at(-1)).toBe("collector line 80");
    expect(err.logTail[0]).toBe("collector line 31");

    const rec = readRecord(dir);
    expect(rec.some((r) => r.name === "server")).toBe(false);
    for (const r of rec.filter((r) => r.event === "start")) expect(isAlive(r.pid)).toBe(false);
    expect(m.status().phase).toBe("stopped");
  });

  it("aborts at once when a child exits before it is healthy", async () => {
    const dir = tmpDir();
    const { m } = manager(
      fakeConfig(dir, {
        ollama: fake(dir, "ollama", "--never-healthy", "--crash-after", "50"),
        timeoutsMs: { ollama: 10_000 },
      }),
    );
    const t0 = Date.now();
    const err = (await m.start().catch((e) => e)) as StartError;
    expect(err.step).toBe("ollama");
    expect(err.reason).toBe("exited before healthy (code 1)");
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("aborts when migrate fails and never starts the server", async () => {
    const dir = tmpDir();
    const { m } = manager(fakeConfig(dir, { migrate: fake(dir, "migrate", "--exit-after", "10", "--exit-code", "3") }));
    const err = (await m.start().catch((e) => e)) as StartError;
    expect(err.step).toBe("migrate");
    expect(err.reason).toBe("failed (code 3)");
    expect(readRecord(dir).some((r) => r.name === "server")).toBe(false);
  });

  it("aborts when a child binary does not exist", async () => {
    const dir = tmpDir();
    const { m } = manager(fakeConfig(dir, { ollama: { command: path.join(dir, "missing"), args: [], cwd: dir } }));
    const err = (await m.start().catch((e) => e)) as StartError;
    expect(err.step).toBe("ollama");
    expect(err.reason).toMatch(/ENOENT/);
  });

  it("refuses a second start while running", async () => {
    const dir = tmpDir();
    const { m } = manager(fakeConfig(dir));
    await m.start();
    await expect(m.start()).rejects.toThrow(/while running/);
  });
});

describe("ProcessManager stop", () => {
  it("sends SIGKILL when a child ignores SIGTERM for stopTimeoutMs", async () => {
    const dir = tmpDir();
    const { m } = manager(
      fakeConfig(dir, {
        server: fake(dir, "server", "--port-env", "SERVER_PORT", "--ignore-sigterm"),
        stopTimeoutMs: 300,
      }),
    );
    const s = await m.start();
    const pids = Object.values(s.processes).map((p) => p.pid!);
    const t0 = Date.now();
    await m.stop();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    for (const pid of pids) expect(isAlive(pid)).toBe(false);
    const mlog = fs.readFileSync(path.join(dir, "logs", "manager.log"), "utf8");
    expect(mlog).toContain("server still running 300 ms after SIGTERM, sending SIGKILL");
    expect(fs.readFileSync(path.join(dir, "logs", "server.log"), "utf8")).toContain("server ignoring SIGTERM");
    expect(Object.values(m.status().processes).every((p) => p.state === "stopped")).toBe(true);
  });

  it("kills the whole process group, including a grandchild that ignores SIGTERM", async () => {
    const dir = tmpDir();
    const { m } = manager(fakeConfig(dir, { ollama: fake(dir, "ollama", "--port-env", "OLLAMA_HOST", "--grandchild") }));
    await m.start();
    const g = readRecord(dir).find((r) => r.event === "grandchild")!.grandchild!;
    expect(isAlive(g)).toBe(true);
    await m.stop();
    await waitFor(() => !isAlive(g), 2000, "grandchild to die");
  });

  it("stops in reverse order", async () => {
    const dir = tmpDir();
    const { m, events } = manager(fakeConfig(dir));
    await m.start();
    events.length = 0;
    await m.stop();
    expect(events.map((e) => `${e.process}:${e.state}`)).toEqual([
      "server:stopped",
      "collector:stopped",
      "ollama:stopped",
    ]);
  });
});

describe("ProcessManager crash handling", () => {
  it("restarts with exponential backoff and gives up after 5 attempts in the window", async () => {
    const dir = tmpDir();
    const { m, events } = manager(
      fakeConfig(dir, { server: fake(dir, "server", "--port-env", "SERVER_PORT", "--crash-after", "150") }),
    );
    await m.start();
    await waitFor(() => events.some((e) => e.process === "server" && e.state === "failed"), 15_000, "failed");
    const server = events.filter((e) => e.process === "server");
    const restarting = server.filter((e) => e.state === "restarting");
    expect(restarting.map((e) => e.delayMs)).toEqual([20, 40, 80, 160, 320]);
    expect(restarting.map((e) => e.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(server.filter((e) => e.state === "crashed")).toHaveLength(6);
    expect(server.at(-1)!.state).toBe("failed");
    expect(server.at(-1)!.detail).toBe("5 restarts within 60000 ms, giving up");
    // Nothing is scheduled after the terminal failure.
    await new Promise((r) => setTimeout(r, 800));
    expect(events.filter((e) => e.process === "server").at(-1)!.state).toBe("failed");
    expect(m.status().processes.server.restarts).toBe(5);
  });

  it("counts only restarts inside the window", async () => {
    const dir = tmpDir();
    const { m, events } = manager(
      fakeConfig(dir, {
        server: fake(dir, "server", "--port-env", "SERVER_PORT", "--crash-after", "200"),
        restart: { delaysMs: [20, 40, 80, 160, 320], maxAttempts: 5, windowMs: 150 },
      }),
    );
    await m.start();
    await waitFor(() => events.filter((e) => e.state === "restarting").length >= 4, 15_000, "4 restarts");
    expect(events.filter((e) => e.state === "restarting").every((e) => e.attempt === 1)).toBe(true);
    expect(events.some((e) => e.state === "failed")).toBe(false);
  });

  it("brings a crashed child back to healthy on the same port", async () => {
    const dir = tmpDir();
    const { m, events } = manager(
      fakeConfig(dir, {
        collector: fake(
          dir,
          "collector",
          "--port-env",
          "COLLECTOR_PORT",
          "--crash-after",
          "100",
          "--crash-once",
          path.join(dir, "marker"),
        ),
      }),
    );
    // The crash can land before start() returns; the crash is handled the same either way.
    await m.start();
    const healthy = () => events.filter((e) => e.process === "collector" && e.state === "healthy");
    await waitFor(() => healthy().length === 2, 5000, "recovery");
    expect(events.filter((e) => e.process === "collector").map((e) => e.state)).toEqual([
      "starting",
      "healthy",
      "crashed",
      "restarting",
      "healthy",
    ]);
    const [first, second] = healthy();
    expect(second!.port).toBe(first!.port);
    expect(second!.pid).not.toBe(first!.pid);
    expect(m.status().processes.collector).toMatchObject({ state: "healthy", pid: second!.pid, restarts: 1 });
  });
});

describe("ProcessManager .env", () => {
  it("writes <dataDir>/server/.env on first start only", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "data", "server", ".env");
    const { m } = manager(fakeConfig(dir));
    await m.start();
    const first = fs.readFileSync(file, "utf8");
    await m.stop();
    await m.start();
    await m.stop();
    expect(fs.readFileSync(file, "utf8")).toBe(first);
    expect(fs.readFileSync(path.join(dir, "logs", "manager.log"), "utf8")).toContain(`kept existing ${file}`);
  });
});

describe("parent process handling", () => {
  for (const how of ["SIGTERM", "SIGINT", "exit"] as const) {
    it(`leaves no child behind when the parent gets ${how}`, async () => {
      const dir = tmpDir();
      const parent = spawn(
        process.execPath,
        [path.join(here, "__fixtures__", "parent.ts"), dir, ...(how === "exit" ? ["--exit"] : [])],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      parent.stdout.on("data", (d) => (out += d));
      parent.stderr.on("data", (d) => (err += d));
      const exited = new Promise<[number | null, NodeJS.Signals | null]>((r) => parent.on("exit", (c, s) => r([c, s])));
      await waitFor(() => out.includes("\n") || parent.exitCode !== null, 15_000, `parent output (stderr: ${err})`);
      const pids = JSON.parse(out.split("\n")[0]!) as number[];
      expect(pids).toHaveLength(3);
      const recorded = readRecord(dir).filter((r) => r.event === "start").map((r) => r.pid);
      if (how !== "exit") parent.kill(how);
      const [code, signal] = await exited;
      if (how === "exit") expect(code).toBe(0);
      else expect(signal).toBe(how);
      for (const pid of [...pids, ...recorded]) await waitFor(() => !isAlive(pid), 2000, `pid ${pid} to die`);
    });
  }
});

describe("platform independence", () => {
  it("has no reference to process.platform", () => {
    const files = fs.readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(4);
    for (const f of files) expect(fs.readFileSync(path.join(here, f), "utf8")).not.toContain("process.platform");
  });
});
