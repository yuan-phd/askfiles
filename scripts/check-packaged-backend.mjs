// Boots the packaged collector and server (not upstream/) under Electron's Node and runs the paths
// AskFiles uses: health, document upload through the collector (PDF, DOCX, XLSX, Markdown), OCR of an
// image, embedding into a workspace and one chat answer with sources. Every pruning step in
// scripts/prune.mjs must leave this green; it fails on any missing module.
//
// Usage: node scripts/check-packaged-backend.mjs [resources-dir]
//   resources-dir  holds server/ and collector/; default release/linux-unpacked/resources
// Environment:
//   ELECTRON       Electron binary run as Node; default node_modules/electron/dist/electron
//   OLLAMA_URL     default http://127.0.0.1:11434; needs CHECK_EMBED_MODEL and CHECK_CHAT_MODEL pulled
//   CHECK_EMBED_MODEL, CHECK_CHAT_MODEL   default all-minilm:latest and qwen3:0.6b
//   TESSDATA_DIR   folder with eng.traineddata (gzipped or not), copied to STORAGE_DIR/models/tesseract
//                  so OCR never downloads. Without it the OCR step is reported as skipped.
// Linux packaging: npm run build:main && PACKAGE_TARGET=linux-x64 bash scripts/build.sh && npx electron-builder --config electron-builder.yml --linux dir
/* global fetch, FormData, Blob -- Node 18+ globals, missing from the eslint node list */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RES = path.resolve(process.argv[2] ?? path.join(ROOT, 'release/linux-unpacked/resources'));
const ELECTRON = process.env.ELECTRON ?? path.join(ROOT, 'node_modules/electron/dist/electron');
const OLLAMA = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const EMBED_MODEL = process.env.CHECK_EMBED_MODEL ?? 'all-minilm:latest';
const CHAT_MODEL = process.env.CHECK_CHAT_MODEL ?? 'qwen3:0.6b';
const FIXTURES = path.join(ROOT, 'test/fixtures');

const log = (msg) => console.log(`[check-packaged-backend] ${msg}`);
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  log(`${ok === null ? 'SKIPPED' : ok ? 'ok' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(url, child, seconds) {
  for (let i = 0; i < seconds; i++) {
    if (child.exitCode !== null) return false;
    try {
      if ((await fetch(url)).status === 200) return true;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const children = [];
let work;
function cleanup() {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  if (work && !process.env.CHECK_KEEP) fs.rmSync(work, { recursive: true, force: true });
}

async function main() {
  for (const p of [path.join(RES, 'server/index.js'), path.join(RES, 'collector/index.js'), ELECTRON]) {
    if (!fs.existsSync(p)) throw new Error(`${p} is missing; see the usage at the top of this script`);
  }
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-packaged-'));
  const storage = path.join(work, 'storage');
  fs.mkdirSync(path.join(work, 'hotdir'), { recursive: true });
  fs.mkdirSync(path.join(work, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(work, 'server'), { recursive: true });
  fs.mkdirSync(storage, { recursive: true });
  const [serverPort, collectorPort] = [await freePort(), await freePort()];

  // Same variables the process manager sets (src/main/process-manager/manager.ts). The proxy
  // variables are dropped so a request that tries to leave the machine fails instead of passing.
  const base = { ...process.env };
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete base[k];
  const env = {
    ...base,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    STORAGE_DIR: storage,
    SERVER_PORT: String(serverPort),
    COLLECTOR_PORT: String(collectorPort),
    DISABLE_TELEMETRY: 'true',
    CHECKPOINT_DISABLE: '1',
    ANYTHING_LLM_BIND_HOST: '127.0.0.1',
    DATABASE_URL: `file:${path.join(storage, 'askfiles.db')}`,
    ANYTHING_LLM_HOTDIR: path.join(work, 'hotdir'),
    ANYTHING_LLM_COLLECTOR_TMP_DIR: path.join(work, 'tmp'),
    ANYTHING_LLM_ENV_PATH: path.join(work, 'server/.env'),
    ANYTHING_LLM_ALLOW_REMOTE_MODEL_DATA: 'false',
    JWT_SECRET: `check-${Math.random()}`,
    SIG_KEY: `check-key-${Math.random()}-${Math.random()}`,
    SIG_SALT: `check-salt-${Math.random()}-${Math.random()}`,
    VECTOR_DB: 'lancedb',
    LLM_PROVIDER: 'ollama',
    OLLAMA_BASE_PATH: OLLAMA,
    OLLAMA_MODEL_PREF: CHAT_MODEL,
    OLLAMA_MODEL_TOKEN_LIMIT: '4096',
    EMBEDDING_ENGINE: 'ollama',
    EMBEDDING_BASE_PATH: OLLAMA,
    EMBEDDING_MODEL_PREF: EMBED_MODEL,
    DEFAULT_REASONING_EFFORT: 'off',
  };

  if (process.env.TESSDATA_DIR) {
    const dest = path.join(storage, 'models/tesseract');
    fs.mkdirSync(dest, { recursive: true });
    const src = ['eng.traineddata', 'eng.traineddata.gz']
      .map((n) => path.join(process.env.TESSDATA_DIR, n))
      .find((p) => fs.existsSync(p));
    if (!src) throw new Error(`no eng.traineddata in ${process.env.TESSDATA_DIR}`);
    fs.copyFileSync(src, path.join(dest, 'eng.traineddata'));
  }

  const runLog = (name) => fs.openSync(path.join(work, `${name}.log`), 'a');
  const t0 = Date.now();
  const migrate = spawnSync(
    ELECTRON,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--schema=./prisma/schema.prisma'],
    { cwd: path.join(RES, 'server'), env, encoding: 'utf8' },
  );
  record('prisma migrate deploy', migrate.status === 0, migrate.status === 0 ? null : migrate.stderr.slice(-400));
  if (migrate.status !== 0) return;

  for (const name of ['collector', 'server']) {
    const fd = runLog(name);
    const child = spawn(ELECTRON, ['index.js'], { cwd: path.join(RES, name), env, stdio: ['ignore', fd, fd] });
    children.push(child);
    const url =
      name === 'server' ? `http://127.0.0.1:${serverPort}/api/ping` : `http://127.0.0.1:${collectorPort}/accepts`;
    const ok = await waitFor(url, child, 120);
    record(`${name} healthy`, ok, ok ? `${Date.now() - t0} ms after start` : tail(path.join(work, `${name}.log`)));
    if (!ok) return;
  }

  const api = `http://127.0.0.1:${serverPort}/api`;
  const key = (
    await (
      await fetch(`${api}/system/generate-api-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'check' }),
      })
    ).json()
  ).apiKey.secret;
  const auth = { Authorization: `Bearer ${key}` };

  // Each file with a word its parsed text must contain.
  const uploads = [
    ['eval-s/corpus/it-handbook.pdf', null],
    ['eval-s/corpus/报销制度.docx', null],
    ['eval-s/corpus/budget-2026.xlsx', null],
    ['eval-s/corpus/leave-policy-v1.md', null],
    ['ocr-sample.png', 'Mercury'],
  ];
  const locations = [];
  for (const [rel, word] of uploads) {
    const name = path.basename(rel);
    if (name.endsWith('.png') && !process.env.TESSDATA_DIR) {
      record(`upload and parse ${name}`, null, 'TESSDATA_DIR not set');
      continue;
    }
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(path.join(FIXTURES, rel))]), name);
    const t = Date.now();
    const res = await (await fetch(`${api}/v1/document/upload`, { method: 'POST', headers: auth, body: form })).json();
    const doc = res.documents?.[0];
    const text = doc?.pageContent ?? '';
    const ok = res.success === true && text.length > 0 && (!word || text.includes(word));
    record(
      `upload and parse ${name}`,
      ok,
      ok ? `${text.length} characters in ${Date.now() - t} ms` : (res.error ?? 'no text'),
    );
    if (ok) locations.push(doc.location);
  }

  let models = null;
  try {
    models = (await (await fetch(`${OLLAMA}/api/tags`)).json()).models.map((m) => m.name);
  } catch {
    // reported below
  }
  if (!models || !models.includes(EMBED_MODEL) || !models.includes(CHAT_MODEL)) {
    record('embedding and chat', false, `Ollama at ${OLLAMA} must serve ${EMBED_MODEL} and ${CHAT_MODEL}`);
    return;
  }

  const ws = (
    await (
      await fetch(`${api}/v1/workspace/new`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'check' }),
      })
    ).json()
  ).workspace;
  const t1 = Date.now();
  const embed = await fetch(`${api}/v1/workspace/${ws.slug}/update-embeddings`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ adds: locations, deletes: [] }),
  });
  const embedded = (await embed.json()).workspace?.documents?.length ?? 0;
  record(
    'embed into a workspace',
    embed.status === 200 && embedded === locations.length,
    `${embedded} of ${locations.length} documents in ${Date.now() - t1} ms`,
  );

  const t2 = Date.now();
  const chat = await (
    await fetch(`${api}/v1/workspace/${ws.slug}/chat`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'How many days of annual leave do employees get?', mode: 'query' }),
    })
  ).json();
  const sources = chat.sources?.length ?? 0;
  record(
    'chat answer with sources',
    !chat.error && !!chat.textResponse?.trim() && sources > 0,
    `${sources} sources in ${Date.now() - t2} ms${chat.error ? `, error ${chat.error}` : ''}`,
  );
}

function tail(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').slice(-25).join('\n');
  } catch {
    return 'no log';
  }
}

try {
  await main();
} catch (err) {
  record('check ran', false, err.message);
} finally {
  cleanup();
}
const failed = results.filter((r) => r.ok === false);
log(failed.length ? `${failed.length} failed` : 'all checks passed');
process.exit(failed.length ? 1 : 0);
