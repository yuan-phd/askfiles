import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedTesseractData, shippedTraineddata, tesseractCacheDir } from './tesseract.js';

let storage: string;
beforeEach(() => {
  storage = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-tess-'));
});
afterEach(() => {
  fs.rmSync(storage, { recursive: true, force: true });
});

describe('tesseract language data', () => {
  it('finds the shipped eng and chi_sim files', () => {
    for (const lang of ['eng', 'chi_sim']) {
      expect(shippedTraineddata(lang)).toMatch(
        new RegExp(`@tesseract\\.js-data/${lang}/4\\.0\\.0_best_int/${lang}\\.traineddata\\.gz$`),
      );
    }
    expect(shippedTraineddata('deu')).toBeNull();
  });

  it('seeds the preset languages unpacked into STORAGE_DIR/models/tesseract, once', () => {
    const r = seedTesseractData({ langs: 'eng,chi_sim', storageDir: storage });
    expect(r).toEqual({ seeded: ['eng', 'chi_sim'], present: [], missing: [] });
    const eng = path.join(tesseractCacheDir(storage), 'eng.traineddata');
    expect(fs.readFileSync(eng).equals(zlib.gunzipSync(fs.readFileSync(shippedTraineddata('eng')!)))).toBe(true);
    const mtime = fs.statSync(eng).mtimeMs;
    expect(seedTesseractData({ langs: 'eng, chi_sim', storageDir: storage })).toEqual({
      seeded: [],
      present: ['eng', 'chi_sim'],
      missing: [],
    });
    expect(fs.statSync(eng).mtimeMs).toBe(mtime);
  });

  it('reports a language the bundle lacks and replaces an empty file', () => {
    const dir = tesseractCacheDir(storage);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'eng.traineddata'), '');
    const r = seedTesseractData({ langs: 'eng,deu', storageDir: storage });
    expect(r).toEqual({ seeded: ['eng'], present: [], missing: ['deu'] });
    expect(fs.statSync(path.join(dir, 'eng.traineddata')).size).toBeGreaterThan(1_000_000);
    expect(fs.readdirSync(dir)).toEqual(['eng.traineddata']);
  });
});
