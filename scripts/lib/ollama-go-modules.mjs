// The Go modules compiled into the Ollama binary the app ships (resources/ollama/ollama on macOS,
// ollama.exe on Windows), with the license and notice files of each at the exact version compiled
// in. The Go linker records every module it took packages from in the binary (what `go version -m`
// prints); this reads that record, so no Go toolchain is needed.
//
// The texts are kept in scripts/notices/ollama-go-modules.json, fetched once per Ollama version from
// the Go module proxy (proxy.golang.org, the module zip of each version) with:
//   node scripts/lib/ollama-go-modules.mjs fetch <ollama binary>...
// scripts/third-party-notices.mjs reads the binary at packaging time and fails with --strict when it
// holds a module or version the record lacks, so an Ollama update is noticed. The Ollama release
// also ships the texts, without versions, in its GO_LICENSE file (go-licenses output).
/* global fetch -- Node 18+ global, missing from the eslint node list */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RECORD_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'notices',
  'ollama-go-modules.json',
);

const MAGIC = Buffer.from('\xff Go buildinf:', 'latin1');

/**
 * Every build-info record in a binary (a universal macOS binary holds one per architecture):
 * Go version, main module and its dependencies. Only the Go 1.18+ layout (inline strings) is read.
 */
export function readGoBuildInfo(buf) {
  const out = [];
  for (let at = buf.indexOf(MAGIC); at >= 0; at = buf.indexOf(MAGIC, at + MAGIC.length)) {
    if (!(buf[at + 15] & 2)) continue;
    let p = at + 32;
    const str = () => {
      let n = 0;
      let shift = 0;
      let b;
      do {
        b = buf[p++];
        n += (b & 0x7f) * 2 ** shift;
        shift += 7;
      } while (b & 0x80);
      const s = buf.subarray(p, p + n);
      p += n;
      return s;
    };
    const goVersion = str().toString('utf8');
    const raw = str();
    // The module text sits between two 16-byte sentinels.
    const mod = raw.length >= 32 ? raw.subarray(16, raw.length - 16).toString('utf8') : '';
    const modules = [];
    const settings = {};
    let main = null;
    for (const line of mod.split('\n')) {
      const [kind, a, b] = line.split('\t');
      if (kind === 'mod') main = { path: a, version: b };
      else if (kind === 'dep') modules.push({ path: a, version: b });
      else if (kind === '=>' && modules.length) modules[modules.length - 1].replacedBy = { path: a, version: b };
      else if (kind === 'build') {
        const i = a.indexOf('=');
        settings[a.slice(0, i)] = a.slice(i + 1);
      }
    }
    out.push({ goVersion, main, modules, settings });
  }
  return out;
}

/** The Ollama binary in ollamaDir: ollama (macOS, Linux) or ollama.exe (Windows), or null. */
export function ollamaBinary(ollamaDir) {
  for (const name of ['ollama', 'ollama.exe']) {
    const p = path.join(ollamaDir, name);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

/** Modules of all records of a binary, sorted and without duplicates; replacements win. */
export function modulesOf(infos) {
  const seen = new Map();
  for (const info of infos) {
    for (const m of info.modules) {
      const eff = m.replacedBy?.version ? m.replacedBy : m;
      seen.set(`${eff.path}@${eff.version}`, { path: eff.path, version: eff.version });
    }
  }
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Checks a binary's modules, and the Go versions it was built with, against the record. modules and
 * std: the record's entries for them; errors: modules, versions or Go versions the record lacks.
 */
export function checkAgainstRecord(found, record, goVersions = []) {
  const byKey = new Map(record.modules.map((m) => [`${m.path}@${m.version}`, m]));
  const modules = [];
  const errors = [];
  for (const m of found) {
    const r = byKey.get(`${m.path}@${m.version}`);
    if (r) modules.push(r);
    else
      errors.push(
        `${m.path}@${m.version} is compiled into the Ollama binary but not in scripts/notices/ollama-go-modules.json; run node scripts/lib/ollama-go-modules.mjs fetch <binary>`,
      );
  }
  const std = [];
  for (const v of goVersions) {
    const g = (record.std ?? []).find((x) => x.version === v);
    if (g) std.push(g);
    else errors.push(`the Go standard library of ${v} is not in scripts/notices/ollama-go-modules.json; run the fetch`);
  }
  return { modules, std, errors };
}

/**
 * Section lines for THIRD-PARTY-NOTICES and the texts, each distinct text once. std: the record's
 * Go standard library entries ({ version, files }), matched to the binary's Go version.
 */
export function goModuleLines(binaryName, infos, modules, std = []) {
  const go = [...new Set(infos.map((i) => i.goVersion))].join(', ');
  const main = infos[0]?.main;
  const revision = infos[0]?.settings['vcs.revision'];
  const lines = [
    `The Ollama binary (${binaryName}) is ${main ? `${main.path} ${main.version}` : 'Ollama'}${revision ? `, built from commit ${revision}` : ''} with ${go}.`,
    'The Go standard library and these modules are compiled into it, as its build information lists them',
    `(go version -m). Their license and notice files at these versions follow under "License texts", headed "Go module in Ollama".`,
    '',
    ...std.map((g) => `- Go standard library ${g.version}: ${g.license}`),
    ...modules.map((m) => `- ${m.path} ${m.version}: ${m.license}`),
  ];
  const groups = new Map();
  const add = (who, file, text) => {
    const key = text.replace(/\s+/g, ' ').trim();
    const g = groups.get(key) ?? { text: text.trim(), users: [] };
    g.users.push(file ? `${who} (${file})` : who);
    groups.set(key, g);
  };
  for (const g of std) for (const f of g.files) add(`Go standard library ${g.version}`, f.name, f.text);
  for (const m of modules) for (const f of m.files) add(`${m.path}@${m.version}`, f.name, f.text);
  const texts = [...groups.values()].map((g) => ({
    heading: `=== Go module in Ollama: ${g.users.join(', ')} ===`,
    text: g.text,
  }));
  return { lines, texts };
}

/** The license and notice files a module zip holds (outside testdata and vendor folders). */
const NOTICE_FILE = /(^|\/)(licen[cs]e|copying|notice|patents)(\.[a-z]+)?$/i;

/**
 * SPDX expression from a license text: every license the file holds, joined with AND (files such as
 * yaml.v3's cover some source files under one license and the rest under another); null when none
 * is recognised.
 */
export function classify(text) {
  const t = text.replace(/\s+/g, ' ');
  const ids = [];
  if (/Redistribution and use in source and binary forms/i.test(t))
    ids.push(/Neither the name|names of its contributors/i.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause');
  if (/Permission is hereby granted, free of charge/i.test(t)) ids.push('MIT');
  if (/Permission to use, copy, modify, and(\/or)? distribute this software for any purpose/i.test(t)) ids.push('ISC');
  if (/Apache License,? Version 2\.0/i.test(t)) ids.push('Apache-2.0');
  if (/Mozilla Public License,? v(ersion)?\.? 2\.0/i.test(t)) ids.push('MPL-2.0');
  return ids.length ? ids.join(' AND ') : null;
}

/** Module path as the proxy spells it: capitals become ! and the lower-case letter. */
const escapePath = (p) => p.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);

async function fetchModule(m, tmp) {
  const url = `https://proxy.golang.org/${escapePath(m.path)}/@v/${escapePath(m.version)}.zip`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const zip = path.join(tmp, 'module.zip');
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  const prefix = `${m.path}@${m.version}/`;
  const names = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\n')
    .filter((n) => n.startsWith(prefix) && NOTICE_FILE.test(n) && !/\/(testdata|vendor|_examples?)\//.test(n));
  const files = names.sort().map((n) => ({
    name: n.slice(prefix.length),
    text: execFileSync('unzip', ['-p', zip, n], { encoding: 'utf8', maxBuffer: 16 << 20 }).trim(),
  }));
  const root = files.find((f) => !f.name.includes('/') && /^licen[cs]e|^copying/i.test(f.name));
  return { ...m, license: (root && classify(root.text)) ?? 'UNKNOWN', source: url, files };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...bins] = process.argv.slice(2);
  if (cmd !== 'fetch' || !bins.length) {
    console.error('usage: node scripts/lib/ollama-go-modules.mjs fetch <ollama binary>...');
    process.exit(2);
  }
  const infos = bins.flatMap((b) => readGoBuildInfo(fs.readFileSync(b)));
  if (!infos.length) throw new Error('no Go build information found');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-gomod-'));
  try {
    const modules = [];
    for (const m of modulesOf(infos)) {
      const r = await fetchModule(m, tmp);
      console.log(`[go-modules] ${r.path} ${r.version}: ${r.license}, ${r.files.map((f) => f.name).join(', ')}`);
      modules.push(r);
    }
    // The standard library's license and patent grant, from the Go repository at each release tag.
    const std = [];
    for (const version of [...new Set(infos.map((i) => i.goVersion))]) {
      const files = [];
      for (const name of ['LICENSE', 'PATENTS']) {
        const url = `https://raw.githubusercontent.com/golang/go/${version}/${name}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        files.push({ name, text: (await res.text()).trim() });
      }
      std.push({
        version,
        license: classify(files[0].text) ?? 'UNKNOWN',
        source: `https://github.com/golang/go/tree/${version}`,
        files,
      });
      console.log(`[go-modules] Go standard library ${version}: ${std.at(-1).license}`);
    }
    const record = {
      about:
        'License and notice files of the Go modules compiled into the bundled Ollama binary, at the versions compiled in, from the module zips on proxy.golang.org. Written by scripts/lib/ollama-go-modules.mjs fetch.',
      fetched: new Date().toISOString().slice(0, 10),
      binaries: infos.map((i) => ({
        main: i.main,
        goVersion: i.goVersion,
        goos: i.settings.GOOS,
        goarch: i.settings.GOARCH,
        revision: i.settings['vcs.revision'],
      })),
      std,
      modules,
    };
    fs.writeFileSync(RECORD_FILE, JSON.stringify(record, null, 2) + '\n');
    const unknown = modules.filter((m) => m.license === 'UNKNOWN');
    console.log(`[go-modules] wrote ${path.relative(process.cwd(), RECORD_FILE)}: ${modules.length} modules`);
    if (unknown.length)
      console.log(`[go-modules] license not recognised, check by hand: ${unknown.map((m) => m.path).join(', ')}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
