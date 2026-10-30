// Browse view: read the library without asking anything. Library, document, headings and find
// pages, all drawn from the shell's browse index through window.askfiles.browse; no model and no
// server call. Mounted by the Ask page next to Ask, and by browse/index.html on its own.

const MARKUP = `
<nav class="browse-tabs" aria-label="Browse">
  <button type="button" class="browse-tab" data-tab="library" data-testid="browse-tab-library">Library</button>
  <button type="button" class="browse-tab" data-tab="headings" data-testid="browse-tab-headings">Headings</button>
  <button type="button" class="browse-tab" data-tab="find" data-testid="browse-tab-find">Find</button>
</nav>

<section class="browse-page" data-page="library" data-testid="library" aria-label="Library">
  <div class="library-head">
    <p class="library-count" data-testid="library-count"></p>
    <p class="library-state" data-testid="library-state" data-state="ready"><span class="dot" aria-hidden="true"></span><span class="library-state-text"></span></p>
    <label class="library-sort">Sort by
      <select data-testid="library-sort">
        <option value="name">Name</option>
        <option value="date">Last changed</option>
      </select>
    </label>
  </div>
  <ul class="library-list" data-testid="library-list"></ul>
  <p class="browse-empty" data-testid="library-empty" hidden>No documents yet. Files in your documents folder appear here once they are indexed.</p>
</section>

<section class="browse-page" data-page="document" data-testid="document" aria-label="Document" hidden>
  <div class="doc-layout">
    <nav class="doc-rail" aria-label="Outline">
      <h2>Outline</h2>
      <ol class="outline" data-testid="doc-outline"></ol>
      <p class="rail-empty" data-testid="doc-outline-empty" hidden>No headings in this document.</p>
    </nav>
    <article class="doc-body">
      <header class="doc-head">
        <button type="button" class="link back" data-testid="doc-back">Back</button>
        <h1 class="doc-title" data-testid="doc-title"></h1>
        <p class="doc-path" data-testid="doc-path"></p>
        <button type="button" class="open" data-testid="doc-open">Open original</button>
      </header>
      <p class="error" data-testid="doc-error" role="alert" hidden></p>
      <div class="doc-sections" data-testid="doc-sections"></div>
    </article>
  </div>
</section>

<section class="browse-page" data-page="headings" data-testid="headings" aria-label="Headings" hidden>
  <div class="headings-layout">
    <div class="headings-index">
      <label class="headings-all"><input type="checkbox" data-testid="headings-all" /> Include headings found in one document only</label>
      <ul class="headings-list" data-testid="headings-list"></ul>
      <p class="browse-empty" data-testid="headings-empty" hidden></p>
    </div>
    <div class="headings-detail" data-testid="headings-detail" aria-live="polite">
      <p class="browse-empty">Choose a heading to see that section from every document side by side.</p>
    </div>
  </div>
</section>

<section class="browse-page" data-page="find" data-testid="find" aria-label="Find" hidden>
  <form class="query find-form" autocomplete="off">
    <label class="visually-hidden" for="find-query">Find words in your documents</label>
    <input id="find-query" type="search" data-testid="find-query" placeholder="Find words in your documents" spellcheck="false" />
    <button type="submit" data-testid="find-submit">Find</button>
  </form>
  <p class="hint">Every word must appear in the section. Chinese matches anywhere in the text.</p>
  <p class="find-summary" data-testid="find-summary" hidden></p>
  <ol class="find-results" data-testid="find-results"></ol>
</section>
`;

const bridge = window.askfiles?.browse;
const watcher = window.askfiles?.watcher;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function button(className, text, testid) {
  const b = el('button', className, text);
  b.type = 'button';
  if (testid) b.dataset.testid = testid;
  return b;
}

/** Page or sheet label; spreadsheets carry the sheet number in the page fields. */
export function placeLabel(start, end, fileName = '') {
  if (!start) return '';
  const unit = /\.xlsx$/i.test(fileName) ? 'Sheet' : 'Page';
  if (!end || end === start) return `${unit} ${start}`;
  return `${unit}s ${start} to ${end}`;
}

/** Paragraphs of a section text; single line breaks stay inside a paragraph (CSS pre-line). */
function paragraphs(text) {
  return text
    .split(/\n{2,}/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => el('p', 'doc-para', t));
}

function folderOf(relPath) {
  const parts = relPath.split(/[\\/]/);
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
}

function dateLabel(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Text with the [start, end) ranges wrapped in mark elements. */
function highlighted(text, marks) {
  const out = [];
  let at = 0;
  for (const [a, b] of marks || []) {
    if (a > at) out.push(document.createTextNode(text.slice(at, a)));
    out.push(el('mark', '', text.slice(a, b)));
    at = b;
  }
  if (at < text.length) out.push(document.createTextNode(text.slice(at)));
  return out;
}

async function openOriginal(doc) {
  const open = window.askfiles?.library?.openOriginal;
  if (typeof open !== 'function') {
    console.log(`[browse] open original ${JSON.stringify({ title: doc.title, url: doc.url })}`);
    return true;
  }
  try {
    return await window.askfiles?.library?.openOriginal({ title: doc.title, url: doc.url });
  } catch (e) {
    console.warn('[browse] open original failed', e.message);
    return false;
  }
}

/**
 * Builds the browse view inside root. Returns { show(tab), openDocument(ref, target) }:
 * ref is { id } or a source's { url, title }; target is { sectionIndex, sectionTitle }.
 */
export function createBrowseView(root) {
  root.classList.add('browse');
  root.innerHTML = MARKUP;
  const q = (testid) => root.querySelector(`[data-testid="${testid}"]`);
  const pages = Object.fromEntries([...root.querySelectorAll('.browse-page')].map((p) => [p.dataset.page, p]));
  const tabs = [...root.querySelectorAll('.browse-tab')];
  const state = {
    page: 'library',
    returnTo: 'library',
    documents: [],
    sort: 'name',
    expanded: new Set(),
    doc: null,
    headingKey: null,
    status: null,
    loaded: false,
  };

  function showPage(name) {
    state.page = name;
    for (const [n, p] of Object.entries(pages)) p.hidden = n !== name;
    for (const t of tabs) {
      const on = t.dataset.tab === name || (name === 'document' && t.dataset.tab === state.returnTo);
      t.classList.toggle('active', on);
      if (on) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    }
  }

  function show(tab) {
    if (tab === 'library' && !state.loaded) void loadLibrary();
    if (tab === 'headings') void loadHeadings();
    showPage(tab);
    if (tab === 'find') q('find-query').focus();
  }

  for (const t of tabs) t.addEventListener('click', () => show(t.dataset.tab));

  // --- library -------------------------------------------------------------------------------

  function renderState() {
    const s = state.status;
    const node = q('library-state');
    let kind = 'ready';
    let text = 'Up to date';
    if (s?.error) {
      kind = 'error';
      text = 'Folder not available';
    } else if (s && (s.state === 'working' || s.state === 'starting')) {
      kind = 'indexing';
      const pending = Number(s.pending) || 0;
      text = pending > 0 ? `Indexing, ${pending} left` : 'Indexing';
    } else if (!s) {
      text = '';
    }
    node.dataset.state = kind;
    node.querySelector('.library-state-text').textContent = text;
    node.hidden = !text;
  }

  function outlineList(entries, doc, testid) {
    const ol = el('ol', 'outline');
    for (const e of entries) {
      const li = el('li');
      const b = button('outline-link', e.title, testid);
      b.dataset.section = String(e.sectionIndex);
      b.addEventListener('click', () => openDocument({ id: doc.id }, { sectionIndex: e.sectionIndex }));
      li.append(b);
      if (e.children?.length) li.append(outlineList(e.children, doc, testid));
      ol.append(li);
    }
    return ol;
  }

  function sorted() {
    const docs = [...state.documents];
    if (state.sort === 'date') docs.sort((a, b) => b.mtimeMs - a.mtimeMs || a.title.localeCompare(b.title));
    else docs.sort((a, b) => a.title.localeCompare(b.title) || a.relPath.localeCompare(b.relPath));
    return docs;
  }

  function renderLibrary() {
    const docs = sorted();
    q('library-count').textContent = docs.length === 1 ? '1 document' : `${docs.length} documents`;
    q('library-empty').hidden = docs.length > 0;
    q('library-list').replaceChildren(
      ...docs.map((d) => {
        const li = el('li', 'doc-item');
        li.dataset.testid = 'library-item';
        li.dataset.id = d.id;
        const row = el('div', 'doc-item-row');
        const open = button('doc-link', d.title, 'library-open');
        open.addEventListener('click', () => openDocument({ id: d.id }));
        const meta = el('span', 'doc-meta');
        meta.dataset.testid = 'library-meta';
        const sections = d.sectionCount === 1 ? '1 section' : `${d.sectionCount} sections`;
        for (const part of [folderOf(d.relPath), dateLabel(d.mtimeMs), sections]) {
          if (part) meta.append(el('span', '', part));
        }
        row.append(open, meta);
        li.append(row);
        if (d.outline.length) {
          const expanded = state.expanded.has(d.id);
          const toggle = button('link outline-toggle', expanded ? 'Hide outline' : 'Show outline', 'library-toggle');
          toggle.setAttribute('aria-expanded', String(expanded));
          const outline = outlineList(d.outline, d, 'library-outline-entry');
          outline.dataset.testid = 'library-outline';
          outline.hidden = !expanded;
          toggle.addEventListener('click', () => {
            const now = outline.hidden;
            outline.hidden = !now;
            toggle.setAttribute('aria-expanded', String(now));
            toggle.textContent = now ? 'Hide outline' : 'Show outline';
            if (now) state.expanded.add(d.id);
            else state.expanded.delete(d.id);
          });
          row.append(toggle);
          li.append(outline);
        }
        return li;
      }),
    );
  }

  async function loadLibrary() {
    if (!bridge) {
      q('library-count').textContent = 'Browsing is available in the AskFiles app.';
      return;
    }
    try {
      state.documents = await bridge.documents();
      state.loaded = true;
      renderLibrary();
    } catch (e) {
      q('library-count').textContent = `The library could not be read: ${e.message}`;
    }
  }

  q('library-sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    renderLibrary();
  });

  // --- document ------------------------------------------------------------------------------

  function headingTag(level) {
    return `h${Math.min(6, Math.max(2, level + 1))}`;
  }

  function renderDocument(doc) {
    q('doc-title').textContent = doc.title;
    q('doc-path').textContent = doc.relPath !== doc.title ? doc.relPath : '';
    q('doc-error').hidden = true;
    q('doc-outline').replaceChildren(...outlineList(doc.outline, doc, 'doc-outline-entry').children);
    q('doc-outline-empty').hidden = doc.outline.length > 0;
    q('doc-sections').replaceChildren(
      ...doc.sections.map((s) => {
        const sec = el('section', 'doc-section');
        sec.dataset.testid = 'doc-section';
        sec.dataset.section = String(s.index);
        sec.id = `section-${doc.id}-${s.index}`;
        for (const t of s.lead) {
          const lead = el(headingTag(Math.max(1, s.level - 1)), 'doc-heading doc-lead', t);
          sec.append(lead);
        }
        if (s.level > 0) {
          const h = el(headingTag(s.level), 'doc-heading', s.title);
          h.dataset.testid = 'doc-section-title';
          sec.append(h);
        }
        const place = placeLabel(s.pageStart, s.pageEnd, doc.title);
        if (place) {
          const p = el('p', 'doc-page', place);
          p.dataset.testid = 'doc-section-page';
          sec.append(p);
        }
        sec.append(...paragraphs(s.text));
        return sec;
      }),
    );
  }

  function scrollToSection(target) {
    const doc = state.doc;
    if (!doc) return;
    let index = Number(target?.sectionIndex);
    if (!doc.sections.some((s) => s.index === index) && target?.sectionTitle) {
      index = doc.sections.find((s) => s.title === target.sectionTitle)?.index;
    }
    for (const b of root.querySelectorAll('.doc-rail .outline-link')) {
      b.classList.toggle('active', Number(b.dataset.section) === index);
    }
    const sec = root.querySelector(`.doc-section[data-section="${index}"]`);
    for (const s of root.querySelectorAll('.doc-section.target')) s.classList.remove('target');
    if (sec) {
      sec.classList.add('target');
      sec.scrollIntoView({ block: 'start' });
    } else {
      pages.document.scrollIntoView({ block: 'start' });
    }
  }

  async function openDocument(ref, target = {}) {
    if (state.page !== 'document') state.returnTo = state.page;
    showPage('document');
    if (!bridge) {
      q('doc-error').textContent = 'Reading documents is available in the AskFiles app.';
      q('doc-error').hidden = false;
      return;
    }
    let doc = null;
    try {
      doc = await bridge.document(ref);
    } catch (e) {
      console.warn('[browse] document failed', e.message);
    }
    if (!doc) {
      state.doc = null;
      q('doc-title').textContent = ref.title || 'Document';
      q('doc-path').textContent = '';
      q('doc-outline').replaceChildren();
      q('doc-outline-empty').hidden = true;
      q('doc-sections').replaceChildren();
      q('doc-error').textContent = 'This document is not in the library yet. It appears here once it is indexed.';
      q('doc-error').hidden = false;
      return;
    }
    state.doc = doc;
    renderDocument(doc);
    scrollToSection(target);
  }

  q('doc-back').addEventListener('click', () => showPage(state.returnTo));
  q('doc-open').addEventListener('click', async () => {
    if (state.doc && (await openOriginal(state.doc)) === false) {
      q('doc-error').textContent = `${state.doc.title} is no longer in your documents folder.`;
      q('doc-error').hidden = false;
    }
  });

  // --- headings ------------------------------------------------------------------------------

  let headingGroups = [];

  function renderHeadings() {
    const all = q('headings-all').checked;
    const groups = headingGroups.filter((g) => all || g.documents > 1);
    const empty = q('headings-empty');
    empty.hidden = groups.length > 0;
    empty.textContent = headingGroups.length
      ? 'No heading appears in more than one document.'
      : 'No headings yet. Documents with headings appear here once they are indexed.';
    q('headings-list').replaceChildren(
      ...groups.map((g) => {
        const li = el('li');
        const b = button('heading-item', '', 'heading-item');
        b.dataset.key = g.key;
        b.classList.toggle('active', g.key === state.headingKey);
        b.append(
          el('span', 'heading-label', g.label),
          el('span', 'heading-count', g.documents === 1 ? '1 document' : `${g.documents} documents`),
        );
        b.addEventListener('click', () => showHeading(g.key));
        li.append(b);
        return li;
      }),
    );
  }

  async function loadHeadings() {
    if (!bridge) return;
    try {
      headingGroups = await bridge.headings(null);
      renderHeadings();
    } catch (e) {
      q('headings-empty').textContent = `The headings could not be read: ${e.message}`;
      q('headings-empty').hidden = false;
    }
  }

  async function showHeading(key) {
    state.headingKey = key;
    for (const b of root.querySelectorAll('.heading-item')) b.classList.toggle('active', b.dataset.key === key);
    const detail = q('headings-detail');
    let group = null;
    try {
      [group] = await bridge.headings(key);
    } catch (e) {
      console.warn('[browse] heading failed', e.message);
    }
    if (state.headingKey !== key) return;
    if (!group) {
      detail.replaceChildren(el('p', 'browse-empty', 'This heading is no longer in your documents.'));
      return;
    }
    const title = el('h2', 'headings-title', group.label);
    title.dataset.testid = 'headings-title';
    const columns = el('div', 'compare');
    for (const e of group.entries) {
      const card = el('article', 'compare-card');
      card.dataset.testid = 'compare-card';
      const head = el('header', 'compare-head');
      const file = el('span', 'compare-file', e.documentTitle);
      file.dataset.testid = 'compare-file';
      file.title = e.relPath;
      const as = el('span', 'compare-section', e.title);
      head.append(file, as);
      const place = placeLabel(e.pageStart, e.pageEnd, e.documentTitle);
      if (place) head.append(el('span', 'compare-page', place));
      const body = el('div', 'compare-text');
      body.dataset.testid = 'compare-text';
      body.append(...paragraphs(e.text || ''));
      const actions = el('div', 'card-actions');
      const read = button('link', 'Read in document', 'compare-read');
      read.addEventListener('click', () => openDocument({ id: e.documentId }, { sectionIndex: e.sectionIndex }));
      const open = button('open', 'Open original', 'compare-open');
      open.addEventListener('click', () => openOriginal({ title: e.documentTitle, url: e.url }));
      actions.append(read, open);
      card.append(head, body, actions);
      columns.append(card);
    }
    detail.replaceChildren(title, columns);
  }

  q('headings-all').addEventListener('change', renderHeadings);

  // --- find ----------------------------------------------------------------------------------

  async function find(query) {
    const summary = q('find-summary');
    const list = q('find-results');
    if (!query.trim()) {
      summary.hidden = true;
      list.replaceChildren();
      return;
    }
    if (!bridge) return;
    let r;
    try {
      r = await bridge.search(query);
    } catch (e) {
      summary.textContent = `The search could not run: ${e.message}`;
      summary.hidden = false;
      return;
    }
    const sections = r.total === 1 ? '1 section' : `${r.total} sections`;
    const docs = r.groups.length === 1 ? '1 document' : `${r.groups.length} documents`;
    summary.textContent = r.total
      ? `${sections} in ${docs}${r.truncated ? `, the first ${r.groups.reduce((n, g) => n + g.hits.length, 0)} shown` : ''}`
      : `Nothing in your documents contains ${query.trim()}.`;
    summary.hidden = false;
    list.replaceChildren(
      ...r.groups.map((g) => {
        const li = el('li', 'find-group');
        li.dataset.testid = 'find-group';
        const head = el('div', 'find-group-head');
        const name = el('span', 'find-file', g.document.title);
        name.dataset.testid = 'find-file';
        name.title = g.document.relPath;
        head.append(name, el('span', 'find-count', g.count === 1 ? '1 match' : `${g.count} matches`));
        const hits = el('ol', 'find-hits');
        for (const h of g.hits) {
          const item = el('li');
          const b = button('find-hit', '', 'find-hit');
          b.dataset.section = String(h.sectionIndex);
          const title = el('span', 'find-hit-title');
          title.append(...highlighted(h.title, h.titleMarks));
          const place = placeLabel(h.pageStart, h.pageEnd, g.document.title);
          const snippet = el('span', 'find-snippet');
          snippet.dataset.testid = 'find-snippet';
          snippet.append(...highlighted(h.snippet, h.marks));
          b.append(title);
          if (place) b.append(el('span', 'find-page', place));
          b.append(snippet);
          b.addEventListener('click', () => openDocument({ id: g.document.id }, { sectionIndex: h.sectionIndex }));
          item.append(b);
          hits.append(item);
        }
        li.append(head, hits);
        return li;
      }),
    );
  }

  root.querySelector('.find-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void find(q('find-query').value);
  });

  // --- live updates --------------------------------------------------------------------------

  let reloadTimer = null;
  function applyStatus(s) {
    const before = state.status;
    state.status = s || null;
    renderState();
    // The index changes as files are indexed; reload the list once the count or the state moves.
    if (state.loaded && (!before || before.indexed !== s?.indexed || before.state !== s?.state)) {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => void loadLibrary(), 300);
    }
  }

  if (watcher) {
    watcher.onStatus(applyStatus);
    watcher
      .status()
      .then((s) => s && applyStatus(s))
      .catch((e) => console.warn('[browse] watcher status failed', e.message));
  }

  renderState();
  show('library');
  return { show, openDocument, ready: () => state.loaded };
}
