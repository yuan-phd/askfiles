# Session I: bundle size, CI runtime and housekeeping

Executor: CLOUD; the DMG size is confirmed by the CI artifact
Dependencies: Sessions A to G merged on main. Runs in parallel with Session H; it must not touch src/main/app.ts, the preload, the pages or the watcher. Its files are electron-builder.yml, scripts/build.sh, scripts/prune.*, .github/workflows/mac.yml caching steps, docs and cloud-env.
Branch: whatever the session assigns
PR title: [Session I] Smaller bundle, faster CI, housekeeping

## Goal

The green mac workflow packages 1.7 GB of upstream dependencies and takes about 22 minutes in the package job. Bring the DMG and the package job down without changing behaviour, and clean up the small items left by earlier sessions.

## Deliverables

1. Measure first. Add scripts/measure-bundle.sh that lists the 40 largest directories under the packaged server and collector dependency folders (run it against a Linux packaging here) and commit its output to docs/bundle-report.md with the date and commit.
2. Prune safely, in this order, each as its own commit with the saving recorded:
   - binaries for other platforms and architectures (onnxruntime, sharp libvips, canvas, Prisma engines, any .node or .dylib not for darwin-arm64);
   - duplicate copies of the same package installed under several paths, by deduplicating with the package manager where it is safe;
   - development-only files that production installs still ship: tests, docs, typings, source maps, examples;
   - packages that upstream only loads on code paths AskFiles never reaches. Candidates from docs/upstream-analysis.md risk 8: mdpdf, puppeteer-core, canvas. Remove one only after showing, with a grep of upstream code and one boot of the packaged copy, that nothing AskFiles uses requires it at startup or on the document, chat, embedding and OCR paths; otherwise leave it and say why.
   Never prune by guess: every removal has a test or a boot check behind it, and scripts/check-server-boot.sh still passes.
3. CI time: warm caches for the upstream yarn installs and Electron, skip the frontend build when upstream/frontend and patches are unchanged (hash-keyed cache), and report the package job time before and after in the PR. Keep the workflow green on a fork with no secrets.
4. Housekeeping, documentation only:
   - cloud-env/setup-script.sh installs iproute2 next to zstd; cloud-env/README.md mentions it.
   - docs/sessions/E-wizard-and-presets.md has a duplicated integration-test item in Deliverables; make it one item.
   - docs/plan.md: mark Sessions A to G as merged with their PR numbers, update the timeline table with the measured facts from the PRs (build 65 s, package 22 min, smoke 3 min 45 s, chat answer 38 s on the CI runner), and record the DMG size before and after this session.
   - CLAUDE.md: add a line under Commands for scripts/measure-bundle.sh.

## Rules for this session

- Do not edit upstream/. Pruning happens in scripts/build.sh after install, on the copy that gets packaged, never in the vendored tree.
- Coordinate with Session H by file ownership only: if a change needs src/main, stop and say so in the PR instead of making it.
- Watch the PR after opening it: read each failed mac run, fix, push, until green.

## Acceptance

- The mac workflow on the PR is green and the DMG artifact is smaller than the current one (about 1.6 GB expected before; record the exact numbers).
- scripts/check-server-boot.sh passes against the pruned Linux packaging in this container.
- docs/bundle-report.md and the plan updates are in the PR.

## Added: license audit

Run a license scan over the packaged server and collector dependency trees and the shell's own dependencies (for example with license-checker or a similar tool, dev dependency only). Commit the result as docs/licenses.md: every package with its license, plus a short list at the top of any package whose license is not MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Unlicense, Python-2.0 or CC0, with the dependency path that pulls it in. Do not remove or replace anything; report only. Also list the licenses of Ollama, the bundled models named in config/presets.json and the tesseract language data.
