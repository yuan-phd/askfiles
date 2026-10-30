import { app, dialog, shell, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import {
  AnswerService,
  crossEncoder,
  ensureReranker,
  ollamaChat,
  rerankerReady,
  upstreamVectorSearch,
  type AnswerScope,
  type DeveloperOverrides,
  type EvalCase,
  type PipelineDeps,
  type Reranker,
  type RunSettings,
  type ServiceEvent,
} from './answer/index.js';
import { APP_ORIGIN, pageUrl, type PageName } from './app-protocol.js';
import { chooseStartPage, presetFolder, presetsFilePath, type StartPage } from './app-mode.js';
import { bundledBackendConfig } from './backend-config.js';
import { BrowseIndex, chunkReader, followWatcher, type DocumentRef } from './browse/index.js';
import { CHANNELS, type BridgeHandlers, type WatcherView } from './bridge/contract.js';
import type { Env, Logger } from './config.js';
import { FirstRun } from './first-run.js';
import { ensureApiKey, ensureLibrary } from './library.js';
import { ModelManager } from './models/index.js';
import { OllamaClient } from './ollama/index.js';
import { findOriginal } from './open-original.js';
import { messagePage } from './message-page.js';
import { chooseTier, loadPresets, presetSpawnEnv, workspaceSettings, type Preset } from './presets/index.js';
import { ProcessManager } from './process-manager/index.js';
import { loadShellState, saveShellState, type ShellState } from './shell-state.js';
import { seedTesseractData } from './tesseract.js';
import { chokidarWatch, collectorOcr, createLibraryApi, FolderWatcher, sectionSplitter } from './watcher/index.js';
import { Wizard } from './wizard/index.js';

export interface AppDeps {
  win: BrowserWindow;
  log: Logger;
  env: Env;
  /** Sends an event to every open window. */
  broadcast(channel: string, payload: unknown): void;
}

/**
 * The packaged app: starts Ollama, collector and server from the bundle, then shows onboarding on
 * the first launch and the Ask page afterwards, with the folder watcher running behind it.
 * Implements the bridge handlers the pages call through the preload script.
 */
export class AppController implements BridgeHandlers {
  private readonly dataDir = app.getPath('userData');
  private readonly storageDir = path.join(this.dataDir, 'storage');
  private manager: ProcessManager | null = null;
  private preset: Preset | null = null;
  private state: ShellState;
  private firstRun: FirstRun | null = null;
  private watcher: FolderWatcher | null = null;
  private watcherError: string | null = null;
  private browse: BrowseIndex | null = null;
  private page: StartPage | PageName | null = null;
  private stopped = false;
  private readonly rerankerDir = path.join(this.dataDir, 'models', 'reranker');
  private reranker: { repo: string; instance: Reranker } | null = null;
  private readonly answers: AnswerService;

  constructor(private readonly d: AppDeps) {
    this.state = loadShellState(this.dataDir, d.log);
    this.answers = new AnswerService({
      pipeline: () => this.pipelineDeps(),
      settings: () => this.runSettings(),
      developer: d.env.ASKFILES_DEVELOPER === '1',
      evalQuestionsFile: d.env.ASKFILES_EVAL_QUESTIONS || path.join(this.dataDir, 'eval-questions.csv'),
      log: d.log,
    });
  }

  /** The origin the window may show besides askfiles://app: the server, in upstream UI mode only. */
  upstreamOrigin(): string | null {
    return this.page === 'upstream' ? this.serverUrl() : null;
  }

  /** True once the Ask page is the window content; the models window needs a set-up library. */
  setUp(): boolean {
    return this.page === 'ask';
  }

  async run(): Promise<void> {
    const { log, win } = this.d;
    let serverEnv: Record<string, string>;
    try {
      const file = presetsFilePath(this.d.env, app.getAppPath());
      const tier = chooseTier(loadPresets(file), os.totalmem());
      this.preset = tier.preset;
      // Without the preset the server would run with thinking on; a broken bundle must show, not limp.
      serverEnv = presetSpawnEnv(tier.preset);
      log(`preset ${tier.preset.id} from ${file}`);
    } catch (e) {
      log(`backend not started: ${(e as Error).message}`);
      void win.loadURL(messagePage('AskFiles could not start.', (e as Error).message));
      return;
    }

    try {
      const seed = seedTesseractData({ langs: this.preset.ocrLanguages, storageDir: this.storageDir });
      log(`ocr data seeded [${seed.seeded}] present [${seed.present}]`);
      if (seed.missing.length) log(`ocr data missing from the bundle: ${seed.missing.join(', ')}`);
    } catch (e) {
      log(`ocr data not seeded: ${(e as Error).message}`);
    }

    const start = chooseStartPage(this.d.env, this.state);
    log(`start page ${start}`);
    this.manager = new ProcessManager(
      bundledBackendConfig({
        resourcesPath: process.resourcesPath,
        dataDir: this.dataDir,
        logDir: app.getPath('logs'),
        nodePath: process.execPath,
        serverEnv,
        allowedOrigins: [APP_ORIGIN],
      }),
    );
    this.manager.on('state', (e) => {
      if (e.state !== 'healthy' && e.state !== 'starting')
        log(`backend ${e.process} ${e.state}${e.detail ? ` (${e.detail})` : ''}`);
    });
    this.holdQuitUntilStopped();

    log('starting backend');
    try {
      const s = await this.manager.start();
      log(`backend running, server on ${s.ports!.server}`);
    } catch (e) {
      const first = (e as Error).message.split('\n')[0]!;
      log(`backend failed: ${first}`);
      void win.loadURL(messagePage('AskFiles could not start its search engine.', first));
      return;
    }

    if (start === 'upstream') {
      this.page = 'upstream';
      log('opening the upstream interface (developer switch)');
      void win.loadURL(this.serverUrl()! + '/');
    } else if (start === 'ask') {
      // The page first, so a large folder's reconcile does not keep the start page up.
      this.show('ask');
      void this.fetchMissingReranker();
      await this.startLibraryWatcher();
    } else {
      this.firstRun = this.createFirstRun();
      this.show('onboarding');
    }
  }

  // --- bridge handlers -------------------------------------------------------------------------

  shellConfig() {
    return {
      baseUrl: this.serverUrl(),
      apiKey: this.state.apiKey,
      workspace: this.state.workspaceSlug,
      folder: this.state.folder,
    };
  }

  setupReplay() {
    return this.firstRun?.replay() ?? [];
  }

  setupStart() {
    if (!this.firstRun) throw new Error('setup is already complete');
    return this.firstRun.start();
  }

  setupRetry() {
    if (!this.firstRun) throw new Error('setup is already complete');
    return this.firstRun.retry();
  }

  async setupChooseFolder() {
    if (!this.firstRun) throw new Error('setup is already complete');
    const r = await dialog.showOpenDialog(this.d.win, {
      title: 'Choose your documents folder',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory'],
    });
    const folder = r.canceled ? undefined : r.filePaths[0];
    if (!folder) return null;
    this.firstRun.setFolder(folder);
    return { folder };
  }

  modelsList() {
    return this.modelManager().list();
  }

  modelsPull(tag: string) {
    return this.modelManager().pull(tag, (p) => this.d.broadcast(CHANNELS.modelsProgress, p));
  }

  modelsRemove(tag: string) {
    return this.modelManager().remove(tag);
  }

  modelsSwitchChat(tag: string) {
    return this.modelManager().switchChatModel(tag);
  }

  watcherStatus(): WatcherView | null {
    if (this.watcher) return { ...this.watcher.status(), folder: this.state.folder };
    if (this.watcherError) {
      return {
        state: 'stopped',
        pending: 0,
        current: null,
        indexed: 0,
        deadLetters: [],
        folder: this.state.folder,
        error: this.watcherError,
      };
    }
    return null;
  }

  libraryResolveSources(sources: Parameters<BridgeHandlers['libraryResolveSources']>[0]) {
    return this.watcher ? this.watcher.resolveSources(sources) : sources;
  }

  async libraryOpenOriginal(source: Parameters<BridgeHandlers['libraryOpenOriginal']>[0]) {
    const file = this.watcher ? findOriginal(source, this.watcher.files()) : null;
    if (!file || !fs.existsSync(file)) {
      this.d.log(`open original: no indexed file for ${JSON.stringify(source.title ?? source.url ?? null)}`);
      return false;
    }
    shell.showItemInFolder(file);
    return true;
  }

  browseDocuments() {
    return this.browse?.listDocuments() ?? [];
  }

  browseDocument(ref: DocumentRef) {
    return this.browse?.getDocument(ref) ?? null;
  }

  browseHeadings(key: string | null) {
    return this.browse?.headings({ key }) ?? [];
  }

  browseSearch(query: string) {
    return this.browse?.search(query) ?? { query, terms: [], total: 0, groups: [], truncated: false };
  }

  answerAsk(question: string, emit: (e: ServiceEvent) => void) {
    return this.answers.ask(question, emit);
  }

  answerCancel(id: string) {
    this.answers.cancel(id);
  }

  answerDeveloper() {
    return this.answers.developerState();
  }

  answerSetOverrides(o: DeveloperOverrides) {
    return this.answers.setOverrides(o);
  }

  answerSaveCase(c: EvalCase) {
    return this.answers.saveEvalCase(c);
  }

  appInfo() {
    return { name: 'AskFiles', version: app.getVersion() };
  }

  appPageReady(info: { page: string; connected?: boolean; documents?: number | null }) {
    // The smoke test waits for this line to know the Ask page reached the library.
    this.d.log(`page ready ${info.page} connected=${info.connected ?? '-'} documents=${info.documents ?? '-'}`);
    const question = this.d.env.ASKFILES_SMOKE_QUESTION;
    if (question && info.page === 'ask' && info.connected) void this.smokeAnswer(question);
  }

  // --- internals -------------------------------------------------------------------------------

  /** Answer scope from the settings store (Session K); Balanced until that store exists. */
  private answerScope(): AnswerScope {
    return 'balanced';
  }

  /** The chat model the server .env names (the model page may have switched it), else the preset's. */
  private chatModel(): string {
    try {
      const env = util.parseEnv(fs.readFileSync(this.envFile(), 'utf8')) as Record<string, string>;
      if (env.OLLAMA_MODEL_PREF) return env.OLLAMA_MODEL_PREF;
    } catch {
      // No .env yet: the preset decides.
    }
    return this.preset!.chatModel;
  }

  private runSettings(): RunSettings {
    const p = this.preset;
    if (!p) throw new Error('AskFiles has not loaded its settings yet');
    return {
      params: p.answer,
      scope: this.answerScope(),
      chatModel: this.chatModel(),
      contextLength: p.contextLength,
      chunkMaxChars: p.chunkMaxChars,
      temperature: p.temperature,
    };
  }

  /** The preset's reranker, loaded once; null until its files are in the data directory. */
  private currentReranker(): Reranker | null {
    const repo = this.preset?.answer.rerankerModel;
    if (!repo || !rerankerReady(this.rerankerDir, repo)) return null;
    if (this.reranker?.repo !== repo) {
      const instance = crossEncoder({
        transformersDir: path.join(process.resourcesPath, 'server', 'node_modules', '@xenova', 'transformers'),
        modelsDir: this.rerankerDir,
        repo,
        log: this.d.log,
      });
      this.reranker = { repo, instance };
    }
    return this.reranker.instance;
  }

  private pipelineDeps(): PipelineDeps | null {
    const { apiKey, workspaceSlug } = this.state;
    const watcher = this.watcher;
    const browse = this.browse;
    const ollamaPort = this.manager?.status().ports?.ollama;
    if (!apiKey || !workspaceSlug || !watcher || !browse || !ollamaPort) return null;
    return {
      vectorSearch: upstreamVectorSearch({ baseUrl: () => this.serverUrl(), apiKey, slug: workspaceSlug }),
      resolveSources: (sources) => watcher.resolveSources(sources),
      index: browse,
      reranker: this.currentReranker(),
      chat: ollamaChat(() => `http://127.0.0.1:${this.manager?.status().ports?.ollama ?? ollamaPort}`),
    };
  }

  /**
   * A library set up before the reranker became part of the first run gets it in the background;
   * questions take the bypass path until it is in place. Never fetched while answering.
   */
  private async fetchMissingReranker(): Promise<void> {
    const repo = this.preset?.answer.rerankerModel;
    if (!repo || rerankerReady(this.rerankerDir, repo)) return;
    this.d.log(`[answer] reranker ${repo} missing, fetching in the background`);
    try {
      await ensureReranker({ repo, modelsDir: this.rerankerDir, log: (m) => this.d.log(`[answer] ${m}`) });
      this.d.log(`[answer] reranker ${repo} ready`);
    } catch (e) {
      this.d.log(`[answer] reranker fetch failed: ${(e as Error).message}`);
    }
  }

  /** ASKFILES_SMOKE_QUESTION: one question through the pipeline once the page is up, for smoke-mac.sh. */
  private async smokeAnswer(question: string): Promise<void> {
    try {
      const r = await this.answers.askOnce(question);
      const cites = r.cited.map((c) => c.n);
      this.d.log(
        `[answer] smoke notFound=${r.notFound} cited=[${cites.join(',')}] sections=${r.cited.map((c) => JSON.stringify(c.title)).join(',')} ` +
          `firstTokenMs=${r.timings.firstTokenMs ?? '-'} text=${JSON.stringify(r.text.slice(0, 300))}`,
      );
    } catch (e) {
      this.d.log(`[answer] smoke failed: ${(e as Error).message}`);
    }
  }

  private serverUrl(): string | null {
    const port = this.manager?.status().ports?.server;
    return port ? `http://127.0.0.1:${port}` : null;
  }

  private ollamaClient(): OllamaClient {
    const port = this.manager?.status().ports?.ollama;
    if (!port) throw new Error('the model engine is not running');
    return new OllamaClient({ baseUrl: `http://127.0.0.1:${port}` });
  }

  private envFile(): string {
    return path.join(this.dataDir, 'server', '.env');
  }

  private modelManager(): ModelManager {
    return new ModelManager({
      ollama: this.ollamaClient(),
      envFile: this.envFile(),
      restartServer: () => this.restartBackend(),
      log: this.d.log,
    });
  }

  private show(page: PageName): void {
    this.page = page;
    this.d.log(`showing ${page}`);
    void this.d.win.loadURL(pageUrl(page));
  }

  private loadState(): ShellState {
    return { ...this.state };
  }

  private saveState(next: ShellState): void {
    saveShellState(this.dataDir, next);
    this.state = { ...next };
  }

  private createFirstRun(): FirstRun {
    const { log } = this.d;
    const wizard = new Wizard({
      presets: loadPresets(presetsFilePath(this.d.env, app.getAppPath())),
      // Ollama keeps its port until the wizard's own server restart, after its last Ollama call.
      ollama: this.ollamaClient(),
      envFile: this.envFile(),
      restartServer: () => this.restartBackend(),
      fetchReranker: (repo, onProgress) =>
        ensureReranker({ repo, modelsDir: this.rerankerDir, onProgress, log: (m) => log(`[wizard] ${m}`) }),
      log,
    });
    const run = new FirstRun({
      wizard,
      loadState: () => this.loadState(),
      saveState: (s) => this.saveState(s),
      presetFolder: presetFolder(this.d.env),
      isDirectory: (p) => {
        try {
          return fs.statSync(p).isDirectory();
        } catch {
          return false;
        }
      },
      setupLibrary: async ({ preset, storedKey }) => {
        const base = this.serverUrl();
        if (!base) throw new Error('the search engine is not running');
        const { apiKey, created } = await ensureApiKey(base, storedKey);
        log(created ? 'created an API key' : 'kept the stored API key');
        const workspaceSlug = await ensureLibrary(base, apiKey, workspaceSettings(preset));
        return { apiKey, workspaceSlug };
      },
      startWatcher: async ({ preset }) => {
        this.preset = preset;
        await this.startLibraryWatcher();
        if (!this.watcher) throw new Error(this.watcherError ?? 'the folder watcher did not start');
        return this.watcher;
      },
      log,
    });
    run.on('event', (e) => {
      this.d.broadcast(CHANNELS.setupEvent, e);
      if (e.type === 'setup' && e.state === 'done') {
        this.firstRun = null;
        this.show('ask');
      }
    });
    return run;
  }

  /** Starts the watcher on the stored folder; a failure is kept for the status bar, not thrown. */
  private async startLibraryWatcher(): Promise<void> {
    const { log } = this.d;
    const { folder, workspaceSlug, apiKey } = this.state;
    if (this.watcher || !folder || !workspaceSlug || !apiKey || !this.preset) return;
    const api = createLibraryApi({ baseUrl: () => this.serverUrl() ?? 'http://127.0.0.1:0', apiKey });
    const watcher = new FolderWatcher({
      root: folder,
      dataDir: this.dataDir,
      storageDir: this.storageDir,
      workspaceSlug,
      api,
      splitter: sectionSplitter({
        maxChars: this.preset.chunkMaxChars,
        embeddingModel: this.preset.embeddingModel,
        ocr: collectorOcr({ api, cacheDir: path.join(this.dataDir, 'ocr-cache'), log: (m) => log(`[watcher] ${m}`) }),
      }),
      watch: chokidarWatch,
      log: (m) => log(`[watcher] ${m}`),
    });
    watcher.on('status', (s) => this.d.broadcast(CHANNELS.watcherStatusEvent, { ...s, folder }));
    // Loaded before the watcher starts, so the browse pages list the library during a long reconcile.
    const browse = new BrowseIndex({
      dir: path.join(this.dataDir, 'browse'),
      root: folder,
      readChunk: chunkReader(this.storageDir),
      log: (m) => log(`[browse] ${m}`),
    });
    try {
      browse.load();
    } catch (e) {
      log(`[browse] not loaded: ${(e as Error).message}`);
    }
    this.browse = browse;
    followWatcher(browse, watcher, (m) => log(`[browse] ${m}`));
    try {
      await watcher.start();
      this.watcher = watcher;
      this.watcherError = null;
    } catch (e) {
      this.watcherError = `The folder ${folder} cannot be read: ${(e as Error).message}`;
      log(`watcher not started: ${(e as Error).message}`);
      this.d.broadcast(CHANNELS.watcherStatusEvent, this.watcherStatus());
      return;
    }
    try {
      // Files unchanged since the last run send no event; this catches them and anything stale.
      browse.sync(watcher.files());
    } catch (e) {
      log(`[browse] sync failed: ${(e as Error).message}`);
    }
  }

  /**
   * Restarts the backend so the server reads a changed .env (wizard, model switch). Ports change,
   * so the watcher pauses meanwhile and the Ask page reloads to pick up the new address.
   */
  private async restartBackend(): Promise<string> {
    const manager = this.manager!;
    const watcher = this.watcher;
    await watcher?.stop();
    this.d.log('restarting backend');
    await manager.stop();
    await manager.start();
    const url = this.serverUrl()!;
    this.d.log(`backend restarted, server at ${url}`);
    if (watcher) void watcher.start().catch((e: Error) => this.d.log(`watcher restart failed: ${e.message}`));
    if (this.page === 'ask') this.d.win.webContents.reload();
    return url;
  }

  /** Holds the quit until watcher and children are down, then quits for real. */
  private holdQuitUntilStopped(): void {
    app.on('will-quit', (event) => {
      if (this.stopped) return;
      event.preventDefault();
      this.d.log('stopping backend before quit');
      void (async () => {
        try {
          await this.watcher?.stop();
          await this.manager?.stop();
        } finally {
          this.stopped = true;
          app.quit();
        }
      })();
    });
  }
}
