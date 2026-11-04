// Smoke test of the Windows installer, run by the smoke job in .github/workflows/windows.yml. The
// Windows counterpart of scripts/smoke-mac.sh, in Node because the runner's shells differ.
//   1. Installs AskFiles silently (setup.exe /S, per user, no administrator) and finds AskFiles.exe.
//   2. Launches it on a fresh %LOCALAPPDATA%\AskFiles (the model cache kept) with the smoke preset
//      (ASKFILES_PRESETS_FILE) and a folder holding the handbook PDF (ASKFILES_LIBRARY_FOLDER), which
//      the app links into All files after the first run and indexes through its own pipeline.
//   3. Waits for ports.json under %LOCALAPPDATA%\AskFiles, checks that Ollama, collector and server
//      listen on 127.0.0.1 only (so Windows Firewall never asks), waits for the first run to finish
//      and the Ask page to report ready, then checks the server API with the stored key.
//   4. Waits for the handbook to be indexed and for the one pipeline answer the app gives to
//      ASKFILES_SMOKE_QUESTION, and asserts it cites [1].
//   5. Quits the app the way closing its window does (taskkill without /F sends WM_CLOSE) and checks
//      that no process from the install folder is left, ollama.exe and its runners included.
// Usage: node scripts/smoke-windows.mjs <AskFiles-x.y.z-x64-setup.exe> <out-dir>
/* global fetch */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [installer, outArg] = process.argv.slice(2);
const QUESTION = 'How many days of paid annual leave does an employee get per year?';
const START_TIMEOUT = Number(process.env.SMOKE_START_TIMEOUT ?? 600) * 1000;
const SETUP_TIMEOUT = Number(process.env.SMOKE_SETUP_TIMEOUT ?? 900) * 1000;
const LOCAL = process.env.LOCALAPPDATA ?? '';
const DATA = path.join(LOCAL, 'AskFiles');
const LOGS = path.join(DATA, 'logs');
const MAIN_LOG = path.join(LOGS, 'main.log');
const PORTS = path.join(DATA, 'ports.json');
const OUT = path.resolve(outArg ?? 'smoke-out');

const log = (m) => console.log(`[smoke] ${m}`);
let logStart = 0;
const newLog = () => {
  try {
    return fs.readFileSync(MAIN_LOG, 'utf8').split('\n').slice(logStart).join('\n');
  } catch {
    return '';
  }
};
function fail(m) {
  console.error(`[smoke] FAIL: ${m}`);
  const files = fs.existsSync(LOGS) ? fs.readdirSync(LOGS).filter((f) => f.endsWith('.log')) : [];
  for (const f of [...files.map((f) => path.join(LOGS, f)), path.join(OUT, 'app-stdout.log')]) {
    if (!fs.existsSync(f)) continue;
    console.error(`----- last 40 lines of ${f} -----`);
    console.error(fs.readFileSync(f, 'utf8').split('\n').slice(-41).join('\n'));
  }
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
async function until(what, ms, check, every = 2000) {
  const t0 = Date.now();
  for (;;) {
    const v = await check();
    if (v) return { value: v, seconds: Math.round((Date.now() - t0) / 1000) };
    if (Date.now() - t0 > ms) fail(`${what} not within ${ms / 1000}s`);
    await sleep(every);
  }
}

/** Processes whose executable lies in the install folder: AskFiles.exe, ollama.exe, its runners. */
function processesUnder(dir) {
  const ps =
    `$d = '${dir.replace(/'/g, "''")}\\*'; ` +
    'Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like $d } | ' +
    'ForEach-Object { "$($_.ProcessId) $($_.Name) $($_.CommandLine)" }';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0) fail(`listing processes failed: ${r.stderr}`);
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Local addresses listening on a port, from netstat -ano. */
function listeners(port) {
  const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f[0] === 'TCP' && f[3] === 'LISTENING' && f[1].endsWith(`:${port}`))
    .map((f) => f[1].slice(0, f[1].lastIndexOf(':')));
}

if (os.platform() !== 'win32') fail('Windows only');
if (!installer || !fs.existsSync(installer)) fail('usage: node scripts/smoke-windows.mjs <setup.exe> <out-dir>');
if (!LOCAL) fail('LOCALAPPDATA is not set');
fs.mkdirSync(OUT, { recursive: true });

// 1. Silent per-user install.
log(`installing ${installer} silently`);
const inst = spawnSync(installer, ['/S'], { stdio: 'inherit', timeout: 600_000 });
if (inst.status !== 0) fail(`the installer exited with ${inst.status ?? inst.error?.message}`);
const candidates = ['AskFiles', 'askfiles'].map((n) => path.join(LOCAL, 'Programs', n));
const installDir = candidates.find((d) => fs.existsSync(path.join(d, 'AskFiles.exe')));
if (!installDir) fail(`no AskFiles.exe in ${candidates.join(' or ')} after the install`);
const exe = path.join(installDir, 'AskFiles.exe');
log(`installed ${exe}`);
for (const f of ['resources\\app.asar', 'resources\\ollama\\ollama.exe', 'resources\\server\\index.js']) {
  if (!fs.existsSync(path.join(installDir, f))) fail(`the install has no ${f}`);
}
if (fs.existsSync(path.join(installDir, 'resources', 'ollama', 'lib', 'ollama', 'rocm')))
  fail('the install ships the ROCm runtime');

// 2. A first launch: keep only the model cache (restored by the workflow).
fs.mkdirSync(DATA, { recursive: true });
for (const e of fs.readdirSync(DATA))
  if (e !== 'ollama') fs.rmSync(path.join(DATA, e), { recursive: true, force: true });
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-smoke-docs-'));
fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'handbook.pdf'), path.join(folder, 'handbook.pdf'));
log(`library folder ${folder}`);
logStart = 0;

const stdout = fs.openSync(path.join(OUT, 'app-stdout.log'), 'w');
const app = spawn(exe, [], {
  env: {
    ...process.env,
    ASKFILES_PRESETS_FILE: path.join(ROOT, 'test', 'fixtures', 'presets-smoke.json'),
    ASKFILES_LIBRARY_FOLDER: folder,
    ASKFILES_SMOKE_QUESTION: QUESTION,
  },
  stdio: ['ignore', stdout, stdout],
});
let exited = null;
app.on('exit', (code, signal) => (exited = `code ${code} signal ${signal}`));
const running = () => {
  if (exited) fail(`the app exited (${exited})`);
  return true;
};
log(`launched pid ${app.pid}`);

// 3. Backend up, bound to loopback only.
const up = await until('ports.json', START_TIMEOUT, () => {
  const failed = newLog().match(/\[main\] backend (failed|not started).*/);
  if (failed) fail(`the backend did not start: ${failed[0]}`);
  running();
  return readJson(PORTS);
});
log(`backend up after ${up.seconds}s: ${JSON.stringify(up.value)}`);
if (!newLog().includes('start page onboarding')) fail('a fresh data directory did not start on the onboarding page');
if (!newLog().includes('ocr data seeded')) fail('main.log does not show the OCR data seeding');
for (const name of ['ollama', 'collector', 'server']) {
  const addrs = listeners(up.value[name]);
  if (addrs.length === 0) fail(`nothing listens on the ${name} port ${up.value[name]}`);
  if (addrs.some((a) => a !== '127.0.0.1')) fail(`${name} listens on ${addrs.join(', ')}, not only 127.0.0.1`);
  log(`${name} listens on ${addrs.join(', ')}:${up.value[name]}`);
}

const setup = await until('the first run', SETUP_TIMEOUT, () => {
  const failed = newLog().match(/\[(first-run|wizard)\] .* failed:.*/);
  if (failed) fail(`the first run failed: ${failed[0]}`);
  running();
  return readJson(path.join(DATA, 'shell.json'))?.setupCompletedAt;
});
log(`first run done after ${setup.seconds}s at ${setup.value}`);
await until('the Ask page', 60_000, () => newLog().includes('[main] page ready ask connected=true'), 1000);
log('Ask page ready');

// The wizard restarted the backend, so read the ports again.
const ports = readJson(PORTS) ?? fail('ports.json is gone after setup');
const shell = readJson(path.join(DATA, 'shell.json'));
const key = shell?.apiKey;
const slug = shell?.libraries?.[0]?.workspaceSlug;
if (!key || !slug) fail('shell.json lacks the API key or the All files workspace');
const api = `http://127.0.0.1:${ports.server}/api`;
const ping = await (await fetch(`${api}/ping`)).json();
if (ping.online !== true) fail(`/api/ping answered ${JSON.stringify(ping)}`);

// 4. The handbook indexed, then the pipeline answer.
const index = path.join(DATA, 'libraries', 'all-files', 'index.json');
const indexed = await until('the handbook to be indexed', SETUP_TIMEOUT, () => {
  running();
  const rec = Object.values(readJson(index)?.files ?? {}).find((r) => path.win32.basename(r.path) === 'handbook.pdf');
  return rec && rec.sections.length > 0 ? rec : null;
});
log(
  `handbook.pdf indexed after ${indexed.seconds}s: ${indexed.value.sections.length} section(s), path ${indexed.value.path}`,
);
// The library graph (src/main/graph) is stored beside the browse index and lists the handbook.
const graphFile = path.join(DATA, 'libraries', 'all-files', 'graph.json');
const graphed = await until('the graph data to list the handbook', 60_000, () =>
  (readJson(graphFile)?.nodes ?? []).some((n) => n.title === 'handbook.pdf') ? readJson(graphFile) : null,
);
log(`graph data lists ${graphed.value.nodes.map((n) => n.title).join(', ')}`);
const ws = await fetch(`${api}/v1/workspace/${slug}`, { headers: { Authorization: `Bearer ${key}` } });
if (!ws.ok) fail(`GET /v1/workspace/${slug} answered ${ws.status} with the stored key`);
const wsBody = await ws.json();
const docs = (wsBody.workspace?.[0] ?? wsBody.workspace)?.documents?.length ?? 0;
log(`workspace ${slug} holds ${docs} section document(s)`);
if (docs < 1) fail('the library workspace holds no section of the handbook');

const answered = await until('the [answer] smoke line', 300_000, () => {
  running();
  return newLog().match(/.*\[answer\] smoke.*/)?.[0];
});
const smoke = answered.value;
fs.writeFileSync(path.join(OUT, 'answer.log'), smoke + '\n');
log(`pipeline answer after ${answered.seconds}s: ${smoke.slice(0, 400)}`);
if (smoke.includes('smoke failed')) fail(`the answer pipeline failed: ${smoke}`);
if (!smoke.includes('notFound=false')) fail(`the pipeline found no answer: ${smoke}`);
if (!smoke.includes('cited=[1')) fail(`the answer cites no source [1]: ${smoke}`);
if (!/text=".*\[1\]/.test(smoke)) fail(`the answer text has no [1] citation: ${smoke}`);

const before = processesUnder(installDir);
log(`processes from the install folder while running (${before.length}):`);
for (const p of before) log(`  ${p.slice(0, 200)}`);
if (!before.some((p) => /ollama\.exe/i.test(p))) fail('no ollama.exe from the install folder is running');

// 5. Quit like closing the window, then nothing may remain.
log(`closing the app (taskkill /PID ${ports.pid}, WM_CLOSE)`);
spawnSync('taskkill', ['/PID', String(ports.pid)], { stdio: 'inherit' });
const t0 = Date.now();
let left = processesUnder(installDir);
while (left.length && Date.now() - t0 < 60_000) {
  await sleep(1000);
  left = processesUnder(installDir);
}
if (left.length) {
  for (const p of left) log(`  still running: ${p.slice(0, 200)}`);
  spawnSync('taskkill', ['/PID', String(ports.pid), '/T', '/F'], { stdio: 'inherit' });
  fail(`${left.length} process(es) from the install folder were still running 60s after the window closed`);
}
log(`all processes gone ${Math.round((Date.now() - t0) / 1000)}s after the close`);
if (fs.existsSync(PORTS)) fail('ports.json still present after quit');
if (!newLog().includes('stopping backend before quit')) fail('main.log does not show the backend stop on quit');
fs.rmSync(folder, { recursive: true, force: true });
log('ok: silent install, first run, loopback ports, pipeline answer with [1], clean quit');
