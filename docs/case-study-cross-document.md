# Case study: cross-document answers from a small local model

How AskFiles' answers to questions that need two documents were measured and improved, what was kept and what was dropped, and what a sealed holdout set showed at the end. Every answer measured here was produced by a 14-billion-parameter model running locally on one Mac.

## The problem

AskFiles answers from the user's own documents with a local model and cites the file, section and page of every claim. Questions about one document worked early on. Questions that compare two documents ("What do the old and the new policy say about X?") failed in three characteristic ways:

1. **One document crowds out the other.** Retrieval returns the best-scoring sections for the whole question. When one file matches the question's wording better, it fills every slot the model reads, and the second file is never seen.
2. **Attribution drifts.** With sections from two files in front of it, a small model attributes a sentence from one file to the other, or cites a section that shares vocabulary with the right one but does not hold the fact.
3. **The answer covers one side.** The model states what one document says and leaves out the other, or merges the two.

My first test on a real library (10 questions) gave 2 passes, 4 partial answers and 4 failures, and the failures were mostly of these kinds. That test is why the shell took over retrieval, prompt assembly and the model call from the AnythingLLM chat route ([docs/plan.md](plan.md), Decisions: Answer pipeline).

## Setup

- **Model and hardware.** The 32 GB tier of the presets: qwen3:14b-q4_K_M for answers, bge-m3 for embeddings, context 8,192 tokens, Balanced scope (5 sections), on an M1 Max with 64 GB. Thinking off, temperature 0.1.
- **Corpora.** Two sets of public procurement regulations and guidance, 12 documents in English and 15 in Chinese: digital and scanned PDFs, Word files, spreadsheets, a plain-text web page, and in the Chinese set two formats of one document. The documents, questions and answer keys stay outside the repository; the repository holds only invented fixture corpora.
- **Question sets.** Each question has a category, its expected sections and the literal key elements a correct answer must contain ([docs/eval.md](eval.md), Writing questions).

| Set | Questions | Used for |
|---|---|---|
| Tuning (English) | 30 | choosing changes |
| Check (English) | 15 | never used for tuning; run once at the end of every round |
| Absent | 10 | questions with no answer in the documents |
| Chinese | 25 | the Chinese corpus |
| Cross-document | 10 | questions that need two files and name both |
| Holdout | 10 (8 cross-document, 2 absent) | sealed; opened once at the end for a measurement-only run |

## Metrics

All computed by the harness ([docs/eval.md](eval.md), Metrics) on the app's own pipeline code, not a reimplementation.

- **Hit** (target section hit, stage 1, no model): every expected section is among the sections selected for the model. It measures retrieval alone.
- **Cited** (right section cited, stage 2): every expected section is among the sections the final answer cites, after citation checking. For a cross-document question both files' sections must be cited.
- **Attribution**: the answer states at least one key element, every stated element is in a cited section, and every cited section supports the sentence that cites it (it passed the citation check against that section). A refusal to an absent question counts as correct. Known blind spot: an extra citation to a section that merely shares vocabulary with the right one passes as long as the fact is in another cited section. So a second count, cited sections without any key element (`cited_without_key`), is reported beside it and gated.
- **Coverage** (key element coverage): the share of key elements present in the answer, counted only over elements that appear word for word in the expected sections (a paraphrase no quoting answer can contain is left out).
- **Refusal**, as two rates: false refusals (answerable questions answered "not in your documents") and false answers (absent questions given an answer).
- **Complete** (final figures only): graded by hand, by me, from the answer as the user sees it, the full expected section text and the key elements. Every fact asked for is stated, and nothing wrong or unsupported.

## Method

**A harness that runs the shipped code.** One command indexes a corpus into a hidden workspace with the configuration under test, runs every question through the same answer pipeline the app runs, and writes results per question. Stage 1 caches retrieval per question and sweeps section count and similarity floor without calling the model, so a retrieval change costs seconds. Stage 2 runs the model only for the configurations named.

**Seeded runs.** Early rounds compared runs against a variance band of three runs of the kept configuration, and a change counted only outside it. From the seeded rounds on, every model call carries seed 42 with Ollama serving one request at a time and restarted before each configuration. Three seeded runs of one configuration gave identical answers on every question, so each later round needed one run per configuration, and a difference between two runs is a difference between two configurations.

**Rescoring without the model.** Every reply is recorded. A change to citation checking or to a metric is measured by replaying the recorded replies through the new code, so the comparison holds the model's text fixed.

**One class of change per round, behind a switch.** Every mechanism was built behind a switch, off by default, and measured alone against the kept configuration. Switches that were not kept stay in the code, off on every tier, so they can be measured again.

**Gating sets and the keep rule.** The tuning and check sets are gated with thresholds (right section cited and attribution at least 90 percent, coverage at least 85 percent, median latency at most 20 s, false refusals at most 5 percent, false answers at most 10 percent). From 2026-11-05:

- A change is kept only if at least one gated metric improves and **no gated metric falls**. No regression alone is not a pass.
- The cross-document set became a gated set with frozen questions and keys.
- A change that moves only the cross-document set is kept only if it is a deterministic root-cause fix whose mechanism is written down, **never a numeric adjustment** such as a quota, threshold or bonus. On ten questions, a tuned number would fit the set rather than the problem.
- Per gated set, `cited_without_key` must not rise, except by one when that set's cited count rises by at least two questions.

**A sealed holdout.** A fresh set of cross-document questions was written, its file hashed and recorded, and not opened, read or run until I decided to. It was run once, measurement only, on the final configuration; no round may be started from its result.

**Stopping conditions.** A phase ends when every remaining failure is classed as a capability limit rather than a mechanism bug, when a fix has been validated once on a fresh sealed holdout, or when a round costs more than it returns. Verification-layer bugs found later get a fixed budget of two per release.

The harness, the switches and the rounds were built in Claude Code sessions working from the plan; I validated the question sets and answer keys, graded the final answers by hand, and decided every keep or drop.

## What was tried

Rounds that bear on cross-document answers, in order. "Kept" means on in every tier of `config/presets.json`. Figures are given where they are recorded in the public docs or commit history.

| Round | Change | Kept | What happened |
|---|---|---|---|
| 2 | Citation check: every sentence scored against the passage it cites by content-word overlap; moved to a better source or marked unsupported (†) | yes | The basis of attribution; everything after builds on it |
| 7 | Document affinity: boost the sections of a file the question names, restrict checking to it | no | Did not pass the rule; replaced by the quota below |
| A2 | Cross-document mode: per-file quota, sources grouped by file with per-file answering, checking by the file a sentence names | no | The grouped prompt lowered attribution on the cross-document set |
| A2a | The quota part alone: each named file's top sections join the selection | yes | Retrieval gain without the prompt change |
| C1 | Quota sections from a search inside each named file | no | Not kept on its own |
| C3 | The in-file search without tables of contents, 5 sections per file, at most 8 | yes | Passed the keep rule |
| X1 | Search each named file with the clause of the question that names it | no | No gain on any set |
| X2 | Fixed fusion bonus for a section whose heading path holds a question term | yes | Passed the keep rule |
| X3 | 8 quota sections per file, at most 10 | no | Cross-document cited -20 points |
| N1, N2 | File names, then readable display names, in the source headers and the question as sent | N2a'' yes | Display names kept; the other variants lowered check-set attribution (-7) |
| D4 | A citation also stands for selected sections with identical text (format copies of one document) | yes | Restored a citation lost on the Chinese set |
| B | Judge rerank: for questions naming two or more files, the chat model scores each file's 15 best in-file candidates 0 to 3 before the quota is taken | yes, second attempt | First measurement: cited 70 to 80 percent, but one new cited section without a key element, so **not kept**. After a deterministic fix to the identical-text normalization: cited 70 to 90 percent, no gated metric falls, **kept**. Cost: a median 50 s per judged question |
| P2 | Format label after the names of format copies | no | One cross-document reply moved to a section without a key element |
| V1, V2, P1, P3 | Citation-check fixes: rule echoes are refusals; question words are not evidence; lead-in sentences are not unsupported; English compared by stem | yes | Measured by rescoring; fewer † markers on correct sentences (P1, P3), no gated metric fell |

The judge-rerank round shows the keep rule at work, including where it bent. The first result looked like a win on the headline number, but the per-set count of cited sections without a key element exposed a defect: two copies of one section, in two formats, were not recognised as identical, so an answer gained a card that proved nothing. After fixing the normalization, cited rose from 70 to 90 percent. The kept run still had one more cited section without a key element than before. In the same round I amended the rule to allow an increase of one when the set's cited count rises by at least two questions. The amendment is recorded with the reason, and it is a judgement call: it accepts one weak extra citation for two more questions with both right sources cited.

## The holdout result

The holdout was opened once, on 2026-11-06, after its hash was checked, and run with the final configuration and no change. The measurement-only run gave cited 1 of 8, attribution 6 of 10, coverage 25 percent, 1 false refusal of 8 and no false answer on the 2 absent questions. A later verification fix (V2, kept on the gated sets) restored one holdout citation. On the released configuration:

| | Right sources cited | Answer complete (hand graded) |
|---|---|---|
| Cross-document set, questions name both files | 9 of 10 | 8 of 10 |
| Holdout, questions describe the files or name neither | 2 of 8 | 3 of 8 |

**What it showed.** The cross-document gains came from mechanisms that start only when the question names its files: the per-file quota, the in-file search and the judge. File detection matches what is written in the question against identifiers built at index time: the file name, its readable display name, the cover title, a type word only one file has. The holdout questions referred to the documents the way people talk, by description or not at all (invented examples: "the old staff rules", "the new framework"). Such references match no identifier, so detection does not fire. On the holdout run the judge fired on no question at all. Without detection, neither the quota nor the judge applies, and the question goes through plain library-wide retrieval, where one document can crowd out the other, the first failure above.

So the low holdout figure comes mainly from the two documents not being recognised, rather than from retrieval or generation as such. The cross-document set had named its files, as a test writer tends to. The holdout showed that the gains did not carry over to the way people actually phrase such questions. That is what a sealed set is for, and it was found before release rather than by users.

The README and the user guide therefore report both rows side by side, and the user guide tells users that naming both files works best.

## Product decisions from testing

- **Ask needs 16 GB.** Answers were measured acceptable only with the 14B model; qwen3:8b lost attribution and abstention against it, and 14B needs 16 GB. So the 8 GB tier keeps Browse and Find and turns Ask off rather than answering worse. The 16 GB tier runs the same 14B model at a 3-bit quantization, chosen in a quantization and context matrix (7.45 GiB in memory against 9.17 GiB for 4-bit).
- **No cross-encoder reranker.** The plan had one per tier, but onnxruntime crashed on the test Mac when a bge reranker loaded, so every tier ranks by fused order with a vector floor. The download code stays for a tier that names a model again.
- **Judge latency accepted.** Judge rerank makes a question naming two documents take about 76 s in all, against about 14 s for an ordinary English question. It was kept because it passed the keep rule, and it runs only when a question names two or more files.
- **File type whitelist.** A tester's library of dozens of code repositories froze the app at every start. Since then a library reads only PDF, Word, Excel, PowerPoint, Markdown and text (CSV left the list), and never enters, counts or watches dot folders, `node_modules`, virtual environments, macOS packages and similar.
- **Folder limit of 1,000 subfolders.** One watched folder is one path of the process's single file-system event stream on macOS. At 4,097 paths every watch fails and the window froze for 80 to 130 s. Below that, closing the watches still froze the window, growing with the square of the folder count: 2.9 s at 1,000 subfolders, 6.2 s at 1,500 and 14 s at 2,000 (measured in the packaged app). 1,000 is the largest measured size under 5 s. A folder over the limit is not added, and the user is asked to add smaller folders inside it.
- **Recovery after a start that did not finish.** A library that froze the app at one start would freeze it again at the next. A marker written before the watcher starts and removed when the library runs detects this. On the next start the library opens with its existing index, still answerable, and the user is asked whether to check its folders now or later.
- **Summaries, checked.** One-sentence summaries per document are made by the same local model and go through the same citation check as answers; an unsupported summary is dropped, not shown.

## What's next

- **Detect descriptive file references.** The main remaining loss. Questions that describe documents ("last year's guidance") need to be mapped to files before the per-file mechanisms can run. Its scope is to be set from the real questions collected in user testing, and validated once on a fresh sealed holdout, never on the one already opened.
- **Numbers in citation checking.** The check compares content words, and a number is one more token, so a sentence with a wrong figure can pass when its other words match. Proposed rule: every number in a sentence must appear in the section it is attributed to.
- **Chinese citation checking.** Character-pair overlap separates a sentence's own clause from a sibling clause of the same standard template poorly.
- **A larger cross-document set.** Ten gated questions and eight holdout questions are enough to see a failure class, not to measure small gains. Its size is also why the keep rule forbids numeric tuning against it.

Sources: [docs/plan.md](plan.md) (decisions, measurement rounds, acceptance and stopping rules, Phase 2 result), [docs/eval.md](eval.md) (harness, metrics, every switch), [docs/app.md](app.md) (answer pipeline, libraries, recovery), [docs/user-guide.md](user-guide.md) (figures as users see them).
