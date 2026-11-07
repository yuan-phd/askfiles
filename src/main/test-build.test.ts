// The part of the test build every build has (docs/test-build.md): the loader finds the module only
// where a test build compiled it, and the release build removes a record a test build left behind.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadTestBuild, removeTestRecord, TEST_RECORD_DATA_DIR } from './test-build.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-test-build-'));
  dirs.push(d);
  return d;
}

describe('loadTestBuild', () => {
  it('finds nothing in a release build', () => {
    const loaded: string[] = [];
    expect(loadTestBuild(tmp(), (f) => loaded.push(f))).toBeNull();
    expect(loaded).toEqual([]);
  });

  it('loads the test record module of a test build', () => {
    const main = tmp();
    fs.mkdirSync(path.join(main, 'test-record'));
    fs.writeFileSync(path.join(main, 'test-record', 'index.js'), 'exports.createTestBuild = () => "made";\n');
    const mod = loadTestBuild(main);
    expect(mod?.createTestBuild({} as never)).toBe('made');
  });
});

describe('release build cleanup', () => {
  it('deletes the test record and its settings with one log line', () => {
    const data = tmp();
    const dir = path.join(data, TEST_RECORD_DATA_DIR);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'record.jsonl'), '{"type":"question"}\n');
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"paused":false,"noticeShown":true}\n');
    fs.writeFileSync(path.join(data, 'shell.json'), '{}');
    const logs: string[] = [];
    expect(removeTestRecord(data, (m) => logs.push(m))).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    // Nothing else in the data directory is touched.
    expect(fs.existsSync(path.join(data, 'shell.json'))).toBe(true);
    expect(logs).toEqual([
      '[test-record] release build removed the test record and its settings left by a test build (2 files)',
    ]);
  });

  it('does nothing and logs nothing when no test build ran', () => {
    const logs: string[] = [];
    expect(removeTestRecord(tmp(), (m) => logs.push(m))).toBe(false);
    expect(logs).toEqual([]);
  });
});
