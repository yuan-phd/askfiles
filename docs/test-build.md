# Test build

Release plan step 2 (docs/plan.md, Release plan): a build for user testing that keeps a local record of the questions testers ask and what they do in the app, so the owner can see real questions before file-reference detection is scoped (step 5). Nothing in it changes retrieval, verification, presets or answers.

## Two flavours

| | Release build | Test build |
| --- | --- | --- |
| Name | AskFiles | AskFiles Test |
| macOS file | AskFiles-<version>-arm64.dmg, AskFiles.app | AskFiles Test.dmg, AskFiles Test.app |
| Windows file | AskFiles-<version>-x64-setup.exe, portable zip | AskFiles-Test-Setup.exe (installer only) |
| Window title | AskFiles | AskFiles (test build) |
| About page | version and credits | plus one line: Test build. It records your questions and actions on this computer only; see Settings, Test record. |
| Logging code, export button, notice | not compiled, not packaged | compiled in |
| Data directory | ~/Library/Application Support/AskFiles, %LOCALAPPDATA%\AskFiles | the same |
| Bundle id / appId | io.askfiles.desktop | the same |

The flavour is chosen at build time, not at run time:

- `node scripts/build-main.mjs` (`npm run build:main`) is the release flavour. It removes dist/main and compiles with tsconfig.json, which excludes src/main/test-record. electron-builder.yml never packages src/renderer/test-record. The release app therefore has no logging module, no test IPC channels, no test preload, no export button and no notice text.
- `node scripts/build-main.mjs --flavour test` (`npm run build:main:test`) compiles with tsconfig.test-build.json, which adds src/main/test-record, and copies the test pages (src/renderer/test-record) to dist/main/test-record/ui.

What every build keeps (src/main/test-build.ts and three small hooks):

- loadTestBuild: looks for dist/main/test-record/index.js and finds nothing in a release build.
- removeTestRecord: the release build's cleanup (below).
- AnswerService takes an optional onAnswered observer (src/main/answer/service.ts); only the test build passes one. It reads the finished run and changes nothing; an error in it is logged and ignored.
- The Browse view and the Ask page dispatch two window events, askfiles:browse-page and askfiles:source-card. Nothing listens to them in the release build.
- The app protocol takes an optional extra file resolver for askfiles://app/test-record/...; only the test build passes one.

At start the test build registers a second preload script (session.registerPreloadScript, src/main/test-record/preload.ts) for every window. It exposes window.askfilesTest and adds the test page script (/test-record/ui.js) to every askfiles:// page; ui.js shows the notice, adds the Test record part to Settings and the line to About, and passes the two window events to the record.

## Building

CI builds both flavours on every push and pull request (.github/workflows/mac.yml and windows.yml) and uploads them as separate artifacts:

| Artifact | Contents |
| --- | --- |
| askfiles-dmg-<sha> | release DMG |
| askfiles-test-dmg-<sha> | AskFiles Test.dmg |
| askfiles-windows-installer-<sha>, askfiles-windows-portable-<sha> | release installer and zip |
| askfiles-test-windows-installer-<sha> | AskFiles-Test-Setup.exe |

After packaging the release app, CI runs `node scripts/check-test-record.mjs <Resources>` on it; the step fails if app.asar holds any file of dist/main/test-record or src/renderer/test-record, or any file containing the module's marker (askfiles-test-record-module) or its channel prefix. On the test build it runs the same check with `--expect present`, which shows the check can see the module. The smoke tests run on the release builds only.

Locally, after the release package of the same platform (it prepares the upstream tree and THIRD-PARTY-NOTICES):

```
npm run package:mac          # release, release/
npm run package:mac:test     # test build, release-test/AskFiles Test.dmg
npm run package:win          # on Windows
npm run package:win:test     # release-test/AskFiles-Test-Setup.exe
```

From source: `npm run dev:test` runs the test flavour against the repository's backend (data in AskFiles-dev, as `npm run dev`).

## Installing over each other

- Test build over nothing: first start shows the notice (below), then the app works as the release build does.
- Release build over the test build: the release build uses the same data directory, so libraries, indexes and models carry over. At every start it looks for the test record folder (test-record in the data directory) and, when it finds one, deletes it, record and settings, and writes one line to main.log: `[test-record] release build removed the test record and its settings left by a test build (N files)`. On Windows the release installer replaces the test install (same appId). On macOS both apps can sit in Applications; testers should delete AskFiles Test.app, since starting it again would start a new record.
- Test build over the release build: carries the libraries and models over the same way.

## The notice

Shown once, on the first page a test build opens (onboarding on a new install, otherwise Ask), in Chinese when the system language is Chinese, otherwise in English (the rest of the app is English):

> This test build records your questions and actions on this computer only. Nothing is uploaded. You decide whether to export and share the record. Installing the regular version removes the record.

> 此测试版只在这台电脑上记录您的问题和操作。不会上传任何内容。是否导出和分享这份记录由您决定。安装正式版会删除这份记录。

One button, Continue (继续); Escape does not close it. Settings shows the same text in its Test record part, next to the export button.

## Settings, Test record

- Export test record: asks Questions only or Questions with answers and sources, writes one file to the Desktop and shows it in Finder or File Explorer. The file name says which: `AskFiles test record questions only 2026-11-12 093015.jsonl` or `AskFiles test record with answers 2026-11-12 093015.jsonl`; an existing file is never overwritten (a number is added).
- Pause recording / Resume recording: while paused nothing is written. The pause survives a restart.
- Clear the record: after a confirmation, deletes every recorded line. The notice is not shown again.
- A status line: how many questions and other actions are recorded, and whether recording is paused.

## Where the record is

| Platform | File |
| --- | --- |
| macOS | ~/Library/Application Support/AskFiles/test-record/record.jsonl |
| Windows | %LOCALAPPDATA%\AskFiles\test-record\record.jsonl |

settings.json beside it holds `paused` and `noticeShown`. main.log has a `[test-record]` line at each start (how many lines the record holds), at each export, pause, resume and clear, and if a line cannot be written.

No network call is added: the record is written with node:fs, and the export is a file on the Desktop that the tester sends by whatever means they choose.

## The record format

One JSON object per line (JSON Lines), `v` is the format version (1). An exported file starts with one header line:

| Field | Meaning |
| --- | --- |
| type | export |
| mode | questions (questions only) or full (with answers and sources) |
| exportedAt | ISO time of the export |
| app | app version |
| platform | darwin or win32 |
| lines | number of lines that follow |

Every other line has `v`, `type`, `time` (ISO, UTC) and `library` (the display name of the library that was open; null when none was known), and then:

### type question

One per question, written when it ends.

| Field | Meaning |
| --- | --- |
| question | the question as typed |
| switches.questionRewrite | `fired` true when the question the model read differs from the one typed (questionFileNames rewrote file names); `sent` is that question, else null |
| switches.namedFiles | named-file detection: `fired` true when the question names two or more files (crossDocQuota); `files`, the files detected, in the order the question names them |
| switches.perFileQuota | `fired` true when sections were taken from inside each named file; `sections`, how many |
| switches.judgeRerank | `fired` true when the chat model judged each named file's candidates; `files`, how many files; `ms`, the time of all judge calls |
| outcome | answer, refusal (the not-found answer), error, or cancelled (a newer question or the page cancelled it before it ended; the brief named three outcomes, this fourth keeps a cut-off question from being lost) |
| error | the message the page showed, for error only |
| answer | the answer text as shown (after unsupported hedges are dropped), or the refusal text; null for error and cancelled |
| cited | the cited sources in citation order: `file`, `display` (the display name the source card showed first, null when it showed the file name), `section` (heading path joined with " > "), `page` (first page, null without pages) |
| starred | sentences of the answer shown with the dagger † (no source found; an asterisk until the Markdown answers change, the name kept so older records still read); 0 for a refusal |
| totalMs | time from the question to its end, in milliseconds |

### type add

One per add that added or skipped something (a cancelled dialog is not recorded). No file or folder names or paths are recorded.

| Field | Meaning |
| --- | --- |
| kind | files (Add files), folder (Add folder), drop (dragged into the window) |
| added | files copied plus folders linked; a folder counts as one |
| skipped | items the app left out (it says why on screen; the reasons are not recorded) |

### type browse

One each time a Browse page opens: a tab inside Browse, the switch from Ask to Browse, or a document opened (from the library, Find, Compare or a source card).

| Field | Meaning |
| --- | --- |
| page | library, document, compare, find or graph |
| document | the document's title on the document page; null on the others |

### type source

One per click on a source card button, under an answer or under nothing found.

| Field | Meaning |
| --- | --- |
| action | open (Show in Finder or Explorer) or read (the section on the Browse document page) |
| file | the file name of the source |
| section | heading path joined with " > " |
| page | first page, or null |

### Questions only

The questions-only export writes the same lines with these fields emptied: question `answer` (null), `cited` ([]) and `error` (null); browse `document` (null); source `file` (""), `section` and `page` (null). It keeps the question text, the switches (including the files named-file detection found, which come from the question itself), the outcome, the starred count and the time.

## Summarizing the exports

Put every file testers sent in one folder and run:

```
node scripts/test-record/summarize.mjs <folder>
```

It prints Markdown: the exported files, every question (time, library, outcome, starred sentences, files detected, how it refers to files), a count of the ways questions refer to files, the questions that fired named-file detection with their quota and judge, how often question rewrite fired, outcomes with refusals and starred sentences, the most used Browse pages and documents, source card clicks and adds. A line that appears in two exports of one record is counted once, the fuller copy kept.

How a question refers to files is one of, in this order: file name (a name with an extension such as .pdf, .docx), display name (a name a source card or Browse showed, without a leading "the"), file name again (a known file's name without its extension), description (the guidance, this policy, 这份指南, a title in 《》 that is no known name), none. Known names come from the record itself: the files detected, the cited sources and the Browse documents, so a questions-only export alone knows fewer names; the classification is a starting point for reading the questions, not a measurement.

## Tests

- src/main/test-record/record.test.ts: question lines from finished runs (switches, outcomes, starred), page events checked field by field, append, pause and its persistence, clear, damaged lines, export in both modes, no overwrite.
- src/main/test-record/index.test.ts: channels against the preload, export to the Desktop with the file revealed, pause and clear over IPC, adds recorded as counts only, a real question through AnswerService (recorded, and the same answer without the record), errors, cancelled questions, a failing record never stops an answer.
- src/main/test-build.test.ts: the loader finds nothing in a release build; the release cleanup deletes the record and settings with one log line and nothing else.
- scripts/check-test-record.test.mjs: the release program does not compile src/main/test-record; every module file carries a marker and no release source does; the CI check passes a release app.asar and fails one with the module (by path, by marker, by channel name), and `--expect present` works.
- scripts/test-record/summarize.test.mjs: the summary of a synthetic record written by the record code and exported in both modes.
- test/e2e/test-build.spec.mjs (Playwright): the notice (English, Chinese, once only, Escape), the Settings part with Export test record and its two choices, Finder and File Explorer, pause, clear, a failed export, nothing in the release pages, About, Browse page and source card events.

Checked on the owner's Mac with Electron from source under a throwaway app name (not part of the suite): the test flavour shows the title AskFiles (test build), the notice, both window.askfiles and window.askfilesTest under the sandbox, serves /test-record/ files, and writes the record; the release flavour started on the same data directory then logged the removal line and deleted the folder.
