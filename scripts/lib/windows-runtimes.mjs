// The runtime libraries the Windows build ships inside the Ollama folder (resources/ollama, from
// ollama-windows-amd64.zip, trimmed by scripts/lib/ollama-runtimes.mjs) that the Ollama release
// ships without a license text: the Microsoft Visual C++ runtime, the LLVM runtimes and MinGW-w64
// winpthreads. scripts/third-party-notices.mjs adds their texts to THIRD-PARTY-NOTICES when it runs
// on a tree with ollama.exe (the Windows package), and docs/licenses.md carries the same texts.
//
// Every executable file in that folder must belong to a group below; --strict fails on any other,
// and on a runtime whose version differs from the one the texts were taken for, so an Ollama update
// that changes them is noticed. Texts are verbatim copies in scripts/notices, fetched 2026-11-10.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NOTICES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'notices');

/**
 * Groups of files, matched on the base name. text: license files in scripts/notices to reproduce;
 * none for groups whose license files the Ollama archive already ships next to them, or whose terms
 * ask for no text. version: how to read the version the texts belong to, and the one expected.
 */
export const RUNTIME_GROUPS = [
  {
    id: 'msvc',
    title: 'Microsoft Visual C++ 2015-2022 Runtime 14.44 (Visual Studio 2022)',
    match: /^(msvcp140(_[a-z0-9_]+)?|vcruntime140(_[a-z0-9_]+)?|concrt140|vccorlib140)\.dll$/i,
    about: [
      'Redistributed as Distributable Code under the Visual Studio 2022 license terms (section',
      '"Distributable Code"; list at https://aka.ms/vs/17/redistribution). The license terms of the',
      'runtime follow, from https://visualstudio.microsoft.com/license-terms/vs2022-cruntime/',
      '(Visual-C-Runtime-2015-2022-License-1.docx, EULA ID Cpp_2015-2022_ENU.1033; the text without',
      "Word's automatic list numbering).",
    ],
    texts: ['msvc-runtime-LICENSE.txt'],
    version: { file: /^msvcp140\.dll$/i, read: 'fileVersion', expect: /^14\./ },
  },
  {
    id: 'llvm',
    title: 'LLVM runtimes 18.1.8: libc++, libunwind, OpenMP (libomp)',
    match: /^(libc\+\+|libunwind|libomp)\.dll$/i,
    about: [
      'Apache License 2.0 with LLVM Exceptions. Built by llvm-mingw 20240619 from llvm-project',
      'llvmorg-18.1.8 (commit 3b5b5c1ec4a3095ab096dd780e84d7ab81f3d7ff, the version the DLLs name).',
      'The LICENSE.TXT of libcxx, libunwind and openmp at that tag follow.',
    ],
    texts: ['llvm-libcxx-LICENSE.TXT', 'llvm-libunwind-LICENSE.TXT', 'llvm-openmp-LICENSE.TXT'],
    version: {
      file: /^libc\+\+\.dll$/i,
      read: 'clang',
      expect: /^18\.1\.8 .*3b5b5c1ec4a3095ab096dd780e84d7ab81f3d7ff/,
    },
  },
  {
    id: 'winpthreads',
    title: 'MinGW-w64 winpthreads (libwinpthread-1.dll)',
    match: /^libwinpthread-1\.dll$/i,
    about: [
      'MIT License and the BSD-style license of the code it derives from. Built by llvm-mingw 20240619',
      'from mingw-w64 commit 7c9cfe6708cafc83c14a2654308b2db62b126eae; its',
      'mingw-w64-libraries/winpthreads/COPYING follows.',
    ],
    texts: ['winpthreads-COPYING'],
  },
  {
    id: 'cuda',
    title: 'NVIDIA CUDA 12 runtime: cudart, cuBLAS, cuBLASLt',
    match: /^(cudart64_\d+|cublas64_\d+|cublasLt64_\d+)\.dll$/i,
    about: [
      'Redistributed with the application under the NVIDIA CUDA Toolkit End User License Agreement,',
      'which lists these files in Attachment A as distributable: https://docs.nvidia.com/cuda/eula/index.html',
      'The agreement asks for no notice text for them.',
    ],
    texts: [],
  },
  {
    id: 'ollama',
    title: 'Ollama, llama.cpp and ggml',
    match: /^(ollama\.exe|ggml[\w-]*\.dll|libllama[\w-]*\.dll|libmtmd\.dll|llama-[\w-]+\.exe)$/i,
    about: ['MIT; their license files ship in the Ollama folder (LLAMA_CPP_LICENSE and the others).'],
    texts: [],
  },
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(dll|exe)$/i.test(e.name)) out.push(p);
  }
  return out;
}

/** FileVersion from a PE file's version resource (UTF-16 strings), or the clang version string. */
export function readVersion(file, how) {
  const buf = fs.readFileSync(file);
  if (how === 'fileVersion') {
    const m = /FileVersion\0+([0-9][0-9., ]*)/.exec(buf.toString('utf16le'));
    return m ? m[1].trim() : null;
  }
  const m = /clang version ([^\0)]+\))/.exec(buf.toString('latin1'));
  return m ? m[1] : null;
}

/**
 * The runtime groups found under ollamaDir (empty when it is not the Windows Ollama package), with
 * their files, and errors for files in no group and for versions other than expected.
 */
export function windowsRuntimes(ollamaDir) {
  if (!fs.existsSync(path.join(ollamaDir, 'ollama.exe'))) return { groups: [], errors: [] };
  const errors = [];
  const found = new Map();
  for (const file of walk(ollamaDir).sort()) {
    const rel = path.relative(ollamaDir, file).split(path.sep).join('/');
    const group = RUNTIME_GROUPS.find((g) => g.match.test(path.basename(file)));
    if (!group) {
      errors.push(`${rel} is in no group of scripts/lib/windows-runtimes.mjs, so its license is not covered`);
      continue;
    }
    const g = found.get(group.id) ?? { ...group, files: [] };
    g.files.push(rel);
    found.set(group.id, g);
    if (group.version && group.version.file.test(path.basename(file))) {
      const v = readVersion(file, group.version.read);
      if (!v || !group.version.expect.test(v)) {
        errors.push(
          `${rel}: version ${v ?? 'unreadable'} is not the one the license texts in scripts/notices were taken for`,
        );
      }
    }
  }
  const groups = RUNTIME_GROUPS.filter((g) => found.has(g.id)).map((g) => found.get(g.id));
  return { groups, errors };
}

/** A license text from scripts/notices. */
export function noticeText(name) {
  return fs.readFileSync(path.join(NOTICES_DIR, name), 'utf8').trim();
}

/** Section lines for THIRD-PARTY-NOTICES: each group, its files and the texts that go with it. */
export function windowsRuntimeLines(groups) {
  const lines = [];
  for (const g of groups) {
    lines.push(`- ${g.title}`, ...g.about.map((l) => `  ${l}`), `  Files: ${g.files.join(', ')}`);
  }
  const texts = [];
  for (const g of groups) {
    for (const t of g.texts) texts.push({ heading: `=== Windows runtime: ${g.title}, ${t} ===`, text: noticeText(t) });
  }
  return { lines, texts };
}
