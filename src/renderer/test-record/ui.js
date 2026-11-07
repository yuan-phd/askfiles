// Test build only (docs/test-build.md); askfiles-test-record-module. Loaded into every AskFiles
// page by the test build's second preload script (src/main/test-record/preload.ts), which also
// exposes window.askfilesTest. The release build has neither: this folder is not packaged there.
// It shows the first-start notice, adds the Test record part to Settings and the test build line
// to About, and passes Browse page opens and source card clicks to the record.
import { TEXTS } from './texts.js';

const api = window.askfilesTest;

/** The language of the notice: Chinese on a system set to Chinese, otherwise English. */
export function language(nav = window.navigator) {
  const langs = [...(nav.languages || []), nav.language || ''];
  return langs.find(Boolean)?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

const t = TEXTS[language()];

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'testid') node.dataset.testid = v;
    else node.setAttribute(k, v);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function addStylesheet() {
  document.head.append(el('link', { rel: 'stylesheet', href: '/test-record/ui.css' }));
}

/** The notice of the first start; the record remembers once it was confirmed. */
function showNotice() {
  const dialog = el('dialog', { class: 'test-dialog', testid: 'test-notice', 'aria-labelledby': 'test-notice-title' });
  dialog.lang = language() === 'zh' ? 'zh-CN' : 'en';
  const ok = el('button', { type: 'button', testid: 'test-notice-continue' }, t.continue);
  const actions = el('div', { class: 'test-actions' });
  actions.append(ok);
  dialog.append(
    el('h2', { id: 'test-notice-title' }, t.noticeTitle),
    el('p', { testid: 'test-notice-text' }, t.notice),
    actions,
  );
  // Escape would close it without the record knowing; Continue is the only way on.
  dialog.addEventListener('cancel', (e) => e.preventDefault());
  ok.addEventListener('click', async () => {
    try {
      await api.noticeShown();
    } finally {
      dialog.close();
      dialog.remove();
    }
  });
  document.body.append(dialog);
  dialog.showModal();
}

/** Asks which export; resolves to 'questions', 'full' or null when cancelled. */
function chooseExport() {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: 'test-dialog', testid: 'test-export-choice' });
    const actions = el('div', { class: 'test-actions' });
    const button = (label, testid, value, cls) => {
      const b = el('button', { type: 'button', testid, ...(cls ? { class: cls } : {}) }, label);
      b.addEventListener('click', () => {
        dialog.close();
        dialog.remove();
        resolve(value);
      });
      return b;
    };
    actions.append(
      button(t.cancel, 'test-export-cancel', null, 'secondary'),
      button(t.exportQuestions, 'test-export-questions', 'questions', 'secondary'),
      button(t.exportFull, 'test-export-full', 'full'),
    );
    dialog.addEventListener('cancel', () => resolve(null));
    dialog.append(el('h2', {}, t.exportTitle), el('p', { class: 'note' }, t.exportNote), actions);
    document.body.append(dialog);
    dialog.showModal();
  });
}

function settingsPart() {
  const part = el('fieldset', { class: 'setting test-record', testid: 'test-record' });
  const status = el('p', { class: 'note', testid: 'test-record-status', role: 'status' });
  const exportButton = el('button', { type: 'button', testid: 'test-record-export' }, t.export);
  const pause = el('button', { type: 'button', class: 'secondary', testid: 'test-record-pause' }, t.pause);
  const clear = el('button', { type: 'button', class: 'secondary', testid: 'test-record-clear' }, t.clear);
  const actions = el('div', { class: 'test-actions' });
  actions.append(exportButton, pause, clear);
  part.append(
    el('legend', {}, t.legend),
    el('p', { class: 'note', testid: 'test-record-notice' }, t.notice),
    actions,
    status,
  );

  let paused = false;
  const show = (s, message) => {
    paused = !!s?.paused;
    pause.textContent = paused ? t.resume : t.pause;
    status.textContent = message ?? (s ? t.status(s.questions, s.events, paused) : '');
  };
  const run = async (work) => {
    for (const b of [exportButton, pause, clear]) b.disabled = true;
    try {
      await work();
    } catch (e) {
      status.textContent = t.failed(e.message);
    } finally {
      for (const b of [exportButton, pause, clear]) b.disabled = false;
    }
  };
  exportButton.addEventListener('click', async () => {
    const mode = await chooseExport();
    if (!mode) return;
    await run(async () => {
      const { file } = await api.exportRecord(mode);
      const s = await api.status();
      show(s, t.exported(file.split(/[\\/]/).pop(), s.platform === 'win32' ? t.explorer : t.finder));
    });
  });
  pause.addEventListener('click', () => run(async () => show(await api.pause(!paused))));
  clear.addEventListener('click', () => {
    if (!window.confirm(t.confirmClear)) return;
    void run(async () => show(await api.clear(), t.cleared));
  });
  const main = document.querySelector('main') || document.body;
  const before = main.querySelector('[data-testid="status"]');
  main.insertBefore(part, before);
  void run(async () => show(await api.status()));
}

function aboutNote() {
  const version = document.querySelector('[data-testid="version"]');
  const note = el('p', { class: 'lead test-build-note', testid: 'test-build-note' }, t.about);
  if (version) version.after(note);
  else (document.querySelector('main') || document.body).prepend(note);
}

function recordPageEvents() {
  const send = (event) => api.record(event).catch(() => {});
  window.addEventListener('askfiles:browse-page', (e) => send({ type: 'browse', ...e.detail }));
  window.addEventListener('askfiles:source-card', (e) => send({ type: 'source', ...e.detail }));
}

async function main() {
  if (!api) return;
  addStylesheet();
  recordPageEvents();
  const page = window.location.pathname;
  if (page.startsWith('/settings/')) settingsPart();
  if (page.startsWith('/about/')) aboutNote();
  try {
    const s = await api.status();
    if (!s.noticeShown) showNotice();
  } catch (e) {
    console.warn('[test-record] status failed', e.message);
  }
}

void main();
