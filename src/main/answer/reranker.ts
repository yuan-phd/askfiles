/**
 * The cross-encoder that scores question and section together. It runs in the shell process with
 * @xenova/transformers loaded from the server's own node_modules (the same copy upstream's reranker
 * uses), so the shell adds no dependency and the bundle carries the library once. The model files
 * come from <dataDir>/models/reranker, put there by the first-run wizard (ensureReranker).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rerankerBytes, rerankerModel, type RerankerModel } from './reranker-models.js';

export interface Reranker {
  /** One score from 0 to 1 per text, in the order given. */
  score(query: string, texts: string[]): Promise<number[]>;
}

export interface DownloadProgress {
  model: string;
  status: string;
  completedBytes: number;
  totalBytes: number;
  percent: number;
}

export const HF_HOST = 'https://huggingface.co';
/** Marker written after every file of a model checked out; holds the revision. */
const MARKER = '.askfiles-verified.json';
/** Texts scored per model call; memory per call grows with it (upstream uses 10). */
const BATCH = 4;
const MAX_TOKENS = 512;

export function rerankerDir(modelsDir: string, repo: string): string {
  return path.join(modelsDir, ...repo.split('/'));
}

/** True when every file of the model is present with its size and the marker names the revision. */
export function rerankerReady(modelsDir: string, repo: string): boolean {
  const m = rerankerModel(repo);
  const dir = rerankerDir(modelsDir, repo);
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')) as { revision?: string };
    if (marker.revision !== m.revision) return false;
    return m.files.every((f) => fs.statSync(path.join(dir, f.path)).size === f.size);
  } catch {
    return false;
  }
}

/**
 * Downloads the model's files from Hugging Face at the pinned revision unless already present,
 * checking each file's sha256 before it takes its final name. Progress counts bytes over all
 * files; a file already in place counts as done.
 */
export async function ensureReranker(o: {
  repo: string;
  modelsDir: string;
  onProgress?: (p: DownloadProgress) => void;
  fetch?: typeof globalThis.fetch;
  host?: string;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}): Promise<void> {
  const m = rerankerModel(o.repo);
  const total = rerankerBytes(m);
  const report = (status: string, completed: number) =>
    o.onProgress?.({
      model: m.label,
      status,
      completedBytes: completed,
      totalBytes: total,
      percent: status === 'success' ? 100 : Math.min(99, Math.floor((completed * 100) / total)),
    });
  if (rerankerReady(o.modelsDir, o.repo)) {
    report('already installed', total);
    return;
  }
  const dir = rerankerDir(o.modelsDir, o.repo);
  const fetchImpl = o.fetch ?? globalThis.fetch;
  let done = 0;
  for (const f of m.files) {
    const target = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target) && fs.statSync(target).size === f.size && (await fileSha256(target)) === f.sha256) {
      done += f.size;
      report('verifying', done);
      continue;
    }
    const url = `${o.host ?? HF_HOST}/${m.repo}/resolve/${m.revision}/${f.path}`;
    o.log?.(`downloading ${url}`);
    const res = await fetchImpl(url, { signal: o.signal });
    if (!res.ok || !res.body) throw new Error(`download of ${m.label} ${f.path} failed: HTTP ${res.status}`);
    const part = `${target}.part`;
    const out = fs.createWriteStream(part);
    const hash = createHash('sha256');
    let got = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        hash.update(value);
        got += value.byteLength;
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        report(`downloading ${f.path}`, done + got);
      }
    } finally {
      await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    }
    const sha = hash.digest('hex');
    if (got !== f.size || sha !== f.sha256) {
      fs.rmSync(part, { force: true });
      throw new Error(`download of ${m.label} ${f.path} is damaged (${got} bytes, sha256 ${sha.slice(0, 12)})`);
    }
    fs.renameSync(part, target);
    done += f.size;
  }
  fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({ revision: m.revision, at: new Date().toISOString() }));
  report('success', total);
}

async function fileSha256(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

interface Transformers {
  env: { allowRemoteModels: boolean; localModelPath: string };
  AutoTokenizer: { from_pretrained(name: string): Promise<Tokenizer> };
  AutoModelForSequenceClassification: {
    from_pretrained(name: string, o: { quantized: boolean }): Promise<(inputs: unknown) => Promise<{ logits: Logits }>>;
  };
}
type Tokenizer = (
  texts: string[],
  o: { text_pair: string[]; padding: boolean; truncation: boolean; max_length: number },
) => unknown;
interface Logits {
  sigmoid(): { tolist(): number[][] };
}

/** Imports @xenova/transformers from a package folder, through its package.json main. */
async function loadTransformers(packageDir: string): Promise<Transformers> {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { main?: string };
  return (await import(pathToFileURL(path.join(packageDir, pkg.main ?? 'src/transformers.js')).href)) as Transformers;
}

/**
 * A reranker over local files only: remote models are switched off, so a missing file is an error,
 * never a download. Loads on the first call; one instance per model is enough for the app.
 */
export function crossEncoder(o: {
  transformersDir: string;
  modelsDir: string;
  repo: string;
  log?: (m: string) => void;
}): Reranker & {
  model: RerankerModel;
} {
  const model = rerankerModel(o.repo);
  let loading: Promise<{ tokenizer: Tokenizer; run: (inputs: unknown) => Promise<{ logits: Logits }> }> | null = null;
  const load = () =>
    (loading ??= (async () => {
      if (!rerankerReady(o.modelsDir, o.repo)) {
        throw new Error(`the reranker ${model.label} is not installed in ${o.modelsDir}`);
      }
      const t0 = performance.now();
      const t = await loadTransformers(o.transformersDir);
      t.env.allowRemoteModels = false;
      t.env.localModelPath = o.modelsDir;
      const tokenizer = await t.AutoTokenizer.from_pretrained(o.repo);
      const run = await t.AutoModelForSequenceClassification.from_pretrained(o.repo, { quantized: true });
      o.log?.(`[answer] reranker ${model.label} loaded in ${Math.round(performance.now() - t0)} ms`);
      return { tokenizer, run };
    })().catch((e: unknown) => {
      loading = null;
      throw e;
    }));
  return {
    model,
    async score(query, texts) {
      if (!texts.length) return [];
      const { tokenizer, run } = await load();
      const out: number[] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH);
        const inputs = tokenizer(new Array<string>(batch.length).fill(query), {
          text_pair: batch,
          padding: true,
          truncation: true,
          max_length: MAX_TOKENS,
        });
        const { logits } = await run(inputs);
        for (const [s] of logits.sigmoid().tolist()) out.push(s!);
      }
      return out;
    },
  };
}
