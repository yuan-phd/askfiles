// The top bar of the main window (Session K): library switcher with the indexed count and state,
// the Add button, and the Ask and Browse switch. It stays fixed while the views scroll. It also
// owns the empty state of a library without sources, shown in place of both views, and adding
// by drag and drop anywhere in the window. Everything goes through window.askfiles (the preload
// bridge); without it (a plain browser) the bar shows the status counts only.

const MARKUP = `
<div class="topbar-library">
  <button type="button" class="library-switcher" data-testid="library-switcher" aria-haspopup="true" aria-expanded="false">
    <span class="library-name" data-testid="library-name">Library</span>
    <span class="library-status">
      <span data-testid="status-count">Connecting</span>
      <span class="status-state" data-testid="status-state" data-state="connecting"><span class="dot" aria-hidden="true"></span><span class="status-state-text">Connecting</span></span>
    </span>
  </button>
  <span class="status-failed" data-testid="status-failed" hidden></span>
  <div class="topbar-menu library-menu" data-testid="library-menu" role="menu" hidden>
    <ul class="library-options" data-testid="library-options"></ul>
    <form class="menu-form" data-testid="library-new-form" autocomplete="off">
      <label class="visually-hidden" for="library-new-name">New library name</label>
      <input id="library-new-name" data-testid="library-new-name" placeholder="New library" maxlength="60" />
      <button type="submit" data-testid="library-create">Create</button>
    </form>
    <section class="menu-section" data-testid="library-current">
      <h3 class="menu-title" data-testid="library-current-title"></h3>
      <ul class="source-list" data-testid="source-list"></ul>
      <p class="menu-note" data-testid="source-empty" hidden>No files or folders yet.</p>
      <form class="menu-form" data-testid="library-rename-form" autocomplete="off" hidden>
        <label class="visually-hidden" for="library-rename-name">Library name</label>
        <input id="library-rename-name" data-testid="library-rename-name" maxlength="60" />
        <button type="submit" data-testid="library-rename-save">Rename</button>
      </form>
      <div class="menu-actions">
        <button type="button" class="link" data-testid="library-reindex">Reindex</button>
        <button type="button" class="link danger" data-testid="library-delete">Delete library</button>
      </div>
    </section>
    <p class="menu-error" data-testid="library-error" role="alert" hidden></p>
  </div>
</div>
<div class="topbar-add">
  <button type="button" class="add-button" data-testid="add-button" aria-haspopup="true" aria-expanded="false">Add</button>
  <div class="topbar-menu add-menu" data-testid="add-menu" role="menu" hidden>
    <button type="button" role="menuitem" data-testid="add-files">Add files<span>Copies them into the library</span></button>
    <button type="button" role="menuitem" data-testid="add-folder">Add folder<span>Links it; AskFiles never changes it</span></button>
  </div>
</div>
<p class="add-result" data-testid="add-result" role="status" hidden></p>
<div class="view-switch" role="group" aria-label="View">
  <button type="button" data-view="search" data-testid="view-search" aria-pressed="true">Ask</button>
  <button type="button" data-view="browse" data-testid="view-browse" aria-pressed="false">Browse</button>
</div>
`;

const EMPTY_MARKUP = `
<p class="empty-text">This library is empty. Add files or a folder to start.</p>
<button type="button" class="add-button" data-testid="empty-add">Add</button>
<div class="topbar-menu add-menu empty-menu" data-testid="empty-add-menu" role="menu" hidden>
  <button type="button" role="menuitem" data-testid="empty-add-files">Add files<span>Copies them into the library</span></button>
  <button type="button" role="menuitem" data-testid="empty-add-folder">Add folder<span>Links it; AskFiles never changes it</span></button>
</div>
`;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** One line about an add: what went in and what was left out. */
export function addResultText(r) {
  if (!r) return '';
  const parts = [];
  if (r.added) parts.push(`Added ${plural(r.added, 'item', 'items')}.`);
  if (r.skipped?.length) {
    const first = r.skipped[0];
    const more = r.skipped.length > 1 ? ` and ${r.skipped.length - 1} more` : '';
    parts.push(`Not added: ${first.name} (${first.reason})${more}.`);
  }
  return parts.join(' ') || 'Nothing was added.';
}

/** Status line of the current library from the watcher status (src/main/libraries.ts LibraryStatus). */
export function statusOf(s) {
  if (!s) return null;
  if (s.error) return { kind: 'error', text: 'Folder not available' };
  if (s.state === 'working' || s.state === 'starting') {
    const pending = Number(s.pending) || 0;
    return { kind: 'indexing', text: pending > 0 ? `Indexing, ${pending} left` : 'Indexing' };
  }
  return { kind: 'ready', text: 'Up to date' };
}

/**
 * Mounts the bar into header. views maps a view name (search, browse) to its container, which the
 * empty state hides. onView(name) is called when the user switches. Returns an object the page
 * uses: setView(name), setConnection(kind, text) for its own connection problems,
 * setFallbackCount(n) for a count when no watcher reports one, and isEmpty().
 */
export function mountTopBar(header, { views = {}, onView = () => {} } = {}) {
  header.classList.add('topbar');
  header.dataset.testid = 'status-bar';
  header.innerHTML = MARKUP;
  const q = (id) => header.querySelector(`[data-testid="${id}"]`);
  const bridge = window.askfiles?.libraries;
  const watcher = window.askfiles?.watcher;
  const shellValues = window.shellConfig || {};

  const empty = document.createElement('section');
  empty.className = 'library-empty';
  empty.dataset.testid = 'library-empty-state';
  empty.setAttribute('aria-label', 'Empty library');
  empty.hidden = true;
  empty.innerHTML = EMPTY_MARKUP;
  header.after(empty);
  const eq = (id) => empty.querySelector(`[data-testid="${id}"]`);

  const state = {
    view: 'search',
    libraries: null,
    status: null,
    connection: null,
    fallbackCount: null,
  };

  // --- status ---------------------------------------------------------------------------------

  function renderStatus() {
    const s = state.status;
    const conn = state.connection;
    // The page's own problems win over the watcher; its ready state only stands in for a watcher.
    const line = (conn && conn.kind !== 'ready' ? conn : null) || statusOf(s) || conn;
    const node = q('status-state');
    node.dataset.state = line ? line.kind : 'connecting';
    node.querySelector('.status-state-text').textContent = line ? line.text : 'Connecting';
    node.title = s?.error || '';
    const n = s ? s.indexed : state.fallbackCount;
    if (n !== null && n !== undefined)
      q('status-count').textContent = plural(n, 'document indexed', 'documents indexed');
    else if (conn && conn.kind !== 'ready') q('status-count').textContent = '';
    const dead = s?.deadLetters || [];
    const failed = q('status-failed');
    failed.hidden = dead.length === 0;
    failed.textContent = plural(dead.length, 'file could not be read', 'files could not be read');
    failed.title = dead.map((d) => `${d.path}: ${d.error}`).join('\n');
  }

  function applyStatus(s) {
    if (!s) return;
    if (state.libraries && s.libraryId && s.libraryId !== state.libraries.current) return;
    state.status = s;
    renderStatus();
  }

  // --- libraries ------------------------------------------------------------------------------

  const current = () => state.libraries?.libraries.find((l) => l.isCurrent) || null;

  function showError(text) {
    q('library-error').hidden = !text;
    q('library-error').textContent = text || '';
  }

  function renderLibraries() {
    const lib = current();
    // Until the libraries answer, the name the shell gave the page at load.
    const name = lib ? lib.name : shellValues.libraryName || 'Library';
    q('library-name').textContent = name;
    q('library-name').title = name;
    const options = (state.libraries?.libraries || []).map((l) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'library-option';
      b.dataset.testid = 'library-option';
      b.dataset.id = l.id;
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(l.isCurrent));
      const name = document.createElement('span');
      name.className = 'option-name';
      name.textContent = l.name;
      const count = document.createElement('span');
      count.className = 'option-count';
      count.textContent = plural(l.indexed, 'document', 'documents');
      b.append(name, count);
      b.addEventListener('click', () => select(l.id));
      li.append(b);
      return li;
    });
    q('library-options').replaceChildren(...options);
    q('library-current-title').textContent = lib ? lib.name : '';
    const sources = lib?.sources || [];
    q('source-empty').hidden = sources.length > 0;
    q('source-list').replaceChildren(
      ...sources.map((s) => {
        const li = document.createElement('li');
        li.className = 'source-item';
        li.dataset.testid = 'source-item';
        li.dataset.kind = s.kind;
        const label = document.createElement('span');
        label.className = 'source-name';
        label.textContent = s.name;
        label.title = s.path;
        const kind = document.createElement('span');
        kind.className = 'source-kind';
        kind.textContent = s.kind === 'folder' ? (s.available ? 'Folder' : 'Folder, not available') : 'File';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'link';
        remove.dataset.testid = 'source-remove';
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', `Remove ${s.name}`);
        remove.addEventListener('click', () => run(() => bridge.removeSource(s.id)));
        li.append(label, kind, remove);
        return li;
      }),
    );
    const fixed = !lib || lib.isDefault;
    q('library-delete').hidden = fixed;
    q('library-rename-form').hidden = fixed;
    if (!fixed && document.activeElement !== q('library-rename-name')) q('library-rename-name').value = lib.name;
    renderEmpty();
  }

  function isEmpty() {
    const lib = current();
    return !!lib && lib.sources.length === 0;
  }

  function renderEmpty() {
    const on = isEmpty();
    empty.hidden = !on;
    document.body.dataset.emptyLibrary = String(on);
    for (const [name, el] of Object.entries(views)) el.hidden = on || name !== state.view;
  }

  function applyLibraries(v) {
    if (!v) return;
    state.libraries = v;
    renderLibraries();
    renderStatus();
  }

  /** Runs a library call, shows its error in the menu, and applies the view it returns. */
  async function run(call) {
    showError('');
    try {
      const v = await call();
      if (v && Array.isArray(v.libraries)) applyLibraries(v);
      return v;
    } catch (e) {
      showError(e.message);
      return null;
    }
  }

  async function select(id) {
    if (id === state.libraries?.current) return closeMenus();
    // The main process reloads the window onto the new library.
    await run(() => bridge.select(id));
  }

  // --- menus ----------------------------------------------------------------------------------

  const menus = [
    [q('library-switcher'), q('library-menu')],
    [q('add-button'), q('add-menu')],
    [eq('empty-add'), eq('empty-add-menu')],
  ];

  function closeMenus(except) {
    for (const [b, m] of menus) {
      if (m === except) continue;
      m.hidden = true;
      b.setAttribute('aria-expanded', 'false');
    }
  }

  for (const [b, m] of menus) {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = m.hidden;
      closeMenus(m);
      m.hidden = !open;
      b.setAttribute('aria-expanded', String(open));
      if (open && m === q('library-menu')) {
        showError('');
        if (bridge) void bridge.list().then(applyLibraries, (err) => showError(err.message));
      }
    });
    m.addEventListener('click', (e) => e.stopPropagation());
  }
  document.addEventListener('click', () => closeMenus());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenus();
  });

  q('library-new-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = q('library-new-name').value;
    if (!name.trim() || !bridge) return;
    if (await run(() => bridge.create(name))) q('library-new-name').value = '';
  });

  q('library-rename-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const lib = current();
    if (lib && bridge) await run(() => bridge.rename(lib.id, q('library-rename-name').value));
  });

  q('library-reindex').addEventListener('click', async () => {
    if (!bridge) return;
    closeMenus();
    await run(() => bridge.reindex());
  });

  q('library-delete').addEventListener('click', async () => {
    const lib = current();
    if (!lib || !bridge) return;
    const ok = window.confirm(
      `Delete the library ${lib.name}? Its index is removed. Your original files and folders are not touched.`,
    );
    if (ok) await run(() => bridge.remove(lib.id));
  });

  // --- adding ---------------------------------------------------------------------------------

  let resultTimer = null;
  function showResult(r) {
    const node = q('add-result');
    clearTimeout(resultTimer);
    node.textContent = addResultText(r);
    node.hidden = false;
    resultTimer = setTimeout(() => (node.hidden = true), 8000);
  }

  async function add(kind) {
    closeMenus();
    if (!bridge) return;
    try {
      const r = kind === 'files' ? await bridge.addFiles() : await bridge.addFolder();
      if (r) showResult(r);
    } catch (e) {
      showResult({ added: 0, skipped: [{ name: kind === 'files' ? 'files' : 'folder', reason: e.message }] });
    }
  }

  q('add-files').addEventListener('click', () => add('files'));
  q('add-folder').addEventListener('click', () => add('folder'));
  eq('empty-add-files').addEventListener('click', () => add('files'));
  eq('empty-add-folder').addEventListener('click', () => add('folder'));

  // Drag and drop of files or folders anywhere in the window adds them to the current library.
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || !bridge) return;
    dragDepth++;
    document.body.dataset.dropping = 'true';
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e) || !bridge) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) delete document.body.dataset.dropping;
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e) || !bridge) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', async (e) => {
    if (!hasFiles(e) || !bridge) return;
    e.preventDefault();
    dragDepth = 0;
    delete document.body.dataset.dropping;
    const paths = Array.from(e.dataTransfer.files || [])
      .map((f) => bridge.pathForFile(f))
      .filter(Boolean);
    if (!paths.length) return;
    try {
      showResult(await bridge.addPaths(paths));
    } catch (err) {
      showResult({ added: 0, skipped: [{ name: 'dropped items', reason: err.message }] });
    }
  });

  // --- view switch ----------------------------------------------------------------------------

  const viewButtons = [...header.querySelectorAll('.view-switch button')];
  function setView(view) {
    state.view = view;
    for (const b of viewButtons) b.setAttribute('aria-pressed', String(b.dataset.view === view));
    renderEmpty();
  }
  for (const b of viewButtons) {
    b.addEventListener('click', () => {
      setView(b.dataset.view);
      onView(b.dataset.view);
    });
  }

  // --- wiring ---------------------------------------------------------------------------------

  if (!bridge) {
    q('library-switcher').disabled = true;
    q('add-button').hidden = true;
  } else {
    bridge.onChange(applyLibraries);
    bridge.list().then(applyLibraries, (e) => console.warn('[topbar] libraries failed', e.message));
  }
  if (watcher) {
    watcher.onStatus(applyStatus);
    watcher
      .status()
      .then(applyStatus)
      .catch((e) => console.warn('[topbar] watcher status failed', e.message));
  }
  renderLibraries();
  renderStatus();

  return {
    setView,
    isEmpty,
    /** A connection problem of the page itself, such as the server not answering; null clears it. */
    setConnection(kind, text) {
      state.connection = kind ? { kind, text } : null;
      renderStatus();
    },
    /** The count to show when no watcher reports one (a plain browser). */
    setFallbackCount(n) {
      state.fallbackCount = n;
      renderStatus();
    },
  };
}
