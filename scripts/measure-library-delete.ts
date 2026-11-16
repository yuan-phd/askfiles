// Delete of a library whose watcher is still busy (a tester linked a folder holding dozens of code
// repositories): an invented tree of repositories with deeply nested folders, linked into a new
// library with the real chokidar watch, the in-memory fake workspace and the real splitter. The
// library is deleted while its watcher is still starting (chokidar crawling, reconcile walking) and
// the script prints how long the delete took and whether every part of the library is gone.
//
//   node --import tsx scripts/measure-library-delete.ts [repos] [depth] [fanout] [timeoutSeconds]
//
// Defaults: 40 repositories, 4 levels, 4 folders per level (about 13600 folders), 120 s timeout.
// Nothing here is a real file: every folder and Markdown file is made up in a temporary folder.
//
// For a manual test in the app, only make the tree and keep it (prints its path; delete it with
// rm -rf on the printed temporary folder afterwards):
//
//   node --import tsx scripts/measure-library-delete.ts --make-tree [repos] [depth] [fanout]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowseIndex, chunkReader, followWatcher } from '../src/main/browse/index.js';
import { libraryDir, LibraryManager } from '../src/main/libraries.js';
import { emptyShellState, type ShellState } from '../src/main/shell-state.js';
import { countingSplitter, fakeApi } from '../src/main/watcher/__fixtures__/fakes.js';
import { chokidarWatch, FolderWatcher } from '../src/main/watcher/index.js';

const makeOnly = process.argv[2] === '--make-tree';
const args = process.argv.slice(makeOnly ? 3 : 2);
const repos = Number(args[0] ?? 40);
const depth = Number(args[1] ?? 4);
const fanout = Number(args[2] ?? 4);
const timeoutS = Number(args[3] ?? 120);

function makeTree(top: string): { folders: number; files: number } {
  let folders = 0;
  let files = 0;
  const grow = (dir: string, level: number) => {
    fs.mkdirSync(dir, { recursive: true });
    folders++;
    fs.writeFileSync(path.join(dir, 'README.md'), `# Module ${folders}\n\nInvented text for module ${folders}.`);
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};\n');
    files++;
    if (level >= depth) return;
    for (let i = 0; i < fanout; i++) grow(path.join(dir, `pkg-${i}`), level + 1);
  };
  for (let r = 0; r < repos; r++) grow(path.join(top, `repo-${String(r).padStart(2, '0')}`), 0);
  return { folders, files };
}

/** --make-tree: the invented tree alone, kept in a new temporary folder for a test in the app. */
function makeTreeOnly(): void {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-tree-')));
  const top = path.join(tmp, 'Invented Code');
  const t0 = Date.now();
  const tree = makeTree(top);
  console.log(`made ${tree.folders} folders and ${tree.files} Markdown files in ${Date.now() - t0} ms`);
  console.log(`folder to add in AskFiles: ${top}`);
  console.log(`show it in Finder:         open "${tmp}"`);
  console.log(`delete it afterwards:      rm -rf "${tmp}"`);
}

async function main(): Promise<void> {
  if (makeOnly) return makeTreeOnly();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-delete-')));
  const dataDir = path.join(tmp, 'AskFiles');
  const storageDir = path.join(dataDir, 'storage');
  const top = path.join(tmp, 'Code');
  const t0 = Date.now();
  const tree = makeTree(top);
  console.log(`tree: ${tree.folders} folders, ${tree.files} Markdown files, made in ${Date.now() - t0} ms`);

  let state: ShellState = emptyShellState();
  state.apiKey = 'K';
  state.setupCompletedAt = new Date(0).toISOString();
  state.libraries[0]!.workspaceSlug = 'askfiles-library';
  const api = fakeApi(storageDir);
  // Embedding takes time on a real Mac; 20 ms per call keeps the queue busy here too.
  const embed = api.updateEmbeddings.bind(api);
  api.updateEmbeddings = async (slug, change) => {
    await new Promise((r) => setTimeout(r, 20));
    return embed(slug, change);
  };
  const removed: string[] = [];
  const manager = new LibraryManager({
    dataDir,
    storageDir,
    ocrCacheDir: path.join(dataDir, 'ocr-cache'),
    getState: () => state,
    setState: (s) => (state = structuredClone(s)),
    workspaces: {
      ensure: async (id) => `ws-${id}`,
      remove: async (slug) => void removed.push(slug),
    },
    removeDocuments: (folder) =>
      fs.rmSync(path.join(storageDir, 'documents', folder), { recursive: true, force: true }),
    createWatcher: (o) =>
      new FolderWatcher({ ...o, storageDir, api, splitter: countingSplitter(), watch: chokidarWatch, log: () => {} }),
    createBrowse: (o) => new BrowseIndex({ dir: o.dir, readChunk: chunkReader(storageDir), log: () => {} }),
    followWatcher: (b, w) => followWatcher(b, w),
    onChange: () => {},
    onStatus: () => {},
  });

  await manager.start();
  const v = await manager.create('Code');
  const id = v.current;
  // addFolder restarts the runtime inside the queue: the same as linking the folder in the app.
  const adding = manager.addFolder(top);
  // Let chokidar start crawling.
  await new Promise((r) => setTimeout(r, 300));
  const t1 = Date.now();
  const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutS * 1000).unref());
  const outcome = await Promise.race([manager.remove(id).then(() => 'done' as const), timeout]);
  const ms = Date.now() - t1;
  console.log(`delete ${outcome} after ${ms} ms (watcher started indexing ${api.log.length} calls before)`);
  if (outcome === 'timeout') {
    // The queue is still held by the start; waiting for it would hang this script too.
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  {
    console.log(
      `library folder gone: ${!fs.existsSync(libraryDir(dataDir, id))}, documents gone: ${!fs.existsSync(path.join(storageDir, 'documents', 'askfiles', id))}, workspace removed: ${removed.includes(`ws-${id}`)}, in shell.json: ${state.libraries.some((l) => l.id === id)}`,
    );
  }
  await adding.catch(() => undefined);
  await manager.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(outcome === 'done' ? 0 : 1);
}

void main();
