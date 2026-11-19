# Ticket: let the user choose to index now or later when the start is in trouble

Status: done 2026-11-19 (branch local/startup-index-choice), as decided below. Raised with local/folder-limits (owner decision 2026-11-16).

## Why

At start the current library's watcher opens its watches, walks every folder (reconcile) and queues whatever changed; the Ask page's question box stays off while it indexes (docs/summaries.md, Ask during indexing). When the start is in trouble the user waits with no say:

- a library much larger than usual (many new or changed files since the last run, a folder added just before quitting) keeps the question box off for minutes or hours;
- a library at the folder limit, or a slow or disconnected volume, makes the walk itself long;
- a start that failed or froze last time (the main log has no clean stop, or the previous start never reached `library <id> running`) is likely to fail again the same way, as the tester's library of code repositories did before the folder limit.

## Proposal (as raised; see Decisions)

When the start finds one of these (thresholds to measure, for example more than N files to check, a walk longer than T seconds, or a previous start that did not finish), ask once, in plain words and in the system language:

- Start indexing now: as today.
- Later: the library opens with its existing index, answerable; nothing is walked or watched; the top bar says Not checked for changes, with Check for updates to start when the user wants.

The answer applies to this start only. Open questions: where the question appears before the window is ready (onboarding page, or the top bar once the Ask page loads); whether Later also pauses summaries; how a library switch behaves while Later is in force; whether the previous start's failure is detected from main.log or from a marker in shell.json.

## Decisions (owner, 2026-11-19)

1. Ask only when the previous start did not finish, before anything is watched. No size or time triggers: with the 1,000-subfolder limit, trouble from size is rare, and unmeasured thresholds would be guesses. (The file count to check is only known after the walk, the slow step itself.)
2. The question is a line in the shared top bar with two buttons, Check now and Later (the first named Start indexing now until the owner renamed it, 2026-11-19, to match the question), on Ask and Browse.
3. No answer counts as Later. A normal quit is recorded as a clean stop, so the next start is normal.
4. Summaries keep running: Later only skips walking and watching the folders.
5. Later applies only to that library, until Check for updates or the next app start. Another library starts normally; switching back keeps the first as it was.
6. Detection: a marker file, startup.json in the data folder, written just before the watcher starts and removed when the log says `library <id> running` or on a clean stop. It catches only an unfinished start, which is enough for 1. A data folder from an older version has no marker and starts normally.

Decided in the implementation (not listed above, so recorded here; approved by the owner 2026-11-19):

- Unanswered, the marker stays on disk, so a crash before an answer asks again; Later removes it at once.
- A start that ends with an error (the library could not be read) also removes the marker: the start finished and said why.
- A marker naming a library that no longer exists is removed, and the start is normal.
- Adding a file or folder, removing a source, or Reindex on the library ends Later for it: the user acted on its sources, so the library starts normally and reads the change.

What was built: src/main/startup-marker.ts; LibraryManager (src/main/libraries.ts) holds the library with its index only (FolderWatcher.openIndex: index.json loaded, nothing watched, walked or read), status `startChoice` ask or later, answerStart(now or later) over IPC askfiles:libraries:answer-start; the top bar line in src/renderer/shared/topbar.js with the text in messages.js (English and Chinese by the system language), the status Not checked for changes (未检查更改) with ↻ Check for updates. Tests: src/main/startup-marker.test.ts, src/main/libraries.test.ts (a start that did not finish), src/renderer/shared/messages.test.js.

## Acceptance

- With an invented library whose start would check more than the threshold, the question appears; Later leaves the index answerable and no file is read; Check for updates then runs the normal reconcile.
- A test that a start which did not finish is detected at the next start, with invented data.
- No change for a normal start.
