// First-run page. Everything comes from the bridge the preload script puts on the window
// (src/main/preload.ts, src/main/bridge/contract.ts):
//
//   window.askfiles.setup = {
//     onEvent(callback) -> unsubscribe  // wizard events (state, tier, progress) and first-run
//                                       // events (setup); a late subscriber gets a replay
//     start() -> Promise                // starts the first run, or joins the run in progress
//     retry() -> Promise                // resumes at the step that failed
//   }
//
// The main process switches the window to the search page when the run is done. Tests put a stub
// with the same shape on the window before the page loads.
import { STEPS, initialState, progressText, reduce } from './view.js';

const $ = (id) => document.getElementById(id);

function render(state) {
  for (const { name } of STEPS) {
    $(`step-${name}`).dataset.status = state.steps[name];
  }
  document.body.dataset.phase = state.phase;

  const tier = $('tier');
  if (state.tier) {
    const gb = Math.round(state.tier.ramGb);
    tier.textContent = state.tier.belowMinimum
      ? `This Mac has ${gb} GB of memory, less than AskFiles is made for. Answers may be slow.`
      : `This Mac has ${gb} GB of memory. AskFiles picks the model that fits.`;
    tier.hidden = false;
  }

  const p = state.progress;
  // The download bar belongs to the model steps; it gives way once the library step starts.
  const showBar = p !== null && state.steps.pullModels !== 'pending' && state.steps.createLibrary === 'pending';
  $('progress').hidden = !showBar;
  if (showBar) {
    $('progress-bar').value = p.percent;
    $('progress-bar').textContent = `${p.percent}%`;
    $('progress-text').textContent = progressText(p);
  }

  $('error').hidden = state.phase !== 'error';
  $('error-text').textContent = state.error || '';
  $('retry').disabled = state.phase !== 'error';
  $('done').hidden = state.phase !== 'done';
}

function buildSteps() {
  for (const { name, label } of STEPS) {
    const li = document.createElement('li');
    li.id = `step-${name}`;
    li.dataset.testid = `step-${name}`;
    li.textContent = label;
    $('steps').append(li);
  }
}

function main() {
  buildSteps();
  const bridge = window.askfiles?.setup;
  let state = initialState();
  render(state);
  if (!bridge) {
    state = reduce(state, { type: 'setup', state: 'error', failedStep: null, error: 'The app could not start setup.' });
    render(state);
    $('retry').disabled = true;
    return;
  }
  bridge.onEvent((event) => {
    state = reduce(state, event);
    render(state);
  });
  $('retry').addEventListener('click', () => {
    $('retry').disabled = true;
    bridge.retry();
  });
  bridge.start();
}

main();
