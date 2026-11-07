import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { BridgeHandlers } from './bridge/contract.js';
import type { IpcMainLike } from './bridge/register.js';
import type { AnsweredRun } from './answer/service.js';

/**
 * The test build (docs/test-build.md). Its question log lives in src/main/test-record and
 * src/renderer/test-record, which only the test build compiles and packages
 * (scripts/build-main.mjs --flavour test); the release build has none of it, and
 * scripts/check-test-record.mjs fails CI if it finds any in the packaged release app. What stays
 * in every build is this file: the loader, which finds nothing in a release build, and the
 * cleanup, which removes a record a test build left in the shared data directory.
 */

/** Folder in the data directory that holds the test build's record and its settings. */
export const TEST_RECORD_DATA_DIR = 'test-record';

/** What the test build's module gives the main process (src/main/test-record/index.ts). */
export interface TestBuild {
  /** Appended to every window title. */
  readonly titleSuffix: string;
  /** Extra preload script for every window: exposes window.askfilesTest and loads the test UI. */
  readonly preloadFile: string;
  /** The answer service's observer: one record per question. */
  onAnswered(run: AnsweredRun): void;
  /** The bridge handlers with adding files recorded. */
  wrapHandlers(h: BridgeHandlers): BridgeHandlers;
  /** The test record's own IPC channels. */
  registerIpc(ipc: IpcMainLike): void;
  /** The file for an askfiles://app/test-record/... path, or null for every other path. */
  resolveAsset(pathname: string): string | null;
}

export interface TestBuildDeps {
  dataDir: string;
  desktopDir: string;
  version: string;
  platform: NodeJS.Platform;
  log(message: string): void;
  /** Reveals the exported file in Finder or Explorer. */
  showItemInFolder(file: string): void;
  /** The current library's display name, for each record. */
  libraryName(): string | null;
}

export interface TestBuildModule {
  createTestBuild(d: TestBuildDeps): TestBuild;
}

/** The test build's module next to this file, or null in a release build, where it is not compiled. */
export function loadTestBuild(
  mainDir: string,
  load: (file: string) => unknown = (file) => createRequire(file)(file),
): TestBuildModule | null {
  const file = path.join(mainDir, 'test-record', 'index.js');
  if (!fs.existsSync(file)) return null;
  return load(file) as TestBuildModule;
}

/**
 * Release build only, at every start: a test build installed before this one shares the data
 * directory and may have left its record there; it is deleted, with one log line. Returns true
 * when something was removed. A failure is logged and never stops the app.
 */
export function removeTestRecord(dataDir: string, log: (message: string) => void): boolean {
  const dir = path.join(dataDir, TEST_RECORD_DATA_DIR);
  if (!fs.existsSync(dir)) return false;
  try {
    const files = fs.readdirSync(dir).length;
    fs.rmSync(dir, { recursive: true, force: true });
    log(`[test-record] release build removed the test record and its settings left by a test build (${files} files)`);
    return true;
  } catch (e) {
    log(`[test-record] release build could not remove the test record in ${dir}: ${(e as Error).message}`);
    return false;
  }
}
