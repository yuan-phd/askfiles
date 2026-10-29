import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Where the collector's OCR looks for language data before it downloads any: tesseract.js reads
 * <STORAGE_DIR>/models/tesseract/<lang>.traineddata (docs/upstream-analysis.md Q14).
 */
export function tesseractCacheDir(storageDir: string): string {
  return path.join(storageDir, 'models', 'tesseract');
}

/**
 * The shipped copy of one language: @tesseract.js-data/<lang>, the same 4.0.0_best_int files
 * tesseract.js would fetch from its CDN. The packages are runtime dependencies of the shell, so
 * they sit in app.asar, which Electron's fs and require read like a folder.
 */
export function shippedTraineddata(lang: string): string | null {
  try {
    const dir = path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
    const file = path.join(dir, '4.0.0_best_int', `${lang}.traineddata.gz`);
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

export interface SeedResult {
  seeded: string[];
  present: string[];
  missing: string[];
}

/**
 * Copies each language in langs (TARGET_OCR_LANG, comma separated) into the OCR cache unless it is
 * already there, so OCR never downloads. Written unpacked, as tesseract.js caches what it
 * downloads; it would also accept the gzip. A language with no shipped file is reported, not
 * thrown: the app still starts, and the caller logs it as a broken bundle.
 */
export function seedTesseractData(o: {
  langs: string;
  storageDir: string;
  source?: (lang: string) => string | null;
}): SeedResult {
  const source = o.source ?? shippedTraineddata;
  const dir = tesseractCacheDir(o.storageDir);
  fs.mkdirSync(dir, { recursive: true });
  const result: SeedResult = { seeded: [], present: [], missing: [] };
  const langs = [
    ...new Set(
      o.langs
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
  for (const lang of langs) {
    const target = path.join(dir, `${lang}.traineddata`);
    if (fs.existsSync(target) && fs.statSync(target).size > 0) {
      result.present.push(lang);
      continue;
    }
    const from = source(lang);
    if (!from) {
      result.missing.push(lang);
      continue;
    }
    let data = fs.readFileSync(from);
    if (data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data);
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
    result.seeded.push(lang);
  }
  return result;
}
