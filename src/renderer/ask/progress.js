// The muted line under the question while an answer is prepared: what the pipeline is doing,
// from its progress events (src/main/answer/pipeline.ts Progress). Display only.

/** The line for a progress event; null for one the page does not know. */
export function progressText(p) {
  if (!p || typeof p !== 'object') return null;
  if (p.stage === 'searching') return 'Searching your documents';
  if (p.stage === 'judging') return `Checking sections in ${p.file} (${p.n} of ${p.total})`;
  if (p.stage === 'writing') return 'Writing the answer';
  return null;
}
