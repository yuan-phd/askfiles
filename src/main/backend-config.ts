import path from 'node:path';
import { chooseTier, loadPresets, presetSpawnEnv } from './presets/index.js';
import type { ProcessManagerConfig } from './process-manager/index.js';

export interface BundlePaths {
  /** process.resourcesPath: AskFiles.app/Contents/Resources in the packaged app. */
  resourcesPath: string;
  /** app.getPath('userData'): ~/Library/Application Support/AskFiles. */
  dataDir: string;
  /** app.getPath('logs'): ~/Library/Logs/AskFiles. */
  logDir: string;
  /** process.execPath: the Electron binary, which runs server and collector as Node. */
  nodePath: string;
  /** Extra server variables passed at every start, crash restarts included; see presetServerEnv. */
  serverEnv?: Record<string, string>;
  /** Browser origins allowed to call the server, the shell's own pages (patch 005). */
  allowedOrigins?: string[];
}

/**
 * The preset values the server must get in its spawn environment, for the tier this machine's RAM
 * selects. Upstream dumpENV rewrites server/.env on every settings change and drops
 * DEFAULT_REASONING_EFFORT (docs/presets.md), so the .env file alone would turn thinking back on.
 */
export function presetServerEnv(presetsFile: string, totalMemBytes: number): Record<string, string> {
  return presetSpawnEnv(chooseTier(loadPresets(presetsFile), totalMemBytes).preset);
}

/**
 * Process manager config for the packaged app. Folder names follow extraResources in
 * electron-builder.yml (server, collector and ollama directly under Resources).
 */
export function bundledBackendConfig(p: BundlePaths): ProcessManagerConfig {
  const server = path.join(p.resourcesPath, 'server');
  const collector = path.join(p.resourcesPath, 'collector');
  const asNode = { ELECTRON_RUN_AS_NODE: '1' };
  return {
    dataDir: p.dataDir,
    logDir: p.logDir,
    allowedOrigins: p.allowedOrigins ?? [],
    ollama: {
      command: path.join(p.resourcesPath, 'ollama', 'ollama'),
      args: ['serve'],
      cwd: p.dataDir,
      env: { OLLAMA_MODELS: path.join(p.dataDir, 'ollama') },
    },
    collector: { command: p.nodePath, args: [path.join(collector, 'index.js')], cwd: collector, env: asNode },
    migrate: {
      command: p.nodePath,
      args: [
        path.join(server, 'node_modules', 'prisma', 'build', 'index.js'),
        'migrate',
        'deploy',
        '--schema=./prisma/schema.prisma',
      ],
      cwd: server,
      env: { ...asNode, CHECKPOINT_DISABLE: '1' },
    },
    // The manager reuses this spec for every start and restart, and spec env wins over the .env file.
    server: {
      command: p.nodePath,
      args: [path.join(server, 'index.js')],
      cwd: server,
      env: { ...p.serverEnv, ...asNode },
    },
    signals: { term: 'SIGTERM', kill: 'SIGKILL' },
    // macOS and Linux have process groups; the ollama runner must die with ollama.
    killProcessGroup: true,
    // First launch on a cold disk: Ollama loads its libraries, the server builds its caches.
    timeoutsMs: { ollama: 60_000, server: 180_000 },
  };
}
