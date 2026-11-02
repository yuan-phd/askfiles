// Trims the Ollama Windows package in resources/ollama to the GPU runtimes AskFiles ships.
// ollama-windows-amd64.zip holds ollama.exe and lib/ollama: the CPU libraries (ggml-cpu-*.dll and
// the llama DLLs, always kept), the license files, and one folder per GPU runtime (cuda_v12,
// cuda_v13, vulkan; ROCm comes in a separate zip AskFiles never downloads). Every runtime folder
// not named in --keep is removed: AMD support is dropped (docs/plan.md, phase 5), and one CUDA
// generation keeps the installer under NSIS's 2 GB limit (docs/windows.md).
//
// Usage: node scripts/lib/ollama-runtimes.mjs <ollamaDir> --keep cuda_v12[,other] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function sizeOf(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((n, e) => n + sizeOf(path.join(p, e)), 0);
}

/** Removes the runtime folders not in keep; refuses a package without ollama.exe or the CPU library. */
export function trimRuntimes({ ollamaDir, keep, dryRun = false }) {
  const lib = path.join(ollamaDir, 'lib', 'ollama');
  for (const need of [path.join(ollamaDir, 'ollama.exe'), path.join(lib, 'ggml-cpu-x64.dll')]) {
    if (!fs.existsSync(need))
      throw new Error(`${need} is missing; is ${ollamaDir} the unpacked ollama-windows-amd64.zip?`);
  }
  const runtimes = fs
    .readdirSync(lib, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const missing = keep.filter((k) => !runtimes.includes(k));
  if (missing.length) throw new Error(`no ${missing.join(', ')} in ${lib} (found ${runtimes.join(', ') || 'none'})`);
  const kept = [];
  const removed = [];
  for (const name of runtimes) {
    const p = path.join(lib, name);
    const entry = { name, bytes: sizeOf(p) };
    if (keep.includes(name)) kept.push(entry);
    else {
      removed.push(entry);
      if (!dryRun) fs.rmSync(p, { recursive: true, force: true });
    }
  }
  return { kept, removed };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--keep');
  const dir = args.find((a, j) => !a.startsWith('--') && args[j - 1] !== '--keep');
  if (!dir || i === -1 || !args[i + 1]) {
    console.error('usage: node scripts/lib/ollama-runtimes.mjs <ollamaDir> --keep cuda_v12[,other] [--dry-run]');
    process.exit(2);
  }
  try {
    const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
    const r = trimRuntimes({ ollamaDir: dir, keep: args[i + 1].split(','), dryRun: args.includes('--dry-run') });
    for (const k of r.kept) console.log(`[ollama-runtimes] kept ${k.name} (${mb(k.bytes)})`);
    for (const k of r.removed) console.log(`[ollama-runtimes] removed ${k.name} (${mb(k.bytes)})`);
  } catch (e) {
    console.error(`[ollama-runtimes] ${e.message}`);
    process.exit(1);
  }
}
