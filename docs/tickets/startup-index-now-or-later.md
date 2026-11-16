# Ticket: let the user choose to index now or later when the start is in trouble

Status: open. Raised with session/l-folder-limits (owner decision 2026-11-16). No code yet.

## Why

At start the current library's watcher opens its watches, walks every folder (reconcile) and queues whatever changed; the Ask page's question box stays off while it indexes (docs/summaries.md, Ask during indexing). When the start is in trouble the user waits with no say:

- a library much larger than usual (many new or changed files since the last run, a folder added just before quitting) keeps the question box off for minutes or hours;
- a library at the folder limit, or a slow or disconnected volume, makes the walk itself long;
- a start that failed or froze last time (the main log has no clean stop, or the previous start never reached `library <id> running`) is likely to fail again the same way, as the tester's library of code repositories did before the folder limit.

## Proposal, to decide

When the start finds one of these (thresholds to measure, for example more than N files to check, a walk longer than T seconds, or a previous start that did not finish), ask once, in plain words and in the system language:

- Start indexing now: as today.
- Later: the library opens with its existing index, answerable; nothing is walked or watched; the top bar says Not checked for changes, with Check for updates to start when the user wants.

The answer applies to this start only. Open questions: where the question appears before the window is ready (onboarding page, or the top bar once the Ask page loads); whether Later also pauses summaries; how a library switch behaves while Later is in force; whether the previous start's failure is detected from main.log or from a marker in shell.json.

## Acceptance

- With an invented library whose start would check more than the threshold, the question appears; Later leaves the index answerable and no file is read; Check for updates then runs the normal reconcile.
- A test that a start which did not finish is detected at the next start, with invented data.
- No change for a normal start.
