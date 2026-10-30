import { app, dialog, shell, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import {
  AnswerService,
  ensureReranker,
  ollamaChat,
  rerankerProcess,
  rerankerReady,
  upstreamVectorSearch,
  type DeveloperOverrides,
  type EvalCase,
  type PipelineDeps,
  type Reranker,
  type RunSettings,
  type ServiceEvent,
} from './answer/index.js';
import { APP_ORIGIN, pageUrl, type PageName } from './app-protocol.js';
import { chooseStartPage, developerEnabled, presetFolder, presetsFilePath, type StartPage } from './app-mode.js';
import { bundledBackendConfig } from './backend-config.js';
import { BrowseIndex, chunkReader, followWatcher, type DocumentRef } from './browse/index.js';
import { CHANNELS, type BridgeHandlers, type DeveloperInfo, type WatcherView } from './bridge/contract.js';
import type { Env, Logger } from './config.js';
import { FirstRun } from './first-run.js';
import { LibraryManager, moveLegacyLibraryFiles, type AddResult } from './libraries.js';
import { deleteWorkspace, ensureApiKey, ensureLibrary, ensureWorkspace, workspaceNameOf } from './library.js';
import { ModelManager } from './models/index.js';
import { OllamaClient } from './ollama/index.js';
import { findOriginal } from './open-original.js';
import { messagePage } from './message-page.js';
import {
  chooseTier,
  loadPresets,
  presetSpawnEnv,
  workspaceSettings,
  writeServerEnv,
  type Preset,
  type PresetFile,
} from './presets/index.js';
import { ProcessManager } from './process-manager/index.js';
import { checkSettingsChange, effectivePreset, runSettingsFor, settingsEnv, settingsView } from './settings.js';
import {
  currentLibraryOf,
  DEFAULT_LIBRARY_ID,
  loadShellState,
  saveShellState,
  type Settings,
  type ShellState,
} from './shell-state.js';
import { seedTesseractData } from './tesseract.js';
import { chokidarWatch, collectorOcr, createLibraryApi, FolderWatcher, sectionSplitter } from './watcher/index.js';
import { Wizard } from './wizard/index.js';

/** The reranker process ends after this long without a question, to give its memory back. */
const RERANKER_IDLE_MS = 15 * 60_000;

export interface AppDeps {
  win: BrowserWindow;
  log: Logger;
  env: Env;
  /** Sends an event to every open window. */
  broadcast(channel: string, payload: unknown): void;
  /**
   * Opens the Models window. Settings covers the model choice, so the Models page has no menu
   * entry; only the Developer page opens it.
   */
  openModelsWindow(): void;
}

/**
 * The packaged app: starts Ollama, collector and server from the bundle, then shows onboarding on
 * the first launch and the Ask page afterwards, with the current library's watcher running
 * behind it. Implements the bridge handlers the pages call through the preload script.
 */
export class AppController implements BridgeHandlers {
  private readonly dataDir = app.getPath('userData');
  private readonly storageDir = path.join(this.dataDir, 'storage');
  private manager: ProcessManager | null = null;
  private presets: PresetFile | null = null;
  private presetsFile = '';
  /** The preset of this Mac's RAM tier, before the settings are applied. */
  private machinePreset: Preset | null = null;
  private state: ShellState;
  private firstRun: FirstRun | null = null;
  private readonly libraries: LibraryManager;
  private page: StartPage | PageName | null = null;
  private stopped = false;
  private readonly rerankerDir = path.join(this.dataDir, 'models', 'reranker');
  private reranker: { repo: string; instance: Reranker & { stop(): void } } | null = null;
  private readonly answers: AnswerService;

  constructor(private readonly d: AppDeps) {
    const loaded = loadShellState(this.dataDir, d.log);
    const { migrated, ...state } = loaded;
    this.state = state;
    if (migrated) {
      // Sessions H to J kept one folder; it becomes the All files library.
      moveLegacyLibraryFiles(this.dataDir, (m) => d.log(`[libraries] ${m}`));
      saveShellState(this.dataDir, this.state);
      d.log('shell.json moved to version 2 (libraries)');
    }
    this.libraries = this.createLibraries();
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

  /** True once the Ask page is the window content; the models and settings windows need it. */
  setUp(): boolean {
    return this.page === 'ask';
  }

  async run(): Promise<void> {
    const { log, win } = this.d;
    let serverEnv: Record<string, string>;
    try {
      this.presetsFile = presetsFilePath(this.d.env, app.getAppPath());
      this.presets = loadPresets(this.presetsFile);
      const tier = chooseTier(this.presets, os.totalmem());
      this.machinePreset = tier.preset;
      // Without the preset the server would run with thinking on; a broken bundle must show, not limp.
      serverEnv = presetSpawnEnv(tier.preset);
      log(`preset ${tier.preset.id} from ${this.presetsFile}`);
    } catch (e) {
      log(`backend not started: ${(e as Error).message}`);
      void win.loadURL(messagePage('AskFiles could not start.', (e as Error).message));
      return;
    }

    try {
      const seed = seedTesseractData({ langs: this.machinePreset.ocrLanguages, storageDir: this.storageDir });
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
      // The page first, so a large library's reconcile does not keep the start page up.
      this.show('ask');
      void this.fetchMissingReranker();
      await this.startLibraries();
    } else {
      this.firstRun = this.createFirstRun();
      this.show('onboarding');
    }
  }

  // --- bridge handlers -------------------------------------------------------------------------

  shellConfig() {
    const lib = currentLibraryOf(this.state);
    return {
      baseUrl: this.serverUrl(),
      apiKey: this.state.apiKey,
      workspace: lib.workspaceSlug,
      folder: null,
      libraryId: lib.id,
      libraryName: lib.name,
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
    return this.libraries.status();
  }

  libraryResolveSources(sources: Parameters<BridgeHandlers['libraryResolveSources']>[0]) {
    return this.libraries.watcherOf()?.resolveSources(sources) ?? sources;
  }

  async libraryOpenOriginal(source: Parameters<BridgeHandlers['libraryOpenOriginal']>[0]) {
    const w = this.libraries.watcherOf();
    const file = w ? findOriginal(source, w.files()) : null;
    if (!file || !fs.existsSync(file)) {
      this.d.log(`open original: no indexed file for ${JSON.stringify(source.title ?? source.url ?? null)}`);
      return false;
    }
    shell.showItemInFolder(file);
    return true;
  }

  librariesList() {
    return this.libraries.view();
  }

  async librariesSelect(id: string) {
    const before = this.state.currentLibrary;
    const v = await this.libraries.select(id);
    if (v.current !== before) this.reloadMain();
    return v;
  }

  async librariesCreate(name: string) {
    const v = await this.libraries.create(name);
    this.reloadMain();
    return v;
  }

  librariesRename(id: string, name: string) {
    return this.libraries.rename(id, name);
  }

  async librariesRemove(id: string) {
    const before = this.state.currentLibrary;
    const v = await this.libraries.remove(id);
    if (v.current !== before) this.reloadMain();
    return v;
  }

  async librariesAddFiles(): Promise<AddResult | null> {
    const r = await dialog.showOpenDialog(this.d.win, {
      title: `Add files to ${currentLibraryOf(this.state).name}`,
      buttonLabel: 'Add',
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return this.libraries.addPaths(r.filePaths);
  }

  async librariesAddFolder(): Promise<AddResult | null> {
    const r = await dialog.showOpenDialog(this.d.win, {
      title: `Add a folder to ${currentLibraryOf(this.state).name}`,
      buttonLabel: 'Add folder',
      properties: ['openDirectory'],
    });
    const folder = r.canceled ? undefined : r.filePaths[0];
    if (!folder) return null;
    return this.libraries.addFolder(folder);
  }

  librariesAddPaths(paths: string[]) {
    return this.libraries.addPaths(paths);
  }

  librariesRemoveSource(sourceId: string) {
    return this.libraries.removeSource(sourceId);
  }

  librariesReindex() {
    return this.libraries.reindex();
  }

  settingsGet() {
    return settingsView(this.requirePresets(), this.requireMachinePreset(), this.state.settings);
  }

  async settingsSet(change: Partial<Settings>) {
    const presets = this.requirePresets();
    const machine = this.requireMachinePreset();
    const view = settingsView(presets, machine, this.state.settings);
    const next: Settings = { ...this.state.settings, ...checkSettingsChange(change, view.models) };
    const before = effectivePreset(presets, machine, this.state.settings);
    const after = effectivePreset(presets, machine, next);
    if (after.chatModel !== before.chatModel) {
      if (!(await this.ollamaClient().has(after.chatModel))) {
        this.d.log(`[settings] pulling ${after.chatModel}`);
        await this.modelManager().pull(after.chatModel, (p) => this.d.broadcast(CHANNELS.modelsProgress, p));
      }
    }
    this.saveState({ ...this.state, settings: next });
    if (after.chatModel !== before.chatModel || after.contextLength !== before.contextLength) {
      writeServerEnv(this.envFile(), settingsEnv(after));
      this.d.log(`[settings] chat model ${after.chatModel}, context ${after.contextLength}; restarting the server`);
      await this.restartBackend();
    }
    this.d.log(`[settings] saved ${JSON.stringify(next)}`);
    return settingsView(presets, machine, next);
  }

  developerInfo(): DeveloperInfo {
    if (!developerEnabled(this.d.env)) throw new Error('the developer page is off');
    const machine = this.requireMachinePreset();
    return {
      dataDir: this.dataDir,
      machinePreset: machine,
      effectivePreset: effectivePreset(this.requirePresets(), machine, this.state.settings),
      settings: this.state.settings,
      presetsFile: this.presetsFile,
    };
  }

  async developerOpenModels() {
    if (!developerEnabled(this.d.env)) throw new Error('the developer page is off');
    // The model page edits the server settings the first run writes; not before it.
    if (!this.setUp()) throw new Error('AskFiles is not set up yet');
    this.d.openModelsWindow();
  }

  browseDocuments() {
    return this.libraries.browse()?.listDocuments() ?? [];
  }

  browseDocument(ref: DocumentRef) {
    return this.libraries.browse()?.getDocument(ref) ?? null;
  }

  browseHeadings(key: string | null) {
    return this.libraries.browse()?.headings({ key }) ?? [];
  }

  browseSearch(query: string) {
    return this.libraries.browse()?.search(query) ?? { query, terms: [], total: 0, groups: [], truncated: false };
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

  private requirePresets(): PresetFile {
    if (!this.presets) throw new Error('the presets are not loaded');
    return this.presets;
  }

  private requireMachinePreset(): Preset {
    if (!this.machinePreset) throw new Error('the presets are not loaded');
    return this.machinePreset;
  }

  /** The chat model the server .env names (the model page may have switched it), else the preset's. */
  private chatModel(): string {
    try {
      const env = util.parseEnv(fs.readFileSync(this.envFile(), 'utf8')) as Record<string, string>;
      if (env.OLLAMA_MODEL_PREF) return env.OLLAMA_MODEL_PREF;
    } catch {
      // No .env yet: the preset decides.
    }
    return this.requireMachinePreset().chatModel;
  }

  /** Read for every question: the stored answer scope reaches the pipeline (src/main/settings.ts). */
  private runSettings(): RunSettings {
    const machine = this.machinePreset;
    if (!machine || !this.presets) throw new Error('AskFiles has not loaded its settings yet');
    return runSettingsFor({
      presets: this.presets,
      machine,
      settings: this.state.settings,
      chatModel: this.chatModel(),
    });
  }

  /** The preset's reranker, loaded once; null until its files are in the data directory. */
  private currentReranker(): Reranker | null {
    const repo = this.machinePreset?.answer.rerankerModel;
    if (!repo || !rerankerReady(this.rerankerDir, repo)) return null;
    if (this.reranker?.repo !== repo) {
      this.reranker?.instance.stop();
      // A child process of the app's own binary: a model call would block the main process.
      const instance = rerankerProcess({
        transformersDir: path.join(process.resourcesPath, 'server', 'node_modules', '@xenova', 'transformers'),
        modelsDir: this.rerankerDir,
        repo,
        execPath: process.execPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        idleMs: RERANKER_IDLE_MS,
        log: this.d.log,
      });
      this.reranker = { repo, instance };
    }
    return this.reranker.instance;
  }

  private pipelineDeps(): PipelineDeps | null {
    const { apiKey } = this.state;
    const workspaceSlug = currentLibraryOf(this.state).workspaceSlug;
    const watcher = this.libraries.watcherOf();
    const browse = this.libraries.browse();
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
    const repo = this.machinePreset?.answer.rerankerModel;
    if (!repo || rerankerReady(this.rerankerDir, repo)) return;
    this.d.log(`[answer] reranker ${repo} missing, fetching in the background`);
    try {
      await ensureReranker({ repo, modelsDir: this.rerankerDir, log: (m) => this.d.log(`[answer] ${m}`) });
      this.d.log(`[answer] reranker ${repo} ready`);
    } catch (e) {
      this.d.log(`[answer] reranker fetch failed: ${(e as Error).message}`);
    }
  }

  /** Resolves once the current library has indexed files and nothing waits; gives up after ms. */
  private async libraryIndexed(ms: number): Promise<void> {
    const t0 = Date.now();
    for (;;) {
      const w = this.libraries.watcherOf();
      if (w && w.files().length) return w.whenIdle();
      if (Date.now() - t0 > ms) throw new Error(`the library was not indexed within ${ms / 1000} s`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** ASKFILES_SMOKE_QUESTION: one question through the pipeline once the page is up, for smoke-mac.sh. */
  private async smokeAnswer(question: string): Promise<void> {
    try {
      // Setup no longer waits for indexing (Session K), so the question waits for the library.
      await this.libraryIndexed(15 * 60_000);
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

  /** The main window shows another library: the Ask page reads its workspace at load. */
  private reloadMain(): void {
    if (this.page === 'ask') this.d.win.webContents.reload();
  }

  private saveState(next: ShellState): void {
    saveShellState(this.dataDir, next);
    this.state = { ...next };
  }

  private libraryApi() {
    return createLibraryApi({
      baseUrl: () => this.serverUrl() ?? 'http://127.0.0.1:0',
      apiKey: this.state.apiKey ?? '',
    });
  }

  private createLibraries(): LibraryManager {
    const { log } = this.d;
    return new LibraryManager({
      dataDir: this.dataDir,
      getState: () => this.state,
      setState: (s) => this.saveState(s),
      workspaces: {
        ensure: async (libraryId) => {
          const base = this.serverUrl();
          if (!base || !this.state.apiKey) throw new Error('the search engine is not running');
          const settings = workspaceSettings(this.requireMachinePreset());
          return libraryId === DEFAULT_LIBRARY_ID
            ? ensureLibrary(base, this.state.apiKey, settings)
            : ensureWorkspace(base, this.state.apiKey, workspaceNameOf(libraryId), settings);
        },
        remove: async (slug) => {
          const base = this.serverUrl();
          if (!base || !this.state.apiKey) throw new Error('the search engine is not running');
          await deleteWorkspace(base, this.state.apiKey, slug);
        },
      },
      removeDocuments: (folder) =>
        fs.rmSync(path.join(this.storageDir, 'documents', folder), { recursive: true, force: true }),
      createWatcher: (o) => {
        const preset = this.requireMachinePreset();
        const api = this.libraryApi();
        const watcher = new FolderWatcher({
          roots: o.roots,
          dataDir: o.dataDir,
          storageDir: this.storageDir,
          docsFolder: o.docsFolder,
          workspaceSlug: o.workspaceSlug,
          api,
          splitter: sectionSplitter({
            maxChars: preset.chunkMaxChars,
            embeddingModel: preset.embeddingModel,
            ocr: collectorOcr({
              api,
              cacheDir: path.join(this.dataDir, 'ocr-cache'),
              log: (m) => log(`[watcher] ${m}`),
            }),
          }),
          watch: chokidarWatch,
          log: (m) => log(`[watcher] ${m}`),
        });
        return watcher;
      },
      createBrowse: (o) =>
        new BrowseIndex({ dir: o.dir, readChunk: chunkReader(this.storageDir), log: (m) => log(`[browse] ${m}`) }),
      followWatcher: (browse, watcher) => followWatcher(browse, watcher, (m) => log(`[browse] ${m}`)),
      onChange: (v) => this.d.broadcast(CHANNELS.librariesEvent, v),
      onStatus: (s) => this.d.broadcast(CHANNELS.watcherStatusEvent, s),
      log,
    });
  }

  /** ASKFILES_LIBRARY_FOLDER first (smoke test), then the current library's watcher. */
  private async startLibraries(): Promise<void> {
    const folder = presetFolder(this.d.env);
    try {
      if (folder) await this.libraries.linkPresetFolder(folder);
      await this.libraries.start();
    } catch (e) {
      this.d.log(`[libraries] not started: ${(e as Error).message}`);
    }
  }

  private createFirstRun(): FirstRun {
    const { log } = this.d;
    const wizard = new Wizard({
      presets: this.requirePresets(),
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
      loadState: () => ({ ...this.state }),
      saveState: (s) => this.saveState(s),
      setupLibrary: async ({ preset, storedKey }) => {
        const base = this.serverUrl();
        if (!base) throw new Error('the search engine is not running');
        const { apiKey, created } = await ensureApiKey(base, storedKey);
        log(created ? 'created an API key' : 'kept the stored API key');
        const workspaceSlug = await ensureLibrary(base, apiKey, workspaceSettings(preset));
        return { apiKey, workspaceSlug };
      },
      log,
    });
    run.on('event', (e) => {
      this.d.broadcast(CHANNELS.setupEvent, e);
      if (e.type === 'setup' && e.state === 'done') {
        this.firstRun = null;
        this.show('ask');
        void this.startLibraries();
      }
    });
    return run;
  }

  /**
   * Restarts the backend so the server reads a changed .env (wizard, model switch, settings). Ports
   * change, so the watcher pauses meanwhile and the Ask page reloads to pick up the new address.
   */
  private async restartBackend(): Promise<string> {
    const manager = this.manager!;
    await this.libraries.pause();
    this.d.log('restarting backend');
    await manager.stop();
    await manager.start();
    const url = this.serverUrl()!;
    this.d.log(`backend restarted, server at ${url}`);
    void this.libraries.resume().catch((e: Error) => this.d.log(`watcher restart failed: ${e.message}`));
    this.reloadMain();
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
          this.reranker?.instance.stop();
          await this.libraries.stop();
          await this.manager?.stop();
        } finally {
          this.stopped = true;
          app.quit();
        }
      })();
    });
  }
}
