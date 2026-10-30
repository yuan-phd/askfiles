// In-page stand-in for the library, settings and developer parts of the preload bridge
// (src/main/preload.ts), for the top bar, empty state and Settings page tests. Merges into any
// window.askfiles another stub set up first. Calls are recorded in window.__libCalls; answers come
// from the options; window.__librariesEvent(view) and window.__watcher(status) push events the way
// the main process does.

/** A library as src/main/libraries.ts LibraryView describes it. */
export function library(over = {}) {
  return { id: 'all-files', name: 'All files', isDefault: true, isCurrent: true, indexed: 0, sources: [], ...over };
}

export function folderSource(path, over = {}) {
  return { id: 'folder-1', kind: 'folder', path, name: path.split('/').pop(), available: true, ...over };
}

export function settingsView(over = {}) {
  return {
    values: { answerScope: 'balanced', answerModel: 'better', contextLength: null },
    models: {
      faster: { choice: 'faster', model: 'qwen3:4b', tierLabel: '8 GB' },
      better: { choice: 'better', model: 'qwen3:8b', tierLabel: '16 GB' },
    },
    contextDefault: 8192,
    contextChoices: [4096, 8192, 16384],
    scopes: ['strict', 'balanced', 'broad'],
    ...over,
  };
}

/**
 * options: libraries (LibrariesView), status (watcher status), settings (SettingsView),
 * addResult (what addFiles, addFolder and addPaths answer), fail ({ method: message }),
 * developer (what developer.info answers).
 */
export async function stubLibraries(page, options = {}) {
  await page.addInitScript((o) => {
    const calls = [];
    const libListeners = [];
    const statusListeners = [];
    const progressListeners = [];
    window.__libCalls = calls;
    window.__librariesEvent = (v) => {
      o.libraries = v;
      libListeners.forEach((l) => l(v));
    };
    window.__watcher = (s) => statusListeners.forEach((l) => l(s));
    window.__progress = (p) => progressListeners.forEach((l) => l(p));
    const answer = (method, value, ...args) => {
      calls.push([method, ...args]);
      if (o.fail?.[method]) return Promise.reject(new Error(o.fail[method]));
      return Promise.resolve(typeof value === 'function' ? value(...args) : value);
    };
    const base = window.askfiles || {};
    window.askfiles = {
      ...base,
      watcher: base.watcher || {
        status: async () => o.status ?? null,
        onStatus: (cb) => {
          statusListeners.push(cb);
          return () => {};
        },
      },
      libraries: {
        list: () => answer('list', () => o.libraries),
        onChange: (cb) => {
          libListeners.push(cb);
          return () => {};
        },
        select: (id) => answer('select', () => o.libraries, id),
        create: (name) => answer('create', () => o.libraries, name),
        rename: (id, name) => answer('rename', () => o.libraries, id, name),
        remove: (id) => answer('remove', () => o.libraries, id),
        addFiles: () => answer('addFiles', o.addResult ?? null),
        addFolder: () => answer('addFolder', o.addResult ?? null),
        addPaths: (paths) => answer('addPaths', o.addResult ?? { added: paths.length, skipped: [] }, paths),
        removeSource: (id) => answer('removeSource', () => o.libraries, id),
        reindex: () => answer('reindex', () => o.libraries),
        pathForFile: (file) => `/dropped/${file.name}`,
      },
      settings: {
        get: () => answer('settingsGet', () => o.settings),
        set: (change) =>
          answer(
            'settingsSet',
            () => {
              o.settings = { ...o.settings, values: { ...o.settings.values, ...change } };
              return o.settings;
            },
            change,
          ),
      },
      developer: {
        info: () => answer('developerInfo', o.developer ?? null),
        openModels: () => answer('openModels', null),
      },
      models: {
        ...(base.models || {}),
        onProgress: (cb) => {
          progressListeners.push(cb);
          return () => {};
        },
      },
      app: base.app || { info: async () => ({ name: 'AskFiles', version: '0.1.0' }), pageReady: () => {} },
    };
  }, options);
}
