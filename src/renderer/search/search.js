// Search page: one question box, a streamed answer, merged source cards and a section list when
// nothing answers the question. Talks to the backend only through ../api/client.js.
import {
  createClient,
  generateApiKey,
  normalizeSource,
  mergeBySection,
  isNothingFound,
  splitThinking,
  REFUSAL_TEXT,
} from '../api/client.js';

const FALLBACK_TOP_N = 8;
const RECENT_LIMIT = 12;
const RECENT_KEY = 'askfiles.recentQuestions';
const PREVIEW_CHARS = 180;

const $ = (id) => document.getElementById(id);
const els = {
  folder: $('status-folder'),
  count: $('status-count'),
  state: $('status-state'),
  stateText: $('status-state-text'),
  form: $('query-form'),
  query: $('query'),
  submit: $('submit'),
  result: $('result'),
  question: $('result-question'),
  answer: $('answer'),
  progress: $('answer-progress'),
  answerText: $('answer-text'),
  sources: $('sources'),
  sourceList: $('source-list'),
  fallback: $('fallback'),
  fallbackLead: $('fallback-lead'),
  fallbackList: $('fallback-list'),
  error: $('error'),
  recentList: $('recent-list'),
  recentEmpty: $('recent-empty'),
  cardTemplate: $('card-template'),
  sectionTemplate: $('section-template'),
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
    refusalText: pick('refusalText') || REFUSAL_TEXT,
  };
}

const config = readConfig();
const state = { client: null, slug: null, controller: null, recent: [], documentCount: null, indexing: null };

function setState(kind, text) {
  els.state.dataset.state = kind;
  els.stateText.textContent = text;
}

function renderCount() {
  const n = state.documentCount;
  if (n === null) return;
  els.count.textContent = n === 1 ? '1 document indexed' : `${n} documents indexed`;
}

function renderIndexing() {
  const s = state.indexing;
  if (s && s.state === 'indexing') {
    const pending = Number(s.pending) || 0;
    setState('indexing', pending > 0 ? `Indexing, ${pending} left` : 'Indexing');
  } else if (s && s.state === 'error') {
    setState('error', s.message || 'Indexing stopped');
  } else {
    setState('ready', 'Up to date');
  }
}

function folderLabel(folder) {
  if (!folder) return 'No folder chosen';
  return folder;
}

async function connect() {
  els.folder.textContent = folderLabel(config.folder);
  els.folder.title = config.folder || '';
  if (!config.baseUrl) {
    setState('error', 'Not connected');
    els.count.textContent = 'No library server';
    return false;
  }
  try {
    const apiKey = config.apiKey || (await generateApiKey({ baseUrl: config.baseUrl }));
    state.client = createClient({ baseUrl: config.baseUrl, apiKey });
    state.slug = config.workspace || (await state.client.ensureLibrary()).slug;
    await refreshLibrary();
    renderIndexing();
    return true;
  } catch (e) {
    console.error('[search] connect failed', e);
    setState('error', 'Library not reachable');
    els.count.textContent = '';
    return false;
  }
}

async function refreshLibrary() {
  const ws = await state.client.getWorkspace(state.slug);
  state.documentCount = ws?.documents?.length ?? 0;
  renderCount();
}

// Each question goes out with its own session id (see newSessionId in the client), and upstream
// does not list per-session chats without that id, so recent questions live in this page's storage.
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

function pagesLabel(pages) {
  if (!pages.length) return null;
  if (pages.length === 1) return `Page ${pages[0]}`;
  const contiguous = pages.every((p, i) => i === 0 || p === pages[i - 1] + 1);
  return contiguous ? `Pages ${pages[0]} to ${pages[pages.length - 1]}` : `Pages ${pages.join(', ')}`;
}

function openSource(group) {
  const detail = {
    title: group.title,
    url: group.url,
    sectionTitle: group.sectionTitle,
    sectionIndex: group.sectionIndex,
    page: group.pages[0] ?? null,
  };
  window.dispatchEvent(new CustomEvent('askfiles:open-source', { detail }));
  if (typeof window.shellConfig?.openSource === 'function') window.shellConfig.openSource(detail);
  else console.log(`[search] open source ${JSON.stringify(detail)}`);
}

function setOptional(el, text) {
  el.hidden = !text;
  el.textContent = text || '';
}

function renderCards(groups) {
  els.sourceList.replaceChildren(
    ...groups.map((g) => {
      const node = els.cardTemplate.content.firstElementChild.cloneNode(true);
      node.querySelector('.card-file').textContent = g.title;
      setOptional(node.querySelector('.card-section'), g.sectionTitle);
      setOptional(node.querySelector('.card-page'), pagesLabel(g.pages));
      const passages = node.querySelector('.card-passages');
      for (const text of g.passages) {
        const p = document.createElement('blockquote');
        p.className = 'passage';
        p.dataset.testid = 'source-passage';
        p.textContent = text;
        passages.append(p);
      }
      setOptional(
        node.querySelector('.card-count'),
        g.passages.length > 1 ? `${g.passages.length} passages from this section` : null,
      );
      node.querySelector('.open').addEventListener('click', () => openSource(g));
      return node;
    }),
  );
  els.sources.hidden = groups.length === 0;
}

function preview(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS).trimEnd()}...` : flat;
}

function renderFallback(groups) {
  els.fallbackList.replaceChildren(
    ...groups.map((g) => {
      const node = els.sectionTemplate.content.firstElementChild.cloneNode(true);
      const title = g.sectionTitle || g.title;
      node.querySelector('.section-title').textContent = title;
      // Without a section title the file name is already the heading, so it is not repeated.
      setOptional(node.querySelector('.section-file'), g.sectionTitle ? g.title : null);
      setOptional(node.querySelector('.section-page'), pagesLabel(g.pages));
      node.querySelector('.section-preview').textContent = preview(g.passages[0] || '');
      node.querySelector('.open').addEventListener('click', () => openSource(g));
      return node;
    }),
  );
  els.fallbackLead.textContent = groups.length
    ? 'These sections are the closest matches. Open one to read it.'
    : 'No section in your documents matches this question.';
  els.fallback.hidden = false;
}

function resetResult() {
  els.answerText.textContent = '';
  els.progress.hidden = true;
  els.sources.hidden = true;
  els.sourceList.replaceChildren();
  els.fallback.hidden = true;
  els.fallbackList.replaceChildren();
  els.error.hidden = true;
  els.error.textContent = '';
}

function showProgress(text) {
  els.progress.hidden = !text;
  els.progress.textContent = text || '';
}

function renderAnswer(text) {
  els.answerText.replaceChildren(
    ...text
      .split(/\n{2,}/)
      .filter((p) => p.trim())
      .map((p) => {
        const el = document.createElement('p');
        el.textContent = p.trim();
        return el;
      }),
  );
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

/**
 * vector-search drops the custom section keys that chat sources carry (docs/upstream-analysis.md
 * Q15), so the shell, which wrote the section documents, may fill them back in through
 * shellConfig.resolveSources(sources) => sources. Without it the fallback lists file names.
 */
async function resolveSources(sources) {
  const resolve = window.shellConfig?.resolveSources;
  if (typeof resolve !== 'function') return sources;
  try {
    const resolved = await resolve(sources);
    return Array.isArray(resolved) ? resolved : sources;
  } catch (e) {
    console.warn('[search] resolveSources failed', e.message);
    return sources;
  }
}

async function showFallback(question, signal) {
  showProgress('Looking for related sections');
  try {
    // scoreThreshold 0 lists the nearest sections even below the workspace threshold that made
    // query mode refuse; those near misses are what the user can still read.
    const results = await state.client.vectorSearch(state.slug, question, {
      topN: FALLBACK_TOP_N,
      scoreThreshold: 0,
      signal,
    });
    renderFallback(mergeBySection(await resolveSources(results.map(normalizeSource))));
  } catch (e) {
    if (e.name === 'AbortError') return;
    renderFallback([]);
    console.warn('[search] section search failed', e.message);
  } finally {
    showProgress(null);
  }
}

async function ask(question) {
  question = question.trim();
  if (!question) return;
  if (!state.client && !(await connect())) {
    els.result.hidden = false;
    resetResult();
    showError('The library is not reachable. Try again in a moment.');
    return;
  }
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  const { signal } = controller;

  els.result.hidden = false;
  resetResult();
  els.question.textContent = question;
  els.answer.setAttribute('aria-busy', 'true');
  els.submit.disabled = true;
  showProgress('Searching your documents');
  rememberQuestion(question);

  let raw = '';
  let sources = [];
  let failed = null;
  try {
    for await (const event of state.client.streamChat(state.slug, question, { signal })) {
      if (event.type === 'abort' || (event.error && typeof event.error === 'string')) {
        failed = event.error || 'The answer could not be completed.';
        break;
      }
      if (Array.isArray(event.sources) && event.sources.length) sources = event.sources;
      if (event.type === 'textResponse') raw = event.textResponse || '';
      else if (event.type === 'textResponseChunk') raw += event.textResponse || '';
      const { answer, thinking } = splitThinking(raw);
      if (answer) {
        showProgress(null);
        renderAnswer(answer);
      } else if (thinking) {
        showProgress('Reading the matching passages');
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    failed = e.message;
  } finally {
    if (state.controller === controller) {
      els.answer.setAttribute('aria-busy', 'false');
      els.submit.disabled = false;
    }
  }
  if (signal.aborted) return;

  if (failed) {
    showProgress(null);
    showError(`Something went wrong while answering: ${failed}`);
    return;
  }

  const { answer } = splitThinking(raw);
  if (isNothingFound({ text: raw, sources }, config.refusalText)) {
    els.answerText.textContent = '';
    await showFallback(question, signal);
    return;
  }
  showProgress(null);
  renderAnswer(answer || 'The model returned an empty answer. The sources below may still help.');
  renderCards(mergeBySection(sources.map(normalizeSource)));
}

function clearAll() {
  state.controller?.abort();
  state.controller = null;
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
  if (e.key === 'Escape' && !e.isComposing) {
    e.preventDefault();
    clearAll();
  }
});

els.query.addEventListener('input', autoGrow);

// Hook for the shell: folder watcher status and library changes arrive here (Session F).
window.askfiles = {
  setIndexStatus(status) {
    state.indexing = status || null;
    if (state.client) renderIndexing();
  },
  setFolder(folder) {
    config.folder = folder;
    els.folder.textContent = folderLabel(folder);
    els.folder.title = folder || '';
  },
  async refresh() {
    if (state.client) await refreshLibrary();
  },
};

loadRecent();
connect().then(() => {
  document.documentElement.dataset.ready = 'true';
});
els.query.focus();
