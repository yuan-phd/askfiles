// Pure state for the onboarding page: folds wizard events (src/main/wizard, WizardEvent) into what
// the page shows. No DOM here, so it is unit tested in Node.

export const STEPS = [
  { name: 'detectRam', label: 'Checking this Mac' },
  { name: 'chooseTier', label: 'Choosing the right model size' },
  { name: 'pullModels', label: 'Downloading the language models' },
  { name: 'writeConfig', label: 'Saving the settings' },
  { name: 'markOnboarded', label: 'Starting the search engine' },
];

const NAMES = STEPS.map((s) => s.name);

export function initialState() {
  return {
    steps: Object.fromEntries(NAMES.map((n) => [n, 'pending'])),
    phase: 'idle', // idle | running | error | done
    error: null,
    attempt: 1,
    tier: null,
    progress: null,
  };
}

/** Returns a new state; never mutates the one given. */
export function reduce(state, event) {
  const next = { ...state, steps: { ...state.steps } };
  if (event.type === 'tier') {
    next.tier = { ramGb: event.ramGb, label: event.label, belowMinimum: event.belowMinimum };
    return next;
  }
  if (event.type === 'progress') {
    next.progress = {
      model: event.model,
      index: event.index,
      count: event.count,
      completedBytes: event.completedBytes,
      totalBytes: event.totalBytes,
      percent: event.percent,
    };
    return next;
  }
  if (event.type !== 'state') return state;

  next.attempt = event.attempt ?? state.attempt;
  const at = NAMES.indexOf(event.state);
  if (at >= 0) {
    NAMES.forEach((n, i) => (next.steps[n] = i < at ? 'done' : i === at ? 'active' : 'pending'));
    next.phase = 'running';
    next.error = null;
  } else if (event.state === 'retry') {
    next.phase = 'running';
    next.error = null;
  } else if (event.state === 'error') {
    if (event.failedStep && NAMES.includes(event.failedStep)) next.steps[event.failedStep] = 'failed';
    next.phase = 'error';
    next.error = event.error || 'Something went wrong.';
  } else if (event.state === 'done') {
    NAMES.forEach((n) => (next.steps[n] = 'done'));
    next.phase = 'done';
    next.error = null;
  }
  return next;
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
