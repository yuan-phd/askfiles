# Session G: evaluation harness (plan task 2.3)

Executor: CLOUD builds it; the real runs happen LOCAL on the Mac with Metal
Dependencies: Session A merged (Q9 for API shapes). Session C merged is convenient for starting the server; otherwise start it with the verified commands from the analysis report.
Branch: session/g-eval-harness
PR title: [Session G] Retrieval evaluation harness

## Goal

A repeatable script that takes a corpus folder and a questions CSV, runs every question through AnythingLLM with a given configuration, and writes a results CSV the owner can score. Phase 2 uses it to choose thresholds, snippet counts and models per RAM tier from measurements instead of opinions.

## Inputs

- Corpus: a folder of documents. Phase 2 uses two corpora that mirror real use (docs/plan.md task 2.1). Corpus S: 10 to 20 small files of a few pages each. Corpus L: 3 to 4 large files of several tens of pages each. Both contain Chinese and English, at least one scanned PDF, one Word file and one spreadsheet with a table; corpus S also has two near-duplicate versions of one file. The harness runs one corpus per run and records which one in run.json.
- questions.csv with columns: id, category, question, expected_answer, expected_source_file, expected_section, expected_page, notes. expected_section is the section title as it appears in the document; for section_listing questions it holds every expected section, separated by a semicolon. Categories: single_fact, middle_of_long_doc, cross_document, table_number, absent_related, absent_unrelated, version, section_listing (the expected result is the list of relevant sections rather than a synthesized answer).
- A config JSON: server base URL, API key, workspace name (internal; the user never sees it), chat model, embedding model, similarity threshold, max snippets, chunk strategy (by heading), chunk maximum in tokens (candidates 1000, 1500, 2000), chat mode, system prompt, temperature, passes (default 2).

## Deliverables

1. scripts/eval/run.ts (run with tsx or compiled): creates or reuses a workspace with the config's settings applied through the API (or the documented fallback from Q5 and Q7), splits the corpus by section with the configured chunk strategy and maximum (through the override recommended in Q13), uploads and embeds it (skipping documents already embedded by hash and split settings, so a change of chunk maximum re-embeds), then for each question and each pass calls chat with sources and records: answer text, sources (file, section title, section index, page, passage), first token latency, total latency, token counts if the API exposes them.
2. results.csv with one row per question per pass, plus a run.json with the full config, the UPSTREAM_VERSION, start and end time, and the model tags actually reported by Ollama.
3. scripts/eval/score.ts: merges a hand-scored CSV (same ids, a score column with values correct, partial, wrong, refused, hallucinated) and prints per-category rates, refusal correctness on absent categories, citation hit rate by file, section and page, section recall on section_listing questions, and median latencies, per corpus. Also prints a compact Markdown table ready to paste into docs/plan.md.
4. scripts/eval/compare.ts: takes two run folders and prints the per-category deltas.
5. Two small fixtures, one for each corpus shape, so the harness can be smoke-tested here with the test models:
   - test/fixtures/eval-s/: four or five short files with headings (Chinese and English, one Word file, one spreadsheet with a table, and two near-duplicate versions of one file) and a questions CSV covering every category.
   - test/fixtures/eval-l/: one longer file with several levels of headings and at least one section longer than the smallest chunk maximum, so sub-chunk splitting and merging are exercised, and a questions CSV with middle_of_long_doc and section_listing questions.
   A scanned PDF is not required in the fixtures; the real corpora carry it. Keep both fixtures small enough that a smoke run finishes in a few minutes.
6. docs/eval.md: how to write questions, how to score consistently (one paragraph per score value with an example), how to run the two passes, how to record a run in the plan.

## Tests

- Unit tests for CSV parsing, hashing, score aggregation and the Markdown table output.
- Smoke run against both fixtures in this container with RUN_INTEGRATION=1; attach the results.csv to the PR. Quality of answers from the 0.6b test model is irrelevant here; the pipeline is what is being tested.

## Do not

- Do not score answers automatically with a model. Scoring is the owner's job by design.
- Do not edit upstream/.

## Acceptance

- Smoke run completes end to end here for both fixtures and produces results.csv and run.json for each.
- npm test green.
- PR opened with the smoke results attached and the exact command line the owner will run on the Mac.
