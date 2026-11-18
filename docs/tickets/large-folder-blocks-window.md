# Ticket: adding a folder with thousands of subfolders freezes the window on macOS

Status: mitigated by local/folder-limits (file types, skipped folders, a limit of watched folders; docs/plan.md, File types and folder limit), first 3,000 folders, lowered to 1,000 subfolders by local/folder-limit-lower (owner decision 2026-11-18, measurement below). The rework of the watch is docs/tickets/watch-without-one-watch-per-folder.md. Found in the manual test of local/library-delete (2026-11-16) with the invented tree of scripts/measure-library-delete.ts (13,640 Markdown files, each in its own nested folder). Not part of that branch.

## What happens

The tester dragged the tree onto the window. The whole app showed the spinning cursor for several minutes before indexing started.

main.log of that run (times UTC):

- 08:04:42 `watching 1 of 1 folders`: the watcher opens the chokidar watch on the new folder.
- 08:04:43 to 08:10:20: 13,641 lines `watch error: EMFILE: too many open files, watch`, about one per folder of the tree, every 20 to 30 ms.
- 08:10:23 `reconcile: 13640 files in folders, 13640 to check`: chokidar reported ready, and indexing started.

So the freeze matches the 5 min 40 s that chokidar took to reach ready. FolderWatcher.start awaits the watch's ready before it reconciles (src/main/watcher/watcher.ts), which is why indexing waited for it too.

## Reproduction with invented folders

A script that runs chokidar 4.0.3 (the version in package.json) under plain Node 22 on the owner's Mac over N invented folders, each holding one README.md, and measures how late a 10 ms timer fires:

| Folders | Ready after | EMFILE errors | Longest stall of the event loop |
| --- | --- | --- | --- |
| 1,020 | 0.2 s | 0 | 30 ms |
| 3,060 | 0.5 s | 0 | 84 ms |
| 6,120 | 162 s | 4,849 | 155 s |

The open-file limit of that shell was 1,048,576, so the EMFILE does not come from the process file limit. Past a few thousand folders every further directory watch fails, and each failure costs about 30 ms. The failures are synchronous on the thread that runs JavaScript, which is the Electron main process in the app, so the window gets no events until the crawl ends: the spinning cursor.

Likely mechanism (unverified): on macOS, Node's fs.watch on a folder goes through libuv's FSEvents backend, which keeps one FSEvents stream for all watched paths and builds it again for every new path. Past the number of paths FSEvents accepts, starting the stream fails and libuv reports UV_EMFILE. chokidar 4 has no fsevents dependency (chokidar 3 had one), so it calls fs.watch once per folder.

Other memory-heavy apps were open during the frozen run; a slower machine makes each failure cost more. The log holds only one add of the tree, so the later run without a freeze cannot be compared from it. The measurement above froze with no other app open, so a tree of this size is expected to freeze every time.

## Second effect

A folder whose watch failed gets no live events. The availability poll only checks that the linked folder can be reached, so files added or changed in those folders are seen only at the next start's reconcile, or on Check for updates.

## Possible fixes, to decide

1. Watch the linked folder with one recursive fs.watch on macOS and Windows (FSEvents and ReadDirectoryChangesW do recursion natively, one handle), keeping chokidar on Linux. The comment in src/main/watcher/fs-watch.ts gives the reasons against recursive fs.watch for Linux only. Event shape differs (rename without add or unlink), so the watcher would stat on each event.
2. Keep chokidar but limit the cost: stop opening watches after the first EMFILE (watch the root only and rely on a periodic reconcile for that library), and say so in the status.
3. Independent of 1 and 2: do not await the watch's ready before reconciling a newly added folder. The walk can run first, and the watch catches up.
4. Move the watcher out of the main process (utility process). The window would stay responsive whatever the watcher does, but that is a larger change.

## Acceptance

- Adding an invented tree of 13,640 nested folders keeps the window responsive: a test that measures event-loop lag in the process that runs the watcher stays below 100 ms during the add.
- Files added later in any folder of that tree are indexed without a restart.
- Measured on the owner's Mac (LOCAL) with the invented tree; tests with invented folders only.

## Freeze in the packaged app by library size (2026-11-18)

Below the 4,096 folders at which every watch fails, the window still freezes when the watches close: closing is synchronous in the main process and grows with the square of the folder count. Measured to choose the folder limit (local/folder-limit-lower).

How: the packaged release app (release/mac-arm64/AskFiles.app, built from main) on the owner's Mac (M1 Max), started with a scratch data folder (--user-data-dir) and the models copied in, so no real library was touched. Invented trees of N subfolders, ten to a level, one invented Markdown file in each folder. A script drove the app through its own interface calls: create the library, add the tree, wait until indexed, quit and start again, switch away to All files and back (twice each), delete it while current. A 10 ms timer in the main process recorded every gap in its event loop; the table gives the longest gap, which is how long the window freezes. Summaries were paused. Every folder was watched (no folder over the limit) and every file indexed.

| Subfolders | Startup | Switch away | Switch to | Delete | Longest |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 500 | 0.08 s | 0.83 / 0.66 s | 0.07 / 0.08 s | 0.72 s | 0.8 s |
| 1,000 | 0.20 s | 2.9 / 2.6 s | 0.20 / 0.19 s | 2.8 s | 2.9 s |
| 1,500 | 0.39 s | 6.2 / 5.5 s | 0.40 / 0.38 s | 6.1 s | 6.2 s |
| 2,000 | 0.79 s | 14.3 / 13.2 s | 0.81 / 0.72 s | 14.1 s | 14.3 s |

Switching away and deleting close every watch at once and cause almost all of the freeze; startup and switching to a library stay under 1 s. 1,000 is the largest measured size whose longest freeze stays under 5 s (owner decision 2026-11-18). A slower Mac, other apps running or folders with many files will freeze longer. The add itself (indexing the tree) froze the window for at most 0.8 s at 2,000.
