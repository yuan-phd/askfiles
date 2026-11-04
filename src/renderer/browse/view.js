// Browse view: read the library without asking anything. Library, headings, find and document
// pages, all drawn from the shell's browse index through window.askfiles.browse; no model and no
// server call. Mounted by the Ask page next to Ask, and by browse/index.html on its own.
//
// A fixed sidebar holds the four entries; only the content area scrolls. Document appears once a
// document is open, labelled with its file name and with its outline below it. Opening a document
// (from any page, or Read section on the Ask page) always lands on Document and never changes what
// Library, Headings or Find show.
//
// Every move between pages and documents goes into the page history (shared/history.js): the
// Ask page passes its own, which spans Ask and Browse; on its own the view keeps one. Back at the
// top of the sidebar, always shown and disabled when there is nothing to go back to, and Cmd+[
// return to the place before, as it was left.

const MARKUP = `
<nav class="browse-sidebar" aria-label="Browse" data-testid="browse-sidebar">
  <button type="button" class="sidebar-back" data-testid="browse-back" aria-keyshortcuts="Meta+BracketLeft" title="Back (Cmd+[)" disabled>Back</button>
  <button type="button" class="browse-tab" data-tab="library" data-testid="browse-tab-library">Library</button>
  <button type="button" class="browse-tab" data-tab="headings" data-testid="browse-tab-headings">Headings</button>
  <button type="button" class="browse-tab" data-tab="find" data-testid="browse-tab-find">Find</button>
  <button type="button" class="browse-tab" data-tab="overview" data-testid="browse-tab-overview">Overview</button>
  <div class="sidebar-doc" data-testid="sidebar-doc" hidden>
    <button type="button" class="browse-tab doc-tab" data-tab="document" data-testid="browse-tab-document"></button>
    <ol class="outline" data-testid="doc-outline"></ol>
    <p class="rail-empty" data-testid="doc-outline-empty" hidden>No headings in this document.</p>
  </div>
</nav>
<div class="browse-content" data-testid="browse-content">

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
  <section class="family-questions" data-testid="family-questions" hidden aria-label="Possible copies of one document">
    <h2 class="family-title">Are these the same document?</h2>
    <p class="hint">AskFiles groups copies and issues of one document (a PDF and its Word file, the 2024 and 2025 editions). It is not sure about these.</p>
    <ul class="family-list" data-testid="family-list"></ul>
  </section>
  <ul class="library-list" data-testid="library-list"></ul>
  <p class="browse-empty" data-testid="library-empty" hidden>No documents yet. Files in your documents folder appear here once they are indexed.</p>
</section>

<section class="browse-page" data-page="document" data-testid="document" aria-label="Document" hidden>
  <article class="doc-body">
    <header class="doc-head">
      <h1 class="doc-title" data-testid="doc-title"></h1>
      <p class="doc-path" data-testid="doc-path"></p>
      <button type="button" class="open" data-testid="doc-open">Open original</button>
      <p class="doc-summary" data-testid="doc-summary" hidden></p>
      <div class="doc-summary-actions" data-testid="doc-summary-actions" hidden>
        <span class="has-tip">
          <button type="button" class="link" data-testid="doc-summarize-sections" aria-describedby="tip-doc-sections"></button>
          <span class="tip" id="tip-doc-sections" role="tooltip" data-testid="doc-summarize-tip">Uses the model on this computer. Ask is slower while it runs. You can pause it in the top bar.</span>
        </span>
        <span class="doc-summary-state" data-testid="doc-summary-state"></span>
      </div>
    </header>
    <p class="error" data-testid="doc-error" role="alert" hidden></p>
    <div class="doc-sections" data-testid="doc-sections"></div>
  </article>
</section>

<section class="browse-page" data-page="headings" data-testid="headings" aria-label="Headings" hidden>
  <div class="headings-layout">
    <div class="headings-index">
      <p class="hint">Headings found in two or more documents.</p>
      <ul class="headings-list" data-testid="headings-list"></ul>
      <p class="browse-empty" data-testid="headings-empty" hidden></p>
    </div>
    <div class="headings-detail" data-testid="headings-detail" aria-live="polite">
      <p class="browse-empty">Choose a heading to see that section from every document side by side.</p>
    </div>
  </div>
</section>

<section class="browse-page overview-page" data-page="overview" data-testid="overview" aria-label="Overview" hidden>
  <div class="overview-root" data-testid="overview-root"></div>
</section>

<section class="browse-page" data-page="find" data-testid="find" aria-label="Find" hidden>
  <form class="query find-form" autocomplete="off">
    <label class="visually-hidden" for="find-query">Find words in your documents</label>
    <input id="find-query" type="search" data-testid="find-query" placeholder="Find words in your documents" spellcheck="false" />
    <button type="submit" data-testid="find-submit">Find</button>
  </form>
  <p class="hint">Every word must appear in the section; put words in quotes for an exact phrase. Sections with the words side by side come first. Chinese matches anywhere in the text.</p>
  <p class="find-summary" data-testid="find-summary" hidden></p>
  <ol class="find-results" data-testid="find-results"></ol>
</section>
</div>
`;

import { createHistory, isBackKey } from '../shared/history.js';
import { createOverview } from './overview.js';

const bridge = window.askfiles?.browse;
const watcher = window.askfiles?.watcher;
const graphBridge = window.askfiles?.graph;
const summariesBridge = window.askfiles?.summaries;

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

/**
 * Page or sheet label; spreadsheets carry the sheet number in the page fields. When the PDF
 * prints its own page labels (iv, A-3) they lead, with the PDF page index after them.
 */
export function placeLabel(start, end, fileName = '', labelStart = null, labelEnd = null) {
  if (!start) return '';
  const unit = /\.(xlsx|xlsm|xls|csv)$/i.test(fileName) ? 'Sheet' : 'Page';
  const single = !end || end === start;
  if (labelStart && unit === 'Page') {
    const printed = single || !labelEnd ? labelStart : `${labelStart} to ${labelEnd}`;
    const index = single ? `PDF page ${start}` : `PDF pages ${start} to ${end}`;
    return `${single ? 'Page' : 'Pages'} ${printed} (${index})`;
  }
  if (single) return `${unit} ${start}`;
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
 * Builds the browse view inside root. Returns { show(tab), openDocument(ref, target), current(),
 * restore(entry), scrollTop() }: ref is { id } or a source's { url, title }; target is
 * { sectionIndex, sectionTitle }. history is the page history to record moves in; without one the
 * view keeps its own and listens for Cmd+[ itself.
 */
export function createBrowseView(root, { history: shared = null } = {}) {
  root.classList.add('browse');
  root.innerHTML = MARKUP;
  const q = (testid) => root.querySelector(`[data-testid="${testid}"]`);
  const pages = Object.fromEntries([...root.querySelectorAll('.browse-page')].map((p) => [p.dataset.page, p]));
  const tabs = [...root.querySelectorAll('.browse-tab')];
  const state = {
    page: 'library',
    documents: [],
    sort: 'name',
    expanded: new Set(),
    doc: null,
    headingKey: null,
    status: null,
    loaded: false,
    // The overview graph (types, summaries, family questions); null without the bridge.
    graph: null,
    docSummary: null,
  };

  const content = q('browse-content');
  const history =
    shared ||
    createHistory({
      initial: { view: 'browse', page: 'library' },
      apply: (e) => restore(e),
      capture: () => ({ scroll: content.scrollTop }),
    });
  if (!shared) {
    document.addEventListener('keydown', (e) => {
      if (!isBackKey(e)) return;
      e.preventDefault();
      history.back();
    });
  }
  const renderBack = () => (q('browse-back').disabled = !history.canGoBack());
  history.onChange(renderBack);
  q('browse-back').addEventListener('click', () => history.back());
  /** Scroll position per page, so coming back to a page finds it where it was left. */
  const scrolls = {};

  function showPage(name) {
    if (state.page !== name) scrolls[state.page] = content.scrollTop;
    const changed = state.page !== name;
    state.page = name;
    for (const [n, p] of Object.entries(pages)) p.hidden = n !== name;
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      if (on) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    }
    if (changed) content.scrollTop = scrolls[name] ?? 0;
  }

  function show(tab) {
    if (tab === 'document' && !state.doc && !state.docRef) return;
    if (tab === 'library' && !state.loaded) void loadLibrary();
    if (tab === 'headings') void loadHeadings();
    showPage(tab);
    content.classList.toggle('overview-on', tab === 'overview');
    if (tab === 'overview') void overview.show();
    else overview.hide();
    if (tab === 'find') q('find-query').focus();
  }

  /** The page shown, as a history entry. */
  function current() {
    const entry = { view: 'browse', page: state.page };
    if (state.page === 'headings') entry.headingKey = state.headingKey;
    if (state.page === 'find') entry.query = state.findQuery ?? '';
    if (state.page === 'document') Object.assign(entry, { ref: state.docRef, target: state.docTarget ?? {} });
    return entry;
  }

  /** Goes to an entry of the history without recording it, and puts its scroll position back. */
  async function restore(entry) {
    if (entry.page === 'document') await openDocument(entry.ref, entry.target, { record: false });
    else {
      show(entry.page);
      if (entry.page === 'headings' && entry.headingKey && entry.headingKey !== state.headingKey)
        await showHeading(entry.headingKey);
      if (entry.page === 'find' && (entry.query ?? '') !== (state.findQuery ?? '')) {
        q('find-query').value = entry.query ?? '';
        await find(entry.query ?? '');
      }
    }
    if (typeof entry.scroll === 'number') content.scrollTop = entry.scroll;
  }

  for (const t of tabs) {
    t.addEventListener('click', () =>
      history.navigate(() => {
        show(t.dataset.tab);
        return current();
      }),
    );
  }

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
      b.dataset.level = String(e.level);
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
        const node = state.graph?.nodes.find((n) => n.id === d.id);
        if (node) row.append(typeControl(node));
        li.append(row);
        const sum = summaryLine(d.id);
        if (sum) li.append(sum);
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

  /** The type of a document: a dropdown of the profile's types; Automatic goes back to detection. */
  function typeControl(node) {
    const wrap = el('label', 'doc-type');
    wrap.append(el('span', 'visually-hidden', `Type of ${node.title}`));
    const select = el('select');
    select.dataset.testid = 'library-type';
    const types = state.graph.profile.types;
    const label = (name) => types.find((t) => t.name === name)?.label || name;
    const auto = el('option', '', `Automatic (${label(node.detectedType)})`);
    auto.value = '';
    select.append(auto, ...types.map((t) => Object.assign(el('option', '', t.label), { value: t.name })));
    select.value = node.overridden ? node.type : '';
    const color = types.find((t) => t.name === node.type)?.color;
    if (color) wrap.style.setProperty('--type-color', color);
    wrap.dataset.overridden = String(node.overridden);
    select.addEventListener('change', async () => {
      try {
        state.graph = (await graphBridge.setType(node.id, select.value || null)) || state.graph;
        renderLibrary();
      } catch (e) {
        console.warn('[browse] type not saved', e.message);
      }
    });
    wrap.append(select);
    return wrap;
  }

  /** The document summary line, Summary pending while it is being made; nothing on a tier without them. */
  function summaryLine(id) {
    const s = state.graph?.summaries?.[id];
    if (!s || s.state === 'off' || s.state === 'none') return null;
    const p = el(
      'p',
      `doc-item-summary${s.state === 'pending' ? ' pending' : ''}`,
      s.state === 'ok' ? s.text : 'Summary pending',
    );
    p.dataset.testid = 'library-summary';
    return p;
  }

  function renderFamilies() {
    const questions = state.graph?.questions || [];
    const box = q('family-questions');
    box.hidden = questions.length === 0;
    const title = (id) => state.graph.nodes.find((n) => n.id === id)?.title || id;
    q('family-list').replaceChildren(
      ...questions.map((f) => {
        const li = el('li', 'family-item');
        li.dataset.testid = 'family-item';
        li.append(el('span', 'family-pair', `${title(f.a)} and ${title(f.b)}`));
        const yes = button('open', 'Same document', 'family-same');
        const no = button('link', 'Different', 'family-different');
        const answer = async (same) => {
          try {
            state.graph = (await graphBridge.answerFamily(f.a, f.b, same)) || state.graph;
            renderFamilies();
          } catch (e) {
            console.warn('[browse] family answer not saved', e.message);
          }
        };
        yes.addEventListener('click', () => answer(true));
        no.addEventListener('click', () => answer(false));
        li.append(yes, no);
        return li;
      }),
    );
  }

  async function loadGraph() {
    if (!graphBridge) return;
    try {
      state.graph = await graphBridge.data();
    } catch (e) {
      console.warn('[browse] overview data failed', e.message);
    }
  }

  async function loadLibrary() {
    if (!bridge) {
      q('library-count').textContent = 'Browsing is available in the AskFiles app.';
      return;
    }
    try {
      const [documents] = await Promise.all([bridge.documents(), loadGraph()]);
      state.documents = documents;
      state.loaded = true;
      renderLibrary();
      renderFamilies();
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

  /** Shows the Document entry in the sidebar, labelled with the file name. */
  function showDocEntry(title) {
    q('sidebar-doc').hidden = false;
    const tab = q('browse-tab-document');
    tab.textContent = title;
    tab.title = title;
  }

  function renderDocument(doc) {
    showDocEntry(doc.title);
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
        const place = placeLabel(s.pageStart, s.pageEnd, doc.title, s.pageLabelStart, s.pageLabelEnd);
        if (place) {
          const p = el('p', 'doc-page', place);
          p.dataset.testid = 'doc-section-page';
          sec.append(p);
        }
        const summary = el('p', 'doc-section-summary');
        summary.dataset.testid = 'doc-section-summary';
        summary.hidden = true;
        sec.append(summary, ...paragraphs(s.text));
        return sec;
      }),
    );
    void loadDocSummary(doc.id);
  }

  /** The summary, the section summaries and the button of the open document. */
  function renderDocSummary() {
    const v = state.docSummary;
    const doc = state.doc;
    const line = q('doc-summary');
    const actions = q('doc-summary-actions');
    if (!v || !doc || v.documentId !== doc.id || v.state === 'off') {
      line.hidden = true;
      actions.hidden = true;
      for (const n of root.querySelectorAll('.doc-section-summary')) n.hidden = true;
      return;
    }
    line.hidden = v.state === 'none';
    line.classList.toggle('pending', v.state === 'pending');
    line.replaceChildren();
    if (v.state === 'ok') {
      line.append(document.createTextNode(`${v.text} `));
      // Cited to the section it was made from, like an Ask sentence.
      if (v.sectionIndex) {
        const cite = button('cite', 'source', 'doc-summary-cite');
        cite.title = 'The section this summary was made from';
        cite.addEventListener('click', () => scrollToSection({ sectionIndex: v.sectionIndex }));
        line.append(cite);
      }
    } else if (v.state === 'pending') line.textContent = 'Summary pending';
    for (const n of root.querySelectorAll('.doc-section')) {
      const sum = n.querySelector('.doc-section-summary');
      const text = v.sections?.[n.dataset.section];
      sum.hidden = !text;
      sum.textContent = text || '';
    }
    actions.hidden = false;
    const b = q('doc-summarize-sections');
    const stateText = q('doc-summary-state');
    if (v.sectionsMissing === 0) {
      b.hidden = true;
      stateText.textContent = Object.keys(v.sections || {}).length ? 'Every section is summarized.' : '';
    } else if (v.sectionsWanted && v.sectionsPending > 0) {
      b.hidden = true;
      stateText.textContent = `Summarizing sections, ${v.sectionsPending} left`;
    } else {
      b.hidden = false;
      const mins = v.estimateMinutes || 1;
      b.textContent = `Summarize each section (about ${mins} ${mins === 1 ? 'minute' : 'minutes'})`;
      stateText.textContent = '';
    }
  }

  async function loadDocSummary(id) {
    if (!summariesBridge) return;
    try {
      const v = await summariesBridge.document(id);
      if (state.doc?.id !== id) return;
      state.docSummary = v;
      renderDocSummary();
    } catch (e) {
      console.warn('[browse] summary failed', e.message);
    }
  }

  q('doc-summarize-sections').addEventListener('click', async () => {
    const doc = state.doc;
    if (!doc || !summariesBridge) return;
    try {
      const v = await summariesBridge.requestSections(doc.id);
      if (v && state.doc?.id === doc.id) {
        state.docSummary = v;
        renderDocSummary();
      }
    } catch (e) {
      console.warn('[browse] section summaries not started', e.message);
    }
  });

  function scrollToSection(target) {
    const doc = state.doc;
    if (!doc) return;
    let index = Number(target?.sectionIndex);
    if (!doc.sections.some((s) => s.index === index) && target?.sectionTitle) {
      index = doc.sections.find((s) => s.title === target.sectionTitle)?.index;
    }
    for (const b of root.querySelectorAll('.sidebar-doc .outline-link')) {
      b.classList.toggle('active', Number(b.dataset.section) === index);
    }
    const sec = root.querySelector(`.doc-section[data-section="${index}"]`);
    for (const s of root.querySelectorAll('.doc-section.target')) s.classList.remove('target');
    if (sec) {
      sec.classList.add('target');
      content.scrollTop += sec.getBoundingClientRect().top - content.getBoundingClientRect().top;
    } else {
      content.scrollTop = 0;
    }
  }

  /** Opens a document at a section; record false when going back through the history. */
  async function openDocument(ref, target = {}, { record = true } = {}) {
    if (record) {
      history.navigate(() => {
        state.docRef = ref;
        state.docTarget = target;
        return { view: 'browse', page: 'document', ref, target };
      });
    }
    state.docRef = ref;
    state.docTarget = target;
    showDocEntry(
      state.doc && (ref.id ? state.doc.id === ref.id : state.doc.url === ref.url)
        ? state.doc.title
        : ref.title || 'Document',
    );
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
    if (state.docRef !== ref) return;
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
    const same = state.doc?.id === doc.id && state.doc?.indexedAt === doc.indexedAt;
    state.doc = doc;
    if (!same) renderDocument(doc);
    else showDocEntry(doc.title);
    scrollToSection(target);
  }

  q('doc-open').addEventListener('click', async () => {
    if (state.doc && (await openOriginal(state.doc)) === false) {
      q('doc-error').textContent = `${state.doc.title} is no longer in your documents folder.`;
      q('doc-error').hidden = false;
    }
  });

  // --- headings ------------------------------------------------------------------------------

  let headingGroups = [];

  function renderHeadings() {
    // The shell lists only headings found in two or more documents; the filter keeps that true here too.
    const groups = headingGroups.filter((g) => g.documents > 1);
    const empty = q('headings-empty');
    empty.hidden = groups.length > 0;
    empty.textContent = 'No heading appears in more than one document yet.';
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
    if (state.page === 'headings') history.replace({ headingKey: key });
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
      const place = placeLabel(e.pageStart, e.pageEnd, e.documentTitle, e.pageLabelStart, e.pageLabelEnd);
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

  // --- find ----------------------------------------------------------------------------------

  async function find(query) {
    state.findQuery = query;
    if (state.page === 'find') history.replace({ query });
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
          const place = placeLabel(h.pageStart, h.pageEnd, g.document.title, h.pageLabelStart, h.pageLabelEnd);
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

  // --- overview --------------------------------------------------------------------------------

  const overview = createOverview(q('overview-root'), {
    getData: async () => {
      if (!graphBridge) return null;
      state.graph = await graphBridge.data();
      return state.graph;
    },
    onOpenDocument: (id, target) => openDocument({ id }, target || {}),
    onOpenHeading: (key) =>
      history.navigate(() => {
        show('headings');
        void showHeading(key);
        return { view: 'browse', page: 'headings', headingKey: key };
      }),
  });

  if (graphBridge) {
    graphBridge.onChange(async () => {
      await loadGraph();
      if (state.loaded) {
        renderLibrary();
        renderFamilies();
      }
      void overview.refresh();
    });
  }
  if (summariesBridge) {
    let summaryTimer = null;
    summariesBridge.onEvent((e) => {
      if (e.type !== 'changed') return;
      // Summaries arrive one by one; the pages refresh once a burst has passed.
      clearTimeout(summaryTimer);
      summaryTimer = setTimeout(async () => {
        await loadGraph();
        if (state.loaded) renderLibrary();
        if (state.graph) overview.updateSummaries(state.graph.summaries);
        if (state.doc && e.ids.includes(state.doc.id)) void loadDocSummary(state.doc.id);
      }, 250);
    });
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
  renderBack();
  return {
    show,
    openDocument,
    current,
    restore,
    scrollTop: () => content.scrollTop,
    ready: () => state.loaded,
    overview,
  };
}
