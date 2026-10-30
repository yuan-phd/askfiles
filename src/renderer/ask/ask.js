// Ask page: one question box, an answer streamed from the shell's answer pipeline
// (window.askfiles.answer, src/main/answer) with numbered citations, cards for the cited sections,
// the other selected sections under a collapsed heading, and the nearest sections when nothing
// answers. The API client (../api/client.js) is kept for the library count only. The top bar
// (../shared/topbar.js) holds the library, its status and the switch that shows the browse view
// (../browse/view.js) in place of the Ask page, without a reload.
import { createBrowseView } from '../browse/view.js';
import { createClient, generateApiKey } from '../api/client.js';
import { mountTopBar } from '../shared/topbar.js';

const RECENT_LIMIT = 12;
const RECENT_KEY = 'askfiles.recentQuestions';
const PREVIEW_CHARS = 180;

const $ = (id) => document.getElementById(id);
const els = {
  form: $('query-form'),
  query: $('query'),
  submit: $('submit'),
  result: $('result'),
  question: $('result-question'),
  answer: $('answer'),
  progress: $('answer-progress'),
  answerText: $('answer-text'),
  answerNote: $('answer-note'),
  sources: $('sources'),
  sourceList: $('source-list'),
  considered: $('considered'),
  consideredList: $('considered-list'),
  fallback: $('fallback'),
  fallbackLead: $('fallback-lead'),
  fallbackList: $('fallback-list'),
  error: $('error'),
  recentList: $('recent-list'),
  recentEmpty: $('recent-empty'),
  cardTemplate: $('card-template'),
  sectionTemplate: $('section-template'),
  searchView: $('view-search'),
  browseView: $('view-browse'),
  dev: $('dev'),
  devControls: $('dev-controls'),
  devCount: $('dev-count'),
  devFloor: $('dev-floor'),
  devStatus: $('dev-status'),
  devTrace: $('dev-trace'),
  devExpected: $('dev-expected'),
  devSave: $('dev-save'),
};

/**
 * Inside Electron the shell sets window.shellConfig before this script runs. In a plain browser
 * the same keys come from the query string: ?baseUrl=&apiKey=&workspace=&folder=
 */
function readConfig() {
  const shell = window.shellConfig || {};
  const params = new URLSearchParams(window.location.search);
  const pick = (key) => shell[key] ?? params.get(key) ?? null;
  return {
    baseUrl: pick('baseUrl'),
    apiKey: pick('apiKey'),
    workspace: pick('workspace'),
    folder: pick('folder'),
  };
}

const config = readConfig();
const answers = window.askfiles?.answer;
const state = {
  client: null,
  slug: null,
  recent: [],
  documentCount: null,
  view: 'search',
  browse: null,
  // The run being shown: its id once ask() resolved, the events that came before that, its parts.
  run: null,
  developer: false,
  trace: null,
  expected: null,
};

const bar = mountTopBar($('top-bar'), {
  views: { search: els.searchView, browse: els.browseView },
  onView: (view) => showView(view),
});

function setState(kind, text) {
  bar.setConnection(kind, text);
}

async function connect() {
  if (!config.baseUrl) {
    setState('error', 'Not connected');
    return false;
  }
  try {
    const apiKey = config.apiKey || (await generateApiKey({ baseUrl: config.baseUrl }));
    state.client = createClient({ baseUrl: config.baseUrl, apiKey });
    state.slug = config.workspace || (await state.client.ensureLibrary()).slug;
    const ws = await state.client.getWorkspace(state.slug);
    state.documentCount = ws?.documents?.length ?? 0;
    // The watcher counts files; without it (a plain browser) the workspace counts section documents.
    bar.setFallbackCount(state.documentCount);
    setState('ready', 'Up to date');
    return true;
  } catch (e) {
    console.error('[ask] connect failed', e);
    setState('error', 'Library not reachable');
    return false;
  }
}

// Every question is answered on its own, so recent questions live in this page's storage.
function loadRecent() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(RECENT_KEY) || '[]');
    if (Array.isArray(stored)) state.recent = stored.filter((q) => typeof q === 'string').slice(0, RECENT_LIMIT);
  } catch {
    state.recent = [];
  }
  renderRecent();
}

function saveRecent() {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(state.recent));
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the list then lasts for this page only.
  }
}

function rememberQuestion(q) {
  state.recent = [q, ...state.recent.filter((r) => r !== q)].slice(0, RECENT_LIMIT);
  saveRecent();
  renderRecent();
}

function renderRecent() {
  els.recentList.replaceChildren(
    ...state.recent.map((q) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'recent-item';
      btn.dataset.testid = 'recent-item';
      btn.textContent = q;
      btn.title = q;
      btn.addEventListener('click', () => {
        els.query.value = q;
        autoGrow();
        ask(q);
      });
      li.append(btn);
      return li;
    }),
  );
  els.recentEmpty.hidden = state.recent.length > 0;
}

/** Page 3, Pages 3 to 5, plus the printed label when the PDF has one. */
function pageLabel(c) {
  if (!c.pageStart) return null;
  const range = c.pageEnd && c.pageEnd !== c.pageStart ? `Pages ${c.pageStart} to ${c.pageEnd}` : `Page ${c.pageStart}`;
  return c.pageLabel && c.pageLabel !== String(c.pageStart) ? `${range} (printed ${c.pageLabel})` : range;
}

function pathLabel(c) {
  return (c.path && c.path.length ? c.path : [c.title]).filter(Boolean).join(' > ');
}

async function openSource(c) {
  const detail = { title: c.file, url: c.url, sectionTitle: c.title, sectionIndex: c.sectionIndex, page: c.pageStart };
  window.dispatchEvent(new CustomEvent('askfiles:open-source', { detail }));
  if (typeof window.shellConfig?.openSource !== 'function') {
    console.log(`[ask] open source ${JSON.stringify(detail)}`);
    return;
  }
  try {
    // The shell reveals the original file; false means it is no longer in the library folder.
    if ((await window.shellConfig.openSource(detail)) === false) {
      showError(`${detail.title} is no longer in your documents folder.`);
    }
  } catch (e) {
    showError(`${detail.title} could not be opened: ${e.message}`);
  }
}

function showView(view) {
  state.view = view;
  if (view === 'browse' && !state.browse) state.browse = createBrowseView(els.browseView);
  bar.setView(view);
  if (view === 'search' && !bar.isEmpty()) els.query.focus();
}

/** Opens the cited section on the browse view's document page. */
function readSection(c) {
  showView('browse');
  state.browse.openDocument(
    { id: c.documentId, url: c.url, title: c.file },
    { sectionIndex: c.sectionIndex, sectionTitle: c.title },
  );
}

function setOptional(el, text) {
  el.hidden = !text;
  el.textContent = text || '';
}

/** One card per source; every field comes from the section records the shell sent. */
function cardNode(c, { numbered = true } = {}) {
  const node = els.cardTemplate.content.firstElementChild.cloneNode(true);
  node.id = numbered ? `source-${c.n}` : '';
  node.dataset.n = String(c.n);
  setOptional(node.querySelector('.card-number'), numbered ? `[${c.n}]` : null);
  node.querySelector('.card-file').textContent = c.file;
  setOptional(node.querySelector('.card-section'), pathLabel(c));
  setOptional(node.querySelector('.card-page'), pageLabel(c));
  const p = document.createElement('blockquote');
  p.className = 'passage';
  p.dataset.testid = 'source-passage';
  p.textContent = c.passage;
  node.querySelector('.card-passages').append(p);
  setOptional(node.querySelector('.card-count'), c.trimmed ? 'Shortened to fit' : null);
  node.querySelector('.open').addEventListener('click', () => openSource(c));
  node.querySelector('.read').addEventListener('click', () => readSection(c));
  return node;
}

function renderCards(cited, considered) {
  els.sourceList.replaceChildren(...cited.map((c) => cardNode(c)));
  els.sources.hidden = cited.length === 0;
  els.consideredList.replaceChildren(...considered.map((c) => cardNode(c, { numbered: false })));
  els.considered.hidden = considered.length === 0;
  els.considered.open = false;
}

function preview(text) {
  const flat = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS).trimEnd()}...` : flat;
}

function renderFallback(nearest) {
  els.fallbackList.replaceChildren(
    ...nearest.map((c) => {
      const node = els.sectionTemplate.content.firstElementChild.cloneNode(true);
      node.querySelector('.section-title').textContent = pathLabel(c);
      setOptional(node.querySelector('.section-file'), c.file);
      setOptional(node.querySelector('.section-page'), pageLabel(c));
      node.querySelector('.section-preview').textContent = preview(c.passage);
      node.querySelector('.open').addEventListener('click', () => openSource(c));
      node.querySelector('.read').addEventListener('click', () => readSection(c));
      return node;
    }),
  );
  els.fallbackLead.textContent = nearest.length
    ? 'These sections are the closest matches. Open one to read it.'
    : 'No section in your documents matches this question.';
  els.fallback.hidden = false;
}

function resetResult() {
  els.answerText.replaceChildren();
  els.answerNote.hidden = true;
  els.progress.hidden = true;
  els.sources.hidden = true;
  els.sourceList.replaceChildren();
  els.considered.hidden = true;
  els.consideredList.replaceChildren();
  els.fallback.hidden = true;
  els.fallbackList.replaceChildren();
  els.error.hidden = true;
  els.error.textContent = '';
}

function showProgress(text) {
  els.progress.hidden = !text;
  els.progress.textContent = text || '';
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

function citeNode(n, valid) {
  const a = document.createElement(valid ? 'a' : 'span');
  a.className = 'cite';
  a.dataset.testid = 'cite';
  a.textContent = `[${n}]`;
  if (valid) {
    a.href = `#source-${n}`;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(`source-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }
  return a;
}

/** The answer while it streams: text and citation markers in arrival order. */
function renderStreaming(parts, max) {
  els.answerText.replaceChildren(
    ...parts.map((p) => (p.type === 'cite' ? citeNode(p.n, p.n >= 1 && p.n <= max) : document.createTextNode(p.text))),
  );
}

/** The finished answer, sentence by sentence; a sentence citing nothing gets a muted marker. */
function renderClaims(claims) {
  els.answerText.replaceChildren(
    ...claims.map((c) => {
      const span = document.createElement('span');
      span.className = c.unsupported ? 'claim unsupported' : 'claim';
      span.dataset.testid = c.unsupported ? 'claim-unsupported' : 'claim';
      span.append(document.createTextNode(c.text.replace(/\s+$/, '')));
      for (const n of c.citations) span.append(citeNode(n, true));
      if (c.unsupported) {
        const mark = document.createElement('span');
        mark.className = 'unsupported-mark';
        mark.title = 'No source supports this sentence';
        span.append(mark);
      }
      const trailing = /\s+$/.exec(c.text)?.[0] ?? ' ';
      span.append(document.createTextNode(trailing));
      return span;
    }),
  );
  els.answerNote.hidden = !claims.some((c) => c.unsupported);
}

function handleEvent(e) {
  const run = state.run;
  if (!run) return;
  if (run.id === null) {
    run.early.push(e);
    return;
  }
  if (e.id !== run.id) return;
  switch (e.type) {
    case 'stage':
      showProgress(e.stage === 'answering' ? 'Reading the matching sections' : 'Searching your documents');
      break;
    case 'sources':
      run.sources = e.sources;
      break;
    case 'delta':
      run.parts.push(...e.parts);
      showProgress(null);
      renderStreaming(run.parts, run.sources.length);
      break;
    case 'trace':
      renderTrace(e.trace);
      break;
    case 'done':
      finish(e.result);
      break;
    case 'error':
      endRun();
      showProgress(null);
      showError(`Something went wrong while answering: ${e.message}`);
      break;
  }
}

function endRun() {
  els.answer.setAttribute('aria-busy', 'false');
  els.submit.disabled = false;
  state.run = null;
}

function finish(result) {
  endRun();
  showProgress(null);
  if (result.notFound) {
    els.answerText.replaceChildren();
    renderFallback(result.nearest);
    return;
  }
  if (result.claims.length) renderClaims(result.claims);
  else els.answerText.textContent = 'The model returned an empty answer. The sections below may still help.';
  renderCards(result.cited, result.considered);
}

async function ask(question) {
  question = question.trim();
  if (!question) return;
  els.result.hidden = false;
  resetResult();
  if (!answers) {
    showError('Answers need the AskFiles app; this page is open in a plain browser.');
    return;
  }
  if (state.run?.id) answers.cancel(state.run.id).catch(() => {});
  els.question.textContent = question;
  els.answer.setAttribute('aria-busy', 'true');
  els.submit.disabled = true;
  showProgress('Searching your documents');
  rememberQuestion(question);
  const run = { id: null, early: [], parts: [], sources: [] };
  state.run = run;
  try {
    const { id } = await answers.ask(question);
    if (state.run !== run) return;
    run.id = id;
    // Events sent before ask() resolved, in order.
    for (const e of run.early.splice(0)) handleEvent(e);
  } catch (e) {
    if (state.run !== run) return;
    endRun();
    showProgress(null);
    showError(e.message);
  }
}

function clearAll() {
  if (state.run?.id) answers?.cancel(state.run.id).catch(() => {});
  state.run = null;
  els.query.value = '';
  autoGrow();
  resetResult();
  els.result.hidden = true;
  els.answer.setAttribute('aria-busy', 'false');
  els.submit.disabled = false;
  els.query.focus();
}

function autoGrow() {
  els.query.style.height = 'auto';
  els.query.style.height = `${Math.min(els.query.scrollHeight, 240)}px`;
}

// --- developer panel (ASKFILES_DEVELOPER=1) -----------------------------------------------------

function cell(text, cls) {
  const td = document.createElement('td');
  td.textContent = text === null || text === undefined ? '-' : String(text);
  if (cls) td.className = cls;
  return td;
}

function table(title, head, rows) {
  const wrap = document.createElement('section');
  const h = document.createElement('h3');
  h.textContent = title;
  const t = document.createElement('table');
  const tr = document.createElement('tr');
  for (const x of head) {
    const th = document.createElement('th');
    th.textContent = x;
    tr.append(th);
  }
  t.append(tr, ...rows);
  wrap.append(h, t);
  return wrap;
}

const fmt = (n, d = 3) => (typeof n === 'number' ? n.toFixed(d) : null);

function renderTrace(trace) {
  state.trace = trace;
  state.expected = null;
  els.devSave.disabled = true;
  els.devExpected.textContent = 'Click a candidate row to mark it as the expected section.';
  if (!state.developer) return;
  const candidates = trace.candidates.map((c) => {
    const tr = document.createElement('tr');
    tr.className = c.selected ? 'selected' : '';
    tr.dataset.testid = 'dev-candidate';
    tr.append(cell(c.file), cell(c.path.join(' > ')), cell(fmt(c.rerank)), cell(c.selected ? 'selected' : c.dropped));
    tr.addEventListener('click', () => {
      for (const r of els.devTrace.querySelectorAll('tr.expected')) r.classList.remove('expected');
      tr.classList.add('expected');
      state.expected = c;
      els.devExpected.textContent = `Expected: ${c.file}, ${c.path.join(' > ')}`;
      els.devSave.disabled = false;
    });
    return tr;
  });
  const row = (values) => {
    const tr = document.createElement('tr');
    tr.append(...values.map((v) => cell(v)));
    return tr;
  };
  els.devTrace.replaceChildren(
    table(
      `Candidates (scope ${trace.scope}, floor ${trace.floor}, count ${trace.count}, ${trace.usedTokens} of ${trace.budgetTokens} tokens${trace.bypassReason ? `, rerank bypassed: ${trace.bypassReason}` : ''})`,
      ['File', 'Section', 'Rerank', 'Outcome'],
      candidates,
    ),
    table(
      'Fusion',
      ['Section', 'Score', 'Vector rank', 'Keyword rank'],
      trace.fused.slice(0, 20).map((f) => row([f.key, fmt(f.score, 4), f.vectorRank, f.keywordRank])),
    ),
    table(
      'Vector',
      ['#', 'File', 'Section', 'Score', 'Text'],
      trace.vector.map((v) => row([v.rank, v.file, v.section, fmt(v.score), v.preview])),
    ),
    table(
      `Keyword (${trace.terms.map((t) => `${t.text} [${t.df}]`).join(', ') || 'no terms'})`,
      ['#', 'Section', 'BM25', 'Terms'],
      trace.keyword.map((k) => row([k.rank, k.section, fmt(k.score, 2), k.terms.join(', ')])),
    ),
  );
  const t = trace.timings;
  els.devStatus.textContent = `vector ${t.vectorMs} ms, keyword ${t.keywordMs} ms, rerank ${t.rerankMs} ms`;
}

async function initDeveloper() {
  if (!answers) return;
  let info;
  try {
    info = await answers.developer();
  } catch {
    return;
  }
  if (!info?.enabled) return;
  state.developer = true;
  els.dev.hidden = false;
  document.body.classList.add('developer');
  els.devCount.value = info.overrides.sectionCount ?? '';
  els.devFloor.value = info.overrides.rerankFloor ?? '';
  if (info.trace) renderTrace(info.trace);
  els.devControls.addEventListener('submit', async (e) => {
    e.preventDefault();
    const num = (v) => (v.trim() === '' ? null : Number(v));
    try {
      const o = await answers.setOverrides({
        sectionCount: num(els.devCount.value),
        rerankFloor: num(els.devFloor.value),
      });
      els.devStatus.textContent = `Next question: section count ${o.sectionCount ?? 'preset'}, rerank floor ${o.rerankFloor ?? 'preset'}`;
    } catch (err) {
      els.devStatus.textContent = err.message;
    }
  });
  els.devSave.addEventListener('click', async () => {
    const c = state.expected;
    if (!c || !state.trace) return;
    try {
      const saved = await answers.saveCase({
        question: state.trace.question,
        file: c.file,
        path: c.path,
        pageStart: c.pageStart ?? null,
      });
      els.devStatus.textContent = `Saved ${saved.id} to ${saved.file}`;
    } catch (err) {
      els.devStatus.textContent = err.message;
    }
  });
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  ask(els.query.value);
});

els.query.addEventListener('keydown', (e) => {
  // isComposing guards Chinese and Japanese input methods, where Enter confirms a candidate.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    ask(els.query.value);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.isComposing && state.view === 'search') {
    e.preventDefault();
    clearAll();
  }
});

els.query.addEventListener('input', autoGrow);

if (answers) answers.onEvent(handleEvent);

loadRecent();
void initDeveloper();
connect().then((connected) => {
  document.documentElement.dataset.ready = 'true';
  window.askfiles?.app?.pageReady({ page: 'ask', connected, documents: state.documentCount });
});
els.query.focus();
