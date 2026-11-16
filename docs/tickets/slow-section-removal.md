# Ticket: removing a file from a library is slow for files with many sections

Status: open. Found in the manual test of local/library-delete (2026-11-16). Not part of that branch.

## What happens

The watcher removes a file from the index with one call, `removeDocuments(slug, locations)` (src/main/watcher/api.ts), which makes two requests with every section document of the file:

1. POST `/api/v1/workspace/{slug}/update-embeddings` with them in `deletes`. This reaches upstream's `Document.removeDocuments` (upstream/server/models/documents.js), which patches/008-bulk-remove-documents.patch already makes remove LanceDB vectors and Prisma rows in batches of 500 documents.
2. DELETE `/api/v1/system/remove-documents` with them in `names`. Upstream loops over the names one at a time (upstream/server/endpoints/api/system/index.js, `purgeDocument` in upstream/server/utils/files/purgeDocument.js): for each section document, the vector-cache file, the source JSON file, and `Document.removeDocuments(workspace, [name])` once for every workspace on the machine, each with its own database lookup. 008 does not help here, since every call carries one name.

Measured on the owner's Mac from main.log: about 0.4 s per section, so a file of a few hundred sections takes minutes, and removing a whole library's worth of files one by one takes many minutes. The server log of that run has rotated, so it is not known how the time splits between the two requests; request 2 is the likely part (one name at a time, a lookup per workspace), but that is unverified. Meanwhile:

- the status bar says "Indexing, N left", though the jobs are removals;
- the request runs on the server with no progress line in any log, so it looks stuck;
- quitting waits for the running job (FolderWatcher.stop awaits it) until the server is stopped, and the job ends in the dead-letter list with `fetch failed`.

Deleting a whole library is not affected: it drops the workspace in one call (library-data.ts removeLibraryData).

## Possible fixes, to decide

1. First measure: time both requests for one file of 300 invented sections, with 1 and with 3 workspaces on the machine.
2. If request 2 dominates: a patch in patches/ that gives `remove-documents` a batched path (the files of all names, then `Document.removeDocuments(workspace, names)` once per workspace, which 008 already batches); or, without a patch, skip request 2's workspace pass by removing the source files another way. Smallest change with the largest gain once the measurement says where the time goes.
3. If request 1 still dominates despite 008: look at the batch sizes and LanceDB table versions on a table of realistic size.
4. Independent of the above: the status says "Removing, N left" when the queue holds removals; a quit abandons a running removal (as a library delete does) instead of waiting for it, since a removal that stopped halfway is repeated at the next start.

## Acceptance

- Removing a file of 300 invented sections takes seconds, measured before and after on the owner's Mac (LOCAL) and in the container.
- A quit during a removal ends within a few seconds; the next start finishes the removal.
- Tests with invented files only.
