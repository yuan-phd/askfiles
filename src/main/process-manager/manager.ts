import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import {
  resolveConfig,
  type ProcessManagerConfig,
  type ProcessName,
  type ProcessState,
  type ResolvedConfig,
  type StepName,
} from "./config.js";
import { ensureServerEnvFile, readEnvFile } from "./env-file.js";
import { waitForHealthy } from "./health.js";
import { RotatingLog } from "./log.js";
import { allocatePorts } from "./ports.js";

const HEALTH_PATH: Record<ProcessName, string> = {
  ollama: "/api/tags",
  // The collector has no health route; /accepts is a plain GET that only answers once routes are mounted.
  collector: "/accepts",
  server: "/api/ping",
};
const STOP_ORDER: ProcessName[] = ["server", "collector", "ollama"];

export type Phase = "stopped" | "starting" | "running" | "stopping";
export type Ports = Record<ProcessName, number>;

export interface StateEvent {
  process: ProcessName;
  state: ProcessState;
  /** ISO timestamp. */
  at: string;
  pid?: number;
  port?: number;
  detail?: string;
  attempt?: number;
  delayMs?: number;
}

export interface ProcessStatus {
  state: ProcessState;
  pid: number | null;
  port: number | null;
  since: string;
  restarts: number;
}

export interface ManagerStatus {
  phase: Phase;
  ports: Ports | null;
  processes: Record<ProcessName, ProcessStatus>;
}

export class StartError extends Error {
  readonly step: StepName | "ports";
  readonly reason: string;
  readonly logTail: string[];

  constructor(step: StepName | "ports", reason: string, logTail: string[]) {
    super(
      `${step}: ${reason}` +
        (logTail.length ? `\n--- last ${logTail.length} log lines of ${step} ---\n${logTail.join("\n")}` : ""),
    );
    this.name = "StartError";
    this.step = step;
    this.reason = reason;
    this.logTail = logTail;
  }
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

interface Run {
  child: ChildProcess | null;
  pid: number | null;
  exited: Promise<ExitInfo>;
  done: boolean;
  /** Set when the manager asked the process to stop, so its exit is not a crash. */
  expected: boolean;
}

interface Slot {
  name: ProcessName;
  state: ProcessState;
  since: string;
  run: Run | null;
  restartTimes: number[];
  restarts: number;
  timer: NodeJS.Timeout | null;
}

export interface ProcessManager {
  on(event: "state", listener: (e: StateEvent) => void): this;
  once(event: "state", listener: (e: StateEvent) => void): this;
  off(event: "state", listener: (e: StateEvent) => void): this;
}

export class ProcessManager extends EventEmitter {
  private readonly cfg: ResolvedConfig;
  private phase: Phase = "stopped";
  private ports: Ports | null = null;
  private fileEnv: Record<string, string> = {};
  private readonly slots: Record<ProcessName, Slot>;
  private migrateRun: Run | null = null;
  private readonly logs = new Map<string, RotatingLog>();
  private stopping: Promise<void> | null = null;
  private parentHandlers: { onExit: () => void; signals: [NodeJS.Signals, () => void][] } | null = null;

  constructor(config: ProcessManagerConfig) {
    super();
    this.cfg = resolveConfig(config);
    const now = new Date().toISOString();
    const slot = (name: ProcessName): Slot => ({
      name,
      state: "stopped",
      since: now,
      run: null,
      restartTimes: [],
      restarts: 0,
      timer: null,
    });
    this.slots = { ollama: slot("ollama"), collector: slot("collector"), server: slot("server") };
  }

  status(): ManagerStatus {
    const processes = {} as Record<ProcessName, ProcessStatus>;
    for (const s of Object.values(this.slots)) {
      processes[s.name] = {
        state: s.state,
        pid: s.run && !s.run.done ? s.run.pid : null,
        port: this.ports?.[s.name] ?? null,
        since: s.since,
        restarts: s.restarts,
      };
    }
    return { phase: this.phase, ports: this.ports ? { ...this.ports } : null, processes };
  }

  /** Starts Ollama, collector, migrations and server in order. Rejects with StartError. */
  async start(): Promise<ManagerStatus> {
    if (this.phase !== "stopped") throw new Error(`start() called while ${this.phase}`);
    this.phase = "starting";
    this.installParentHandlers();
    this.mlog("starting");
    try {
      let ollama: number, collector: number, server: number;
      try {
        [ollama, collector, server] = (await allocatePorts(3, this.cfg.host)) as [number, number, number];
      } catch (e) {
        throw new StartError("ports", (e as Error).message, []);
      }
      this.ports = { ollama, collector, server };
      this.mlog(`ports ollama=${ollama} collector=${collector} server=${server}`);

      const created = ensureServerEnvFile(this.cfg.envFile, { serverPort: server, collectorPort: collector });
      this.mlog(`${created ? "wrote" : "kept existing"} ${this.cfg.envFile}`);
      this.fileEnv = readEnvFile(this.cfg.envFile);

      await this.startStep("ollama");
      await this.startStep("collector");
      await this.runMigrate();
      await this.startStep("server");
      this.phase = "running";
      this.mlog("running");
      return this.status();
    } catch (e) {
      this.mlog(`start failed: ${(e as Error).message.split("\n")[0]}`);
      await this.stop();
      throw e;
    }
  }

  /** Stops server, collector and Ollama in that order: term signal, then kill signal after stopTimeoutMs. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.phase === "stopped") return Promise.resolve();
    this.stopping = this.doStop().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    this.phase = "stopping";
    this.mlog("stopping");
    for (const s of Object.values(this.slots)) {
      if (s.timer) clearTimeout(s.timer);
      s.timer = null;
    }
    if (this.migrateRun) await this.stopRun("migrate", this.migrateRun);
    this.migrateRun = null;
    for (const name of STOP_ORDER) {
      const slot = this.slots[name];
      if (slot.run) await this.stopRun(name, slot.run);
      slot.run = null;
      if (slot.state !== "stopped") this.setState(slot, "stopped");
    }
    this.removeParentHandlers();
    this.ports = null;
    this.phase = "stopped";
    this.mlog("stopped");
    for (const l of this.logs.values()) l.close();
  }

  private async startStep(name: ProcessName): Promise<void> {
    if (this.phase !== "starting") throw new StartError(name, "stopped during start", []);
    const slot = this.slots[name];
    slot.restartTimes = [];
    slot.restarts = 0;
    const run = this.spawnProcess(name);
    slot.run = run;
    this.setState(slot, "starting");
    this.watchExit(slot, run);
    const timeoutMs = this.cfg.timeoutsMs[name];
    const r = await waitForHealthy(this.healthUrl(name), {
      timeoutMs,
      intervalMs: this.cfg.healthIntervalMs,
      exited: run.exited,
    });
    if (this.phase !== "starting") throw new StartError(name, "stopped during start", this.log(name).tail());
    if (r === "healthy") {
      this.setState(slot, "healthy");
      return;
    }
    const reason =
      r === "timeout"
        ? `not healthy within ${timeoutMs} ms at ${this.healthUrl(name)}`
        : `exited before healthy (${describeExit(await run.exited)})`;
    throw new StartError(name, reason, this.log(name).tail());
  }

  // A method, not an inline comparison, because phase changes across awaits and TypeScript
  // would otherwise narrow it as if it could not.
  private isStopping(): boolean {
    return this.phase === "stopping" || this.phase === "stopped";
  }

  private async runMigrate(): Promise<void> {
    if (this.phase !== "starting") throw new StartError("migrate", "stopped during start", []);
    this.mlog("migrate starting");
    const run = this.spawnProcess("migrate");
    this.migrateRun = run;
    const timeoutMs = this.cfg.timeoutsMs.migrate;
    const r = await raceTimeout(run.exited, timeoutMs);
    if (r === "timeout") {
      await this.stopRun("migrate", run);
      this.migrateRun = null;
      throw new StartError("migrate", `did not finish within ${timeoutMs} ms`, this.log("migrate").tail());
    }
    this.migrateRun = null;
    if (this.phase !== "starting") throw new StartError("migrate", "stopped during start", this.log("migrate").tail());
    if (r.code !== 0) {
      throw new StartError("migrate", `failed (${describeExit(r)})`, this.log("migrate").tail());
    }
    this.mlog("migrate done");
  }

  private watchExit(slot: Slot, run: Run): void {
    void run.exited.then((ex) => {
      if (slot.run !== run || run.expected) return;
      this.mlog(`${slot.name} exited (${describeExit(ex)})`);
      // During start or a restart attempt the waiting code reports the exit itself.
      if (this.isStopping() || slot.state !== "healthy") return;
      this.setState(slot, "crashed", describeExit(ex));
      this.scheduleRestart(slot);
    });
  }

  private scheduleRestart(slot: Slot): void {
    const { delaysMs, maxAttempts, windowMs } = this.cfg.restart;
    const now = Date.now();
    slot.restartTimes = slot.restartTimes.filter((t) => now - t < windowMs);
    if (slot.restartTimes.length >= maxAttempts) {
      this.setState(slot, "failed", `${maxAttempts} restarts within ${windowMs} ms, giving up`);
      return;
    }
    const attempt = slot.restartTimes.length + 1;
    const delayMs = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)]!;
    slot.restartTimes.push(now);
    slot.restarts++;
    this.setState(slot, "restarting", `attempt ${attempt} in ${delayMs} ms`, { attempt, delayMs });
    slot.timer = setTimeout(() => {
      slot.timer = null;
      void this.restart(slot);
    }, delayMs);
  }

  private async restart(slot: Slot): Promise<void> {
    if (this.isStopping()) return;
    const run = this.spawnProcess(slot.name);
    slot.run = run;
    this.watchExit(slot, run);
    const timeoutMs = this.cfg.timeoutsMs[slot.name];
    const r = await waitForHealthy(this.healthUrl(slot.name), {
      timeoutMs,
      intervalMs: this.cfg.healthIntervalMs,
      exited: run.exited,
    });
    if (this.isStopping() || slot.run !== run) return;
    if (r === "healthy") {
      this.setState(slot, "healthy", `restart ${slot.restarts}`);
      return;
    }
    if (r === "timeout") await this.stopRun(slot.name, run);
    if (this.isStopping()) return;
    const detail =
      r === "timeout" ? `not healthy within ${timeoutMs} ms` : `exited before healthy (${describeExit(await run.exited)})`;
    this.setState(slot, "crashed", detail);
    this.scheduleRestart(slot);
  }

  private spawnProcess(name: StepName): Run {
    const spec = this.cfg.specs[name];
    const log = this.log(name);
    this.mlog(`spawn ${name}: ${spec.command} ${spec.args.join(" ")} (cwd ${spec.cwd})`);
    let child: ChildProcess;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: this.envFor(name),
        stdio: ["ignore", "pipe", "pipe"],
        detached: this.cfg.killProcessGroup,
      });
    } catch (e) {
      const error = (e as Error).message;
      log.line(`[process-manager] spawn failed: ${error}`);
      return { child: null, pid: null, done: true, expected: false, exited: Promise.resolve({ code: null, signal: null, error }) };
    }
    const run: Run = {
      child,
      pid: child.pid ?? null,
      done: false,
      expected: false,
      exited: new Promise<ExitInfo>((resolve) => {
        child.once("exit", (code, signal) => {
          run.done = true;
          resolve({ code, signal });
        });
        child.once("error", (err) => {
          log.line(`[process-manager] ${err.message}`);
          // Without a pid the process never started and no exit event follows.
          if (child.pid === undefined) {
            run.done = true;
            resolve({ code: null, signal: null, error: err.message });
          }
        });
      }),
    };
    child.stdout?.on("data", (d: Buffer) => log.write(d));
    child.stderr?.on("data", (d: Buffer) => log.write(d));
    return run;
  }

  private async stopRun(name: StepName, run: Run): Promise<void> {
    run.expected = true;
    const { term, kill } = this.cfg.signals;
    if (!run.done) {
      this.signal(run, term);
      if ((await raceTimeout(run.exited, this.cfg.stopTimeoutMs)) === "timeout") {
        this.mlog(`${name} still running ${this.cfg.stopTimeoutMs} ms after ${term}, sending ${kill}`);
        this.signal(run, kill);
        if ((await raceTimeout(run.exited, 5000)) === "timeout") this.mlog(`${name} did not exit after ${kill}`);
      }
    }
    // The leader is gone; anything left in its group (for example an ollama runner) goes too.
    if (this.cfg.killProcessGroup) this.signal(run, kill);
  }

  private signal(run: Run, sig: NodeJS.Signals): void {
    if (run.pid === null) return;
    try {
      if (this.cfg.killProcessGroup) process.kill(-run.pid, sig);
      else if (!run.done) run.child?.kill(sig);
    } catch {
      // Already gone.
    }
  }

  private envFor(name: StepName): NodeJS.ProcessEnv {
    const { host, storageDir, baseEnv } = this.cfg;
    const p = this.ports!;
    const noProxy = mergeNoProxy(baseEnv.NO_PROXY ?? baseEnv.no_proxy);
    // Loopback traffic between the children must never be sent to a proxy.
    const common = { ...baseEnv, NO_PROXY: noProxy, no_proxy: noProxy };
    const spec = this.cfg.specs[name];
    if (name === "ollama") return { ...common, ...spec.env, OLLAMA_HOST: `${urlHost(host)}:${p.ollama}` };
    return {
      ...common,
      ...this.fileEnv,
      ...spec.env,
      NODE_ENV: "production",
      STORAGE_DIR: storageDir,
      SERVER_PORT: String(p.server),
      COLLECTOR_PORT: String(p.collector),
      ANYTHING_LLM_BIND_HOST: host,
      OLLAMA_BASE_PATH: `http://${urlHost(host)}:${p.ollama}`,
      DISABLE_TELEMETRY: "true",
      CHECKPOINT_DISABLE: "1",
    };
  }

  private healthUrl(name: ProcessName): string {
    return `http://${urlHost(this.cfg.host)}:${this.ports![name]}${HEALTH_PATH[name]}`;
  }

  private setState(slot: Slot, state: ProcessState, detail?: string, extra?: { attempt: number; delayMs: number }): void {
    slot.state = state;
    slot.since = new Date().toISOString();
    const port = this.ports?.[slot.name];
    const pid = slot.run && !slot.run.done && slot.run.pid !== null ? slot.run.pid : undefined;
    this.mlog(`${slot.name} ${state}${port && state === "healthy" ? ` on ${port}` : ""}${detail ? ` (${detail})` : ""}`);
    const ev: StateEvent = { process: slot.name, state, at: slot.since, pid, port, detail, ...extra };
    this.emit("state", ev);
  }

  private log(name: StepName | "manager"): RotatingLog {
    let l = this.logs.get(name);
    if (!l) {
      l = new RotatingLog(path.join(this.cfg.logDir, `${name}.log`), this.cfg.logMaxBytes);
      this.logs.set(name, l);
    }
    return l;
  }

  private mlog(msg: string): void {
    this.log("manager").line(`[process-manager] ${msg}`);
  }

  private installParentHandlers(): void {
    if (!this.cfg.handleParentSignals || this.parentHandlers) return;
    // An exit handler cannot wait, so it only sends the kill signal.
    const onExit = () => this.killAllNow();
    const signals = this.cfg.parentSignals.map((sig): [NodeJS.Signals, () => void] => {
      const h = () => {
        this.mlog(`parent received ${sig}, stopping children`);
        void this.stop().finally(() => {
          this.removeParentHandlers();
          // Re-raise so the parent ends the way it would have without this handler.
          process.kill(process.pid, sig);
        });
      };
      process.on(sig, h);
      return [sig, h];
    });
    process.on("exit", onExit);
    this.parentHandlers = { onExit, signals };
  }

  private removeParentHandlers(): void {
    if (!this.parentHandlers) return;
    process.off("exit", this.parentHandlers.onExit);
    for (const [sig, h] of this.parentHandlers.signals) process.off(sig, h);
    this.parentHandlers = null;
  }

  private killAllNow(): void {
    const runs = [this.migrateRun, ...Object.values(this.slots).map((s) => s.run)];
    for (const run of runs) {
      if (!run) continue;
      run.expected = true;
      this.signal(run, this.cfg.signals.kill);
    }
  }
}

function describeExit(ex: ExitInfo): string {
  if (ex.error) return ex.error;
  return ex.signal ? `signal ${ex.signal}` : `code ${ex.code}`;
}

function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function mergeNoProxy(existing: string | undefined): string {
  const items = (existing ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const h of ["127.0.0.1", "localhost", "::1"]) if (!items.includes(h)) items.push(h);
  return items.join(",");
}

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}
