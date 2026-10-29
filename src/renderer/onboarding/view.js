// Pure state for the onboarding page: folds first-run events into what the page shows. The events
// are the wizard's (src/main/wizard, WizardEvent: state, tier, progress) and the first run's
// (src/main/first-run.ts, SetupEvent: setup, indexing). No DOM here, so it is unit tested in Node.

/** Wizard steps, then the steps the first run adds after the models are in place. */
export const STEPS = [
  { name: 'detectRam', label: 'Checking this Mac' },
  { name: 'chooseTier', label: 'Choosing the right model size' },
  { name: 'pullModels', label: 'Downloading the language models' },
  { name: 'writeConfig', label: 'Saving the settings' },
  { name: 'markOnboarded', label: 'Starting the search engine' },
  { name: 'chooseFolder', label: 'Choosing your documents folder' },
  { name: 'createLibrary', label: 'Preparing your library' },
  { name: 'indexing', label: 'Reading your documents' },
];

const NAMES = STEPS.map((s) => s.name);
const WIZARD = NAMES.slice(0, 5);
const SETUP = NAMES.slice(5);

export function initialState() {
  return {
    steps: Object.fromEntries(NAMES.map((n) => [n, 'pending'])),
    phase: 'idle', // idle | running | folder | error | done
    error: null,
    attempt: 1,
    tier: null,
    progress: null,
    folder: null,
    indexing: null,
  };
}

function markUpTo(next, names, active) {
  const at = NAMES.indexOf(active);
  for (const n of names) {
    const i = NAMES.indexOf(n);
    next.steps[n] = i < at ? 'done' : i === at ? 'active' : 'pending';
  }
}

function reduceWizard(state, next, event) {
  next.attempt = event.attempt ?? state.attempt;
  if (WIZARD.includes(event.state)) {
    markUpTo(next, WIZARD, event.state);
    next.phase = 'running';
    next.error = null;
  } else if (event.state === 'retry') {
    next.phase = 'running';
    next.error = null;
  } else if (event.state === 'error') {
    if (WIZARD.includes(event.failedStep)) next.steps[event.failedStep] = 'failed';
    next.phase = 'error';
    next.error = event.error || 'Something went wrong.';
  } else if (event.state === 'done') {
    for (const n of WIZARD) next.steps[n] = 'done';
  } else {
    return state;
  }
  return next;
}

function reduceSetup(state, next, event) {
  if (event.folder) next.folder = event.folder;
  const s = event.state;
  if (s === 'models') {
    if (state.phase === 'idle' || state.phase === 'error') {
      next.phase = 'running';
      next.error = null;
    }
  } else if (SETUP.includes(s)) {
    for (const n of WIZARD) next.steps[n] = 'done';
    markUpTo(next, SETUP, s);
    // Without a folder the run waits for the user's choice.
    next.phase = s === 'chooseFolder' && !next.folder ? 'folder' : 'running';
    next.error = null;
  } else if (s === 'error') {
    // A failed model step is already marked by the wizard's own error event.
    if (SETUP.includes(event.failedStep)) next.steps[event.failedStep] = 'failed';
    next.phase = 'error';
    next.error = event.error || state.error || 'Something went wrong.';
  } else if (s === 'done') {
    for (const n of NAMES) next.steps[n] = 'done';
    next.phase = 'done';
    next.error = null;
  } else {
    return state;
  }
  return next;
}

/** Returns a new state; never mutates the one given. */
export function reduce(state, event) {
  const next = { ...state, steps: { ...state.steps } };
  switch (event.type) {
    case 'tier':
      next.tier = { ramGb: event.ramGb, label: event.label, belowMinimum: event.belowMinimum };
      return next;
    case 'progress':
      next.progress = {
        model: event.model,
        index: event.index,
        count: event.count,
        completedBytes: event.completedBytes,
        totalBytes: event.totalBytes,
        percent: event.percent,
      };
      return next;
    case 'indexing': {
      const st = event.status || {};
      next.indexing = {
        indexed: Number(st.indexed) || 0,
        pending: Number(st.pending) || 0,
        failed: Array.isArray(st.deadLetters) ? st.deadLetters.length : 0,
      };
      return next;
    }
    case 'state':
      return reduceWizard(state, next, event);
    case 'setup':
      return reduceSetup(state, next, event);
    default:
      return state;
  }
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(n / 1e6))} MB`;
}

/** One line under the progress bar, for example: Download 1 of 2: 512 MB of 1.2 GB (43%). */
export function progressText(p) {
  if (!p) return '';
  const head = p.count > 1 ? `Download ${p.index + 1} of ${p.count}` : 'Download';
  if (p.totalBytes <= 0) return `${head}: starting`;
  return `${head}: ${formatBytes(p.completedBytes)} of ${formatBytes(p.totalBytes)} (${p.percent}%)`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** For example: 12 documents read, 3 to go, 1 could not be read. */
export function indexingText(ix) {
  if (!ix) return '';
  const parts = [`${plural(ix.indexed, 'document', 'documents')} read`];
  if (ix.pending > 0) parts.push(`${ix.pending} to go`);
  if (ix.failed > 0) parts.push(`${ix.failed} could not be read`);
  return parts.join(', ');
}
