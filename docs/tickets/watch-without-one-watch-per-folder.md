# Ticket: watch a large folder without one watch per folder

Status: open. Follows docs/tickets/large-folder-blocks-window.md. Not part of local/folder-limits, which limited what is read and how many folders are watched instead (owner decision 2026-11-16; docs/plan.md, File types and folder limit).

## Why

chokidar 4 opens one fs.watch per folder. On macOS each is one path of the single FSEvents stream libuv keeps per process; at 4,097 paths the stream cannot start, every watch fails with EMFILE and the main process stalls for 80 to 130 s (measured, docs/app.md, File types and folder limit). The limit of 3,000 folders per library, with a guard on the watch itself, keeps the app responsive but has costs:

- a library of more than 3,000 folders (after the skips) cannot be added in one piece; the user adds subfolders;
- in a library that grew past the limit, changes in the folders beyond it are found only by Check for updates and at the next start;
- even below the limit, opening thousands of watches stalls the window for up to about 150 ms at start, and every switch, folder add or remove opens them all again.

FSEvents and ReadDirectoryChangesW watch a whole tree natively with one handle. One recursive watch per linked folder would remove the limit on those platforms.

## Possible approach, to decide

1. macOS and Windows: one recursive fs.watch per linked folder (Node's recursive option, one FSEvents path or one directory handle). Linux keeps chokidar (fs-watch.ts gives the reasons against recursive fs.watch there). Event shapes differ (rename without add or unlink, folder events): the watcher would stat each reported path and treat a folder event as a reconcile of that folder.
2. Skipped folders (file-types.ts) are still not read: the events from inside them are dropped by path, which costs nothing per folder.
3. Added files: one watch per folder holding added files stays (depth 0); they are few. Or one recursive watch on their common parents, filtered.
4. The reconcile does not wait for the watch's ready on a newly added folder (part 3 of the earlier ticket).
5. Keep the WatchBudget guard for the chokidar path, and decide whether the per-library add limit stays (it would then only protect the start-up walk's time).

## Acceptance

- An invented tree of 13,640 nested folders is added in one piece on macOS; the longest stall of the main process's event loop stays below 100 ms during the add and the start (measured as in scripts/measure-watch-limit.ts, inside Electron, LOCAL).
- A file added later in any folder of that tree is indexed without Check for updates or a restart.
- Linux behaviour unchanged; tests with invented folders only.
