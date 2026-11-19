import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearStartMarker, readStartMarker, START_MARKER_FILE, writeStartMarker } from './startup-marker.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-marker-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('start marker', () => {
  it('is written, read back and cleared; a data folder without one reads as none', () => {
    expect(readStartMarker(dir)).toBeNull();
    writeStartMarker(dir, 'lib-abc123', new Date('2026-11-19T08:00:00.000Z'));
    expect(readStartMarker(dir)).toEqual({ libraryId: 'lib-abc123', startedAt: '2026-11-19T08:00:00.000Z' });
    expect(fs.readdirSync(dir)).toEqual([START_MARKER_FILE]);
    clearStartMarker(dir);
    expect(readStartMarker(dir)).toBeNull();
    clearStartMarker(dir);
  });

  it('reads a broken or foreign marker as none', () => {
    for (const text of ['', '{', '[]', '{"libraryId":""}', '{"libraryId":7}']) {
      fs.writeFileSync(path.join(dir, START_MARKER_FILE), text);
      expect(readStartMarker(dir), text).toBeNull();
    }
    fs.writeFileSync(path.join(dir, START_MARKER_FILE), '{"libraryId":"all-files"}');
    expect(readStartMarker(dir)).toEqual({ libraryId: 'all-files', startedAt: '' });
  });
});
