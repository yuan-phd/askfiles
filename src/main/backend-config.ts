import nodePath from 'node:path';
import { chooseTier, loadPresets, presetSpawnEnv } from './presets/index.js';
import type { ProcessManagerConfig } from './process-manager/index.js';

export interface BundlePaths {
  /**
   * process.platform of the app; injected so both configurations are tested everywhere. Default
   * darwin. Only win32 differs: ollama.exe, a tree kill instead of process groups, Windows paths.
   */
  platform?: NodeJS.Platform;
  /** %SystemRoot% on Windows, for taskkill.exe; default C:\Windows. */
  systemRoot?: string;
  /**
   * process.resourcesPath: AskFiles.app/Contents/Resources on the Mac, the resources folder next
   * to AskFiles.exe on Windows.
   */
  resourcesPath: string;
  /** app.getPath('userData'): ~/Library/Application Support/AskFiles, %LOCALAPPDATA%\AskFiles on Windows. */
  dataDir: string;
  /** app.getPath('logs'): ~/Library/Logs/AskFiles, %LOCALAPPDATA%\AskFiles\logs on Windows. */
  logDir: string;
  /** process.execPath: the Electron binary (AskFiles.exe on Windows), which runs server and collector as Node. */
  nodePath: string;
  /** Extra server variables passed at every start, crash restarts included; see presetServerEnv. */
  serverEnv?: Record<string, string>;
  /** Browser origins allowed to call the server, the shell's own pages (patch 005). */
  allowedOrigins?: string[];
  /** A dev run: use the Ollama already on this port instead of the bundled one. */
  externalOllamaPort?: number;
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
 * The bundled Ollama's environment. Read from the source of the bundled version (v0.40.4):
 * - OLLAMA_NO_CLOUD=1 stops the two requests `ollama serve` makes to ollama.com at every start and
 *   on a retry timer (model recommendations, server/model_recommendations.go; cloud model show
 *   cache, server/model_show_cache.go) and refuses cloud models and web search. The other way to
 *   set it, disable_ollama_cloud in ~/.ollama/server.json, is a user's file we must not rely on.
 * - OLLAMA_REMOTES=127.0.0.1: models whose config names a remote host may only point at this
 *   machine; the default allows ollama.com.
 * - HOME (and USERPROFILE on Windows, which Go's os.UserHomeDir reads there) points into the data
 *   directory. Ollama has no setting for its own folder: everything outside OLLAMA_MODELS goes to
 *   ~/.ollama (the signing key id_ed25519, server.json, cache/model-recommendations.json). Without
 *   this the bundled Ollama shared the user's own Ollama key and files.
 * Model pulls (the wizard, the models page) still reach the registry; nothing else in `serve` does,
 * and the app updater lives only in Ollama's desktop app, which is not bundled.
 */
export function bundledOllamaEnv(dataDir: string, windows: boolean): Record<string, string> {
  const path = windows ? nodePath.win32 : nodePath.posix;
  const home = path.join(dataDir, 'ollama-home');
  return {
    OLLAMA_MODELS: path.join(dataDir, 'ollama'),
    OLLAMA_NO_CLOUD: '1',
    OLLAMA_REMOTES: '127.0.0.1',
    HOME: home,
    ...(windows ? { USERPROFILE: home } : {}),
  };
}

/**
 * Process manager config for the packaged app. Folder names follow extraResources in
 * electron-builder.yml (server, collector and ollama directly under Resources).
 */
export function bundledBackendConfig(p: BundlePaths): ProcessManagerConfig {
  const windows = p.platform === 'win32';
  const path = windows ? nodePath.win32 : nodePath.posix;
  const server = path.join(p.resourcesPath, 'server');
  const collector = path.join(p.resourcesPath, 'collector');
  const asNode = { ELECTRON_RUN_AS_NODE: '1' };
  return {
    dataDir: p.dataDir,
    logDir: p.logDir,
    allowedOrigins: p.allowedOrigins ?? [],
    ...(p.externalOllamaPort
      ? { externalOllamaPort: p.externalOllamaPort }
      : {
          ollama: {
            command: path.join(p.resourcesPath, 'ollama', windows ? 'ollama.exe' : 'ollama'),
            args: ['serve'],
            cwd: p.dataDir,
            env: bundledOllamaEnv(p.dataDir, windows),
          },
        }),
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
    ...(windows
      ? {
          // No signals or process groups on Windows: taskkill /T ends ollama.exe with its runners.
          treeKill: {
            command: path.join(p.systemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
            args: ['/PID', '{pid}', '/T', '/F'],
          },
        }
      : {
          // macOS and Linux have process groups; the ollama runner must die with ollama.
          killProcessGroup: true,
        }),
    // First launch on a cold disk: Ollama loads its libraries, the server builds its caches.
    timeoutsMs: { ollama: 60_000, server: 180_000 },
  };
}
