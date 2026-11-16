# Ticket: removing a file from a library is slow for files with many sections

Status: open. Found in the manual test of local/library-delete (2026-11-16). Not part of that branch.

## What happens

The watcher removes a file from the index with one call, `removeDocuments(slug, locations)` (src/main/watcher/api.ts): POST `/api/v1/workspace/{slug}/update-embeddings` with every section document of the file in `deletes`, then DELETE `/api/v1/system/remove-documents`. Upstream handles `deletes` one document at a time (upstream/server/models/documents.js `removeDocuments`): for each section document, a database lookup, `VectorDb.deleteDocumentFromNamespace` (one LanceDB delete, which writes a new table version) and two Prisma deletes.

Measured on the owner's Mac from main.log: about 0.4 s per section, so a file of a few hundred sections takes minutes, and removing a whole library's worth of files one by one takes many minutes. Meanwhile:

- the status bar says "Indexing, N left", though the jobs are removals;
- the request runs on the server with no progress line in any log, so it looks stuck;
- quitting waits for the running job (FolderWatcher.stop awaits it) until the server is stopped, and the job ends in the dead-letter list with `fetch failed`.

Deleting a whole library is not affected: it drops the workspace in one call (library-data.ts removeLibraryData).

## Possible fixes, to decide

1. A patch in patches/ that makes upstream's `removeDocuments` delete all of a call's documents from LanceDB with one `delete` (`docId IN (...)`, in batches) and the Prisma rows with one `deleteMany` each. Smallest change with the largest gain; needs a test on a table of realistic size.
2. Without a patch: nothing on the shell side makes upstream's loop faster; only splitting the call into batches would give progress and a point to stop at.
3. Independent of 1 and 2: the status says "Removing, N left" when the queue holds removals; a quit abandons a running removal (as a library delete does) instead of waiting for it, since a removal that stopped halfway is repeated at the next start.

## Acceptance

- Removing a file of 300 invented sections takes seconds, measured before and after on the owner's Mac (LOCAL) and in the container.
- A quit during a removal ends within a few seconds; the next start finishes the removal.
- Tests with invented files only.
