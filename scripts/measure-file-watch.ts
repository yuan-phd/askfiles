// Cost of watching individually added files (Add files links them; src/main/libraries.ts): an
// invented library of 900 added files spread over 200 folders, each folder also holding files that
// were not added, watched through their folders with the real chokidar watch. Prints process memory
// and idle CPU before and after the watcher started (each case in a fresh process, on an index built
// beforehand, so nothing is split or embedded while measuring), and the same files linked as one
// folder for comparison, plus the start-up reconcile and Check for updates times.
//
//   node --expose-gc --import tsx scripts/measure-file-watch.ts [idleSeconds]
//
// The section documents go to a temporary folder and the workspace is an in-memory fake, so only
// the shell's own watching is measured; no server or model is involved.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countingSplitter, fakeApi } from '../src/main/watcher/__fixtures__/fakes.js';
import { chokidarWatch, FolderWatcher, type WatchRoot } from '../src/main/watcher/index.js';

const FILES = 900;
const FOLDERS = 200;
/** Files in each folder that were not added: the watch must leave them alone. */
const NEIGHBOURS = 10;
const idleSeconds = Number(process.argv[2] ?? 30);

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with node --expose-gc --import tsx');

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Memory after a full collection, and CPU use over an idle window as a share of one core. */
async function sample(label: string): Promise<{ label: string; rss: number; heap: number; cpu: number }> {
  gc!();
  await sleep(500);
  gc!();
  const mem = process.memoryUsage();
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  await sleep(idleSeconds * 1000);
  const used = process.cpuUsage(cpu0);
  const wall = performance.now() - t0;
  const cpu = ((used.user + used.system) / 1000 / wall) * 100;
  return { label, rss: mem.rss, heap: mem.heapUsed, cpu };
}

function makeLibrary(tmp: string): { files: string[] } {
  const top = path.join(tmp, 'Home');
  const files: string[] = [];
  for (let d = 0; d < FOLDERS; d++) {
    const dir = path.join(top, `area-${String(d).padStart(3, '0')}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let n = 0; n < NEIGHBOURS; n++)
      fs.writeFileSync(path.join(dir, `other-${n}.md`), `# Other ${n}\n\nNot added.`);
  }
  for (let i = 0; i < FILES; i++) {
    const dir = path.join(top, `area-${String(i % FOLDERS).padStart(3, '0')}`);
    const p = path.join(dir, `note-${String(i).padStart(4, '0')}.md`);
    fs.writeFileSync(p, `# Note ${i}\n\nAn invented note, number ${i}.\n\n## Detail\n\nSome text for note ${i}.`);
    files.push(fs.realpathSync(p));
  }
  return { files };
}

type Row = Awaited<ReturnType<typeof sample>>;
const MODES = ['added', 'folder'] as const;

function rootsOf(tmp: string, mode: (typeof MODES)[number]): WatchRoot[] {
  const files: string[] = JSON.parse(fs.readFileSync(path.join(tmp, 'files.json'), 'utf8'));
  return mode === 'added'
    ? files.map((p, i) => ({ id: `file-${i + 1}`, path: p, label: '', file: true }))
    : [{ id: 'folder-1', path: path.join(tmp, 'Home'), label: 'Home' }];
}

function watcherOf(tmp: string, mode: (typeof MODES)[number]): FolderWatcher {
  const dir = path.join(tmp, mode);
  return new FolderWatcher({
    roots: rootsOf(tmp, mode),
    dataDir: dir,
    storageDir: path.join(dir, 'storage'),
    workspaceSlug: mode,
    api: fakeApi(path.join(dir, 'storage')),
    splitter: countingSplitter(),
    watch: chokidarWatch,
    debounceMs: 50,
    stableMs: 50,
    log: () => {},
  });
}

/** Child: builds the invented library and indexes it both ways, so the measured starts find nothing to do. */
async function prepare(tmp: string): Promise<void> {
  const { files } = makeLibrary(tmp);
  fs.writeFileSync(path.join(tmp, 'files.json'), JSON.stringify(files));
  for (const mode of MODES) {
    const w = watcherOf(tmp, mode);
    await w.start();
    await w.whenIdle();
    await w.stop();
  }
}

/**
 * Child: a fresh process, so its memory holds nothing from indexing. The fake workspace starts
 * empty, which does not matter here: with index.json current, nothing is embedded or asked.
 */
async function measure(tmp: string, mode: (typeof MODES)[number]): Promise<void> {
  const before = await sample('before');
  const w = watcherOf(tmp, mode);
  const s0 = performance.now();
  await w.start();
  const startMs = performance.now() - s0;
  await w.whenIdle();
  const c0 = performance.now();
  await w.checkNow();
  const checkMs = performance.now() - c0;
  await w.whenIdle();
  const after = await sample('after');
  const files = w.status().indexed;
  await w.stop();
  process.stdout.write(JSON.stringify({ before, after, startMs, checkMs, files }) + '\n');
}

function child(args: string[]): string {
  const r = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', fileURLToPath(import.meta.url), ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (r.status !== 0) throw new Error(`child ${args[0]} failed with ${r.status}`);
  return r.stdout;
}

async function run(): Promise<void> {
  const [mode, tmpArg] = process.argv.slice(3);
  if (mode === 'prepare') return prepare(tmpArg!);
  if (mode === 'added' || mode === 'folder') return measure(tmpArg!, mode);

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-watch-cost-')));
  try {
    child([String(idleSeconds), 'prepare', tmp]);
    const results = Object.fromEntries(
      MODES.map((m) => [
        m,
        JSON.parse(
          child([String(idleSeconds), m, tmp])
            .trim()
            .split('\n')
            .pop()!,
        ),
      ]),
    ) as Record<(typeof MODES)[number], { before: Row; after: Row; startMs: number; checkMs: number; files: number }>;
    console.log(
      `Node ${process.version}, ${os.platform()} ${os.arch()}, ${os.cpus().length} cores, idle window ${idleSeconds} s, each case in a fresh process\n`,
    );
    console.log(
      '| Case | RSS before (MB) | RSS watching (MB) | Heap before (MB) | Heap watching (MB) | Idle CPU before | Idle CPU watching | Start, nothing changed | Check for updates |',
    );
    console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    const label = {
      added: `${FILES} added files in ${FOLDERS} folders (${FOLDERS} folder watches, depth 0)`,
      folder: `the same files as one linked folder (${FILES + FOLDERS * NEIGHBOURS} files, recursive watch)`,
    };
    for (const m of MODES) {
      const r = results[m];
      console.log(
        `| ${label[m]} | ${mb(r.before.rss)} | ${mb(r.after.rss)} | ${mb(r.before.heap)} | ${mb(r.after.heap)} | ${r.before.cpu.toFixed(2)} % | ${r.after.cpu.toFixed(2)} % | ${r.startMs.toFixed(0)} ms | ${r.checkMs.toFixed(0)} ms |`,
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

void run();
