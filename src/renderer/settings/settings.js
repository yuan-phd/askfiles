// Settings page (Session K): answer scope, answer model, context length and reindex, nothing else.
// Values live in the main process (src/main/settings.ts) behind the bridge:
//
//   window.askfiles.settings = {
//     get() -> Promise<{ values, models: { faster, better }, contextDefault, contextChoices, scopes }>
//     set(change) -> Promise<same>   // model and context changes restart the server
//   }
//   window.askfiles.libraries.reindex(), .list(), window.askfiles.models.onProgress(cb)
import { progressText } from '../onboarding/view.js';

const $ = (testid) => document.querySelector(`[data-testid="${testid}"]`);
const bridge = window.askfiles?.settings;
const libraryBridge = window.askfiles?.libraries;
let view = null;
let busy = false;

/** Tokens as a reader would say them: 8192 is 8K. */
export function contextLabel(n) {
  return `${Math.round(n / 1024)}K`;
}

function showMessage(text) {
  $('message').textContent = text || '';
  $('message').hidden = !text;
}

function setStatus(text) {
  $('status').textContent = text || '';
}

function setBusy(value) {
  busy = value;
  for (const i of document.querySelectorAll('input, button')) i.disabled = value || i.dataset.unavailable === 'true';
}

function render(v) {
  view = v;
  for (const r of document.querySelectorAll('input[name="scope"]')) r.checked = r.value === v.values.answerScope;
  const faster = v.models.faster;
  $('model-faster').dataset.unavailable = String(!faster);
  $('model-faster-detail').textContent = faster ? `(${faster.model})` : '(not available on this Mac)';
  $('model-better-detail').textContent = `(${v.models.better.model})`;
  for (const r of document.querySelectorAll('input[name="model"]')) r.checked = r.value === v.values.answerModel;
  const current = v.values.contextLength ?? v.contextDefault;
  // Built once; later renders only move the check, so a clicked radio is never replaced under the pointer.
  if (!$('context-choices').children.length) buildContextChoices(v);
  for (const r of document.querySelectorAll('input[name="context"]')) r.checked = Number(r.value) === current;
  setBusy(busy);
}

function buildContextChoices(v) {
  $('context-choices').replaceChildren(
    ...v.contextChoices.map((n) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'context';
      input.value = String(n);
      input.dataset.testid = `context-${n}`;
      input.addEventListener('change', () => change({ contextLength: n === v.contextDefault ? null : n }));
      label.append(input, ` ${contextLabel(n)}${n === v.contextDefault ? ' (recommended)' : ''}`);
      return label;
    }),
  );
}

async function change(c) {
  if (!bridge || busy) return;
  setBusy(true);
  showMessage('');
  const slow = 'answerModel' in c || 'contextLength' in c;
  setStatus(slow ? 'Applying; the search engine restarts, which takes a moment.' : '');
  try {
    render(await bridge.set(c));
    setStatus('Saved.');
  } catch (e) {
    showMessage(e?.message || String(e));
    setStatus('');
    if (view) render(view);
  } finally {
    document.getElementById('progress').hidden = true;
    setBusy(false);
  }
}

for (const r of document.querySelectorAll('input[name="scope"]')) {
  r.addEventListener('change', () => change({ answerScope: r.value }));
}
for (const r of document.querySelectorAll('input[name="model"]')) {
  r.addEventListener('change', () => change({ answerModel: r.value }));
}

$('reindex').addEventListener('click', async () => {
  if (!libraryBridge || busy) return;
  setBusy(true);
  showMessage('');
  try {
    await libraryBridge.reindex();
    setStatus('Reindexing started. The library shows its progress in the top bar.');
  } catch (e) {
    showMessage(e?.message || String(e));
  } finally {
    setBusy(false);
  }
});

window.askfiles?.models?.onProgress((p) => {
  document.getElementById('progress').hidden = false;
  $('progress-bar').value = p.percent;
  $('progress-text').textContent = progressText(p);
});

async function main() {
  if (!bridge) {
    showMessage('Settings are available in the AskFiles app.');
    setBusy(true);
    return;
  }
  try {
    render(await bridge.get());
  } catch (e) {
    showMessage(e?.message || String(e));
  }
  try {
    const libs = await libraryBridge?.list();
    const cur = libs?.libraries.find((l) => l.isCurrent);
    if (cur) $('reindex-library').textContent = cur.name;
  } catch {
    // The name is a nicety; the button works on the current library either way.
  }
  document.documentElement.dataset.ready = 'true';
}

void main();
