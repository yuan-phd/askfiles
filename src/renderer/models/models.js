// Model manager page. All work happens in the main process (src/main/models) behind a bridge:
//
//   window.askfiles.models = {
//     list() -> Promise<[{ name, sizeBytes, modifiedAt, role: 'chat' | 'embedding' | null }]>
//     pull(tag) -> Promise                 // resolves after Ollama reports success
//     onProgress(callback) -> unsubscribe  // PullProgress objects: model, status, completedBytes, totalBytes, percent
//     remove(tag) -> Promise               // rejects for the active chat or embedding model
//     switchChat(tag) -> Promise           // sets the answering model and restarts the server
//   }
import { formatBytes, progressText } from '../onboarding/view.js';

const $ = (id) => document.getElementById(id);
const ROLE_LABEL = { chat: 'Answers', embedding: 'Indexing' };

let bridge = null;
let busy = false;
// A delete needs a second click on the same row, so one slip never removes a multi-GB download.
let confirmDelete = null;

function showMessage(text) {
  $('message').textContent = text || '';
  $('message').hidden = !text;
}

function setBusy(value) {
  busy = value;
  for (const b of document.querySelectorAll('button')) b.disabled = value;
}

async function run(action) {
  if (busy) return;
  setBusy(true);
  showMessage('');
  try {
    await action();
  } catch (e) {
    showMessage(e?.message || String(e));
  } finally {
    setBusy(false);
    await refresh();
  }
}

function button(text, testid, onClick, kind = 'secondary') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = kind;
  b.textContent = text;
  b.dataset.testid = testid;
  b.disabled = busy;
  b.addEventListener('click', onClick);
  return b;
}

function renderRows(models) {
  const rows = models.map((m) => {
    const tr = document.createElement('tr');
    tr.dataset.testid = 'model-row';
    tr.dataset.model = m.name;
    const name = document.createElement('td');
    name.textContent = m.name;
    const size = document.createElement('td');
    size.textContent = formatBytes(m.sizeBytes);
    const role = document.createElement('td');
    if (m.role) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.dataset.testid = 'role';
      badge.textContent = ROLE_LABEL[m.role];
      role.append(badge);
    }
    const actions = document.createElement('td');
    actions.className = 'actions';
    if (m.role === null) {
      actions.append(button('Use for answers', 'use', () => run(() => bridge.switchChat(m.name))));
      const confirming = confirmDelete === m.name;
      actions.append(
        button(confirming ? 'Really delete' : 'Delete', 'delete', () => {
          if (!confirming) {
            confirmDelete = m.name;
            renderRows(models);
            return;
          }
          confirmDelete = null;
          run(() => bridge.remove(m.name));
        }),
      );
    }
    tr.append(name, size, role, actions);
    return tr;
  });
  $('model-rows').replaceChildren(...rows);
}

async function refresh() {
  try {
    renderRows(await bridge.list());
  } catch (e) {
    showMessage(e?.message || String(e));
  }
}

function main() {
  bridge = window.askfiles?.models;
  if (!bridge) {
    showMessage('The app could not reach the model manager.');
    return;
  }
  bridge.onProgress((p) => {
    $('progress').hidden = false;
    $('progress-bar').value = p.percent;
    $('progress-bar').textContent = `${p.percent}%`;
    $('progress-text').textContent = `${p.model}. ${progressText({ ...p, index: 0, count: 1 })}`;
  });
  $('pull-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const tag = $('pull-tag').value.trim();
    if (!tag) return;
    run(async () => {
      await bridge.pull(tag);
      $('pull-tag').value = '';
    });
  });
  refresh();
}

main();
