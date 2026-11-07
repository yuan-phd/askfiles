/**
 * The test build's main-process part (docs/test-build.md): the record, its IPC channels, the
 * wrapped bridge handlers that record adding files, and the test UI pages. Loaded by
 * src/main/test-build.ts loadTestBuild, which finds this file only in a test build.
 * askfiles-test-record-module (MODULE_MARKER in record.ts; scripts/check-test-record.mjs).
 */
import path from 'node:path';
import type { BridgeHandlers } from '../bridge/contract.js';
import type { IpcMainLike } from '../bridge/register.js';
import type { AddResult } from '../libraries.js';
import type { TestBuild, TestBuildDeps } from '../test-build.js';
import { TEST_RECORD_DATA_DIR } from '../test-build.js';
import { pageRecord, questionRecord, TestRecord, type AddRecord, type ExportMode, RECORD_VERSION } from './record.js';

export { MODULE_MARKER } from './record.js';

export const TITLE_SUFFIX = ' (test build)';

/** The test record's channels; repeated in preload.ts, which can load no module. */
export const TEST_CHANNELS = {
  status: 'askfiles-test:status',
  record: 'askfiles-test:record',
  pause: 'askfiles-test:pause',
  clear: 'askfiles-test:clear',
  export: 'askfiles-test:export',
  noticeShown: 'askfiles-test:notice-shown',
} as const;

/** The test UI is served at askfiles://app/test-record/... from the ui folder next to this file. */
export const ASSET_PREFIX = '/test-record/';

export function createTestBuild(d: TestBuildDeps, o: { uiDir?: string; now?: () => Date } = {}): TestBuild {
  const now = o.now ?? (() => new Date());
  const record = new TestRecord(path.join(d.dataDir, TEST_RECORD_DATA_DIR), { now });
  const uiDir = path.resolve(o.uiDir ?? path.join(__dirname, 'ui'));
  const log = (m: string) => d.log(`[test-record] ${m}`);
  const s = record.status();
  log(`test build: ${s.events} lines in ${record.file}${s.paused ? ', recording paused' : ''}`);

  const append = (line: Parameters<TestRecord['append']>[0]) => {
    try {
      record.append(line);
    } catch (e) {
      log(`could not write the record: ${(e as Error).message}`);
    }
  };
  const recordAdd = (kind: AddRecord['kind'], r: AddResult | null) => {
    // A cancelled dialog adds nothing and is not recorded.
    if (!r) return;
    append({
      v: RECORD_VERSION,
      type: 'add',
      time: now().toISOString(),
      library: d.libraryName(),
      kind,
      added: r.added,
      skipped: r.skipped.length,
    });
  };

  return {
    titleSuffix: TITLE_SUFFIX,
    preloadFile: path.join(__dirname, 'preload.js'),

    onAnswered(run) {
      append(questionRecord(run, d.libraryName(), now()));
    },

    wrapHandlers(h: BridgeHandlers): BridgeHandlers {
      const overrides: Partial<BridgeHandlers> = {
        librariesAddFiles: async () => {
          const r = await h.librariesAddFiles();
          recordAdd('files', r);
          return r;
        },
        librariesAddFolder: async () => {
          const r = await h.librariesAddFolder();
          recordAdd('folder', r);
          return r;
        },
        librariesAddPaths: async (paths) => {
          const r = await h.librariesAddPaths(paths);
          recordAdd('drop', r);
          return r;
        },
      };
      // A proxy, not a copy: the handlers are a class instance whose methods use its own state.
      return new Proxy(h, {
        get(target, prop) {
          if (typeof prop === 'string' && prop in overrides) return overrides[prop as keyof BridgeHandlers];
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
    },

    registerIpc(ipc: IpcMainLike) {
      // The platform tells the page whether the export is shown in Finder or in File Explorer.
      ipc.handle(TEST_CHANNELS.status, () => ({ ...record.status(), platform: d.platform }));
      ipc.handle(TEST_CHANNELS.record, (_e, input) => {
        const line = pageRecord(input, d.libraryName(), now());
        if (line) append(line);
        return line !== null;
      });
      ipc.handle(TEST_CHANNELS.pause, (_e, paused) => {
        const st = record.setPaused(paused === true);
        log(st.paused ? 'recording paused' : 'recording resumed');
        return st;
      });
      ipc.handle(TEST_CHANNELS.clear, () => {
        const st = record.clear();
        log('record cleared');
        return st;
      });
      ipc.handle(TEST_CHANNELS.export, (_e, mode) => {
        const m: ExportMode = mode === 'full' ? 'full' : 'questions';
        const file = record.export(m, d.desktopDir, { version: d.version, platform: d.platform });
        log(`exported ${m} to ${file}`);
        d.showItemInFolder(file);
        return { file };
      });
      ipc.handle(TEST_CHANNELS.noticeShown, () => record.noticeShown());
    },

    resolveAsset(pathname: string): string | null {
      if (!pathname.startsWith(ASSET_PREFIX) || pathname.includes('\0')) return null;
      const file = path.resolve(uiDir, '.' + pathname.slice(ASSET_PREFIX.length - 1));
      return file.startsWith(uiDir + path.sep) ? file : null;
    },
  };
}
