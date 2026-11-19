# Ticket: a watcher unit test failed once, out of many runs

Status: open. Seen on branch local/fix-stale-integration-tests (2026-11-19). Not fixed there, by owner decision.

## What happened

`npm test` on the owner's Mac failed once in one test:

src/main/watcher/watcher.test.ts > FolderWatcher > sources out of reach > keeps a linked folder that goes out of reach while running, and takes it back when it returns

Every other test passed in that run (1 failed, 1154 passed, 2 skipped). The same day it passed in every other full run, about ten in all. Run alone right after the failure, it passed 5 times out of 5. Three more full runs later, kept for this ticket, also passed. The code under test was not changed between the failure and these runs: the branch changed only integration tests.

The failure message was not kept: that run's output was read only for its summary line. So which assertion failed is not known.

## Where it could come from (unverified)

The test drives FolderWatcher through a manual watch (no real file events) with short timings: debounce and stable time 30 ms, the reachability poll every 30 ms. The steps that depend on time:

1. After the folder is renamed away and two unlink events are sent, it waits a fixed 120 ms before `whenIdle()`, then expects both files still indexed, the folder listed as unavailable and no removal event. The events settle through the 30 ms debounce and stable time before they become jobs. If they have not settled within the 120 ms, `whenIdle()` may return before the jobs exist, and the expectations would be read too early. (A file event that finds the folder gone sets the source aside itself, docs/app.md Sources out of reach, so the poll's timing alone should not remove the files.)
2. After the folder comes back, `wait()` polls up to 10 s for `unavailable` to empty. Then it expects only the changed file to be split again. If the poll and a pending job interleave differently under load, the split count could differ.

The failing run was the full suite, with many test files running in parallel workers, which is the kind of load where fixed short waits are most likely to be too short. Both points are guesses until a failure is caught with its message.

## Next step

Run the test in a loop under load (for example the full suite repeatedly, or the file with other CPU work) until it fails, keeping the output. If point 1 is the cause, wait for the watcher's state (the folder reported unavailable and the events handled) instead of a fixed 120 ms. That keeps every expectation.
