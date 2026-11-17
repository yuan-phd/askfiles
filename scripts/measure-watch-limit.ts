// Where the one-watch-per-folder approach breaks (docs/tickets/large-folder-blocks-window.md): runs
// the real chokidar watch of the shell (src/main/watcher/fs-watch.ts) over invented folder trees and
// reports, per case, how many fs.watch calls were made on folders and on files, how many failed
// with EMFILE, how long until ready, the longest stall of the event loop (a 10 ms timer) and how
// long closing every watch takes afterwards (synchronous: the process does nothing else meanwhile).
// Every case runs in a fresh process, since the watches of one process share one FSEvents stream
// on macOS (libuv), which is what the cases with several trees check.
//
//   node --import tsx scripts/measure-watch-limit.ts tree 3000            one tree of 3000 folders
//   node --import tsx scripts/measure-watch-limit.ts trees 1500,1500,1500 three trees, watched one after another
//   node --import tsx scripts/measure-watch-limit.ts added 2000            2000 folders, one added file in each (depth 0)
//   node --import tsx scripts/measure-watch-limit.ts mixed 3000,2000       a tree of 3000 folders, then 2000 added-file folders
//   node --import tsx scripts/measure-watch-limit.ts raw 4200:100         plain fs.watch on 4200 folders, 100 at a time with a yield between (0: no yield)
//   node --import tsx scripts/measure-watch-limit.ts sweep                 the table for the PR
//   node --import tsx scripts/measure-watch-limit.ts close                 time to close the watches of one tree, 500 to 3000 folders
//
// Each folder holds one invented Markdown file. Nothing is indexed; only watching is measured.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface Result {
  kase: string;
  folders: number;
  dirWatches: number;
  fileWatches: number;
  emfile: number;
  readyMs: number;
  maxStallMs: number;
  closeMs: number;
}

/** A tree of n folders, nested ten wide, each with one Markdown file. Returns the folder paths. */
function makeTree(top: string, n: number): string[] {
  const dirs: string[] = [];
  fs.mkdirSync(top, { recursive: true });
  const queue = [top];
  while (dirs.length < n) {
    const parent = queue.shift()!;
    for (let i = 0; i < 10 && dirs.length < n; i++) {
      const d = path.join(parent, `d${i}`);
      fs.mkdirSync(d);
      fs.writeFileSync(path.join(d, 'note.md'), `# Note\n\nInvented text ${dirs.length}.\n`);
      dirs.push(d);
      queue.push(d);
    }
  }
  return dirs;
}

async function measure(kind: string, spec: string): Promise<void> {
  // Count every fs.watch chokidar makes, before chokidar is loaded.
  let dirWatches = 0;
  let fileWatches = 0;
  const orig = fs.watch;
  (fs as { watch: typeof fs.watch }).watch = ((p: fs.PathLike, ...rest: unknown[]) => {
    try {
      if (fs.statSync(p).isDirectory()) dirWatches++;
      else fileWatches++;
    } catch {
      /* gone already */
    }
    return (orig as (...a: unknown[]) => fs.FSWatcher)(p, ...rest);
  }) as typeof fs.watch;
  syncBuiltinESMExports();
  const { chokidarWatch } = await import('../src/main/watcher/fs-watch.js');

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-watch-limit-')));
  const sizes = spec.split(':')[0]!.split(',').map(Number);
  let emfile = 0;
  let maxStall = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxStall = Math.max(maxStall, now - last - 10);
    last = now;
  }, 10);
  const handles: { close(): Promise<void> }[] = [];
  try {
    const plan: { root: string; depth0?: string[] }[] = [];
    sizes.forEach((n, i) => {
      const top = path.join(tmp, `tree-${i}`);
      const dirs = makeTree(top, n);
      const asAdded = kind === 'added' || (kind === 'mixed' && i > 0);
      if (asAdded) plan.push({ root: top, depth0: dirs });
      else plan.push({ root: top });
    });
    const onError = (e: Error) => {
      if (/EMFILE/.test(e.message)) emfile++;
    };
    const t0 = performance.now();
    last = t0;
    if (kind === 'raw') {
      // Without chokidar: one fs.watch per folder, batch at a time, yielding to the event loop
      // between batches the way a batched watcher would.
      const batch = Number(spec.split(':')[1] ?? 0);
      const dirs = [plan[0]!.root, ...walkDirs(plan[0]!.root)];
      for (const [i, d] of dirs.entries()) {
        const w = fs.watch(d, () => {});
        w.on('error', onError);
        handles.push({ close: async () => w.close() });
        if (batch && (i + 1) % batch === 0) await new Promise((r) => setTimeout(r, 0));
      }
      // Errors arrive after the calls; give them time to land, then measure as with chokidar.
      const settle = performance.now();
      while (performance.now() - settle < 3000) await new Promise((r) => setTimeout(r, 20));
    }
    for (const p of kind === 'raw' ? [] : plan) {
      if (p.depth0) {
        // As the watcher watches added files: their folder at depth 0, only the added file.
        for (const d of p.depth0) {
          const h = chokidarWatch(d, () => {}, onError, { depth: 0, only: new Set([path.join(d, 'note.md')]) });
          handles.push(h);
          await h.ready;
        }
      } else {
        const h = chokidarWatch(p.root, () => {}, onError);
        handles.push(h);
        await h.ready;
      }
    }
    const readyMs = performance.now() - t0;
    // FSEvents failures reach the handles about 200 ms after the last call; wait for them.
    if (kind !== 'raw')
      for (const s = performance.now(); performance.now() - s < 3000;) await new Promise((r) => setTimeout(r, 20));
    const c0 = performance.now();
    await Promise.all(handles.splice(0).map((h) => h.close()));
    const closeMs = performance.now() - c0;
    const r: Result = {
      kase: `${kind} ${spec}`,
      folders: sizes.reduce((a, b) => a + b, 0),
      dirWatches,
      fileWatches,
      emfile,
      readyMs,
      maxStallMs: maxStall,
      closeMs,
    };
    process.stdout.write(JSON.stringify(r) + '\n');
  } finally {
    clearInterval(timer);
    await Promise.all(handles.map((h) => h.close()));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function walkDirs(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }))
    if (e.isDirectory()) out.push(path.join(dir, e.name), ...walkDirs(path.join(dir, e.name)));
  return out;
}

function child(kind: string, spec: string): Result {
  const r = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), kind, spec], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 15 * 60 * 1000,
  });
  if (r.status !== 0) throw new Error(`child ${kind} ${spec} failed with ${r.status}`);
  return JSON.parse(r.stdout.trim().split('\n').pop()!);
}

const SWEEP: [string, string][] = [
  ['tree', '1000'],
  ['tree', '2000'],
  ['tree', '3000'],
  ['tree', '3500'],
  ['tree', '4000'],
  ['tree', '4500'],
  ['tree', '5000'],
  ['trees', '2000,2000'],
  ['trees', '1500,1500,1500'],
  ['added', '1000'],
  ['mixed', '3000,1500'],
];

const CLOSE: [string, string][] = [
  ['tree', '500'],
  ['tree', '1000'],
  ['tree', '2000'],
  ['tree', '3000'],
];

async function run(): Promise<void> {
  const [kind, spec] = process.argv.slice(2);
  if (kind && kind !== 'sweep' && kind !== 'close') return measure(kind, spec!);
  console.log(
    `Node ${process.version}, ${os.platform()} ${os.arch()}, ${os.cpus().length} cores, each case in a fresh process\n`,
  );
  console.log(
    '| Case | Folders | fs.watch on folders | fs.watch on files | EMFILE | Ready after | Longest stall | Closing all |',
  );
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const [k, s] of kind === 'close' ? CLOSE : SWEEP) {
    const r = child(k, s);
    console.log(
      `| ${r.kase} | ${r.folders} | ${r.dirWatches} | ${r.fileWatches} | ${r.emfile} | ${(r.readyMs / 1000).toFixed(1)} s | ${r.maxStallMs.toFixed(0)} ms | ${(r.closeMs / 1000).toFixed(1)} s |`,
    );
  }
}

void run();
