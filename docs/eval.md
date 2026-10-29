# Retrieval evaluation harness

Plan task 2.3. The harness takes one corpus folder and one questions CSV, puts the corpus into a hidden AnythingLLM workspace with the configuration under test, asks every question in every pass, and writes a results.csv for you to score and a run.json that records exactly what ran. Scoring is yours; the harness never asks a model to judge an answer.

Scripts are in scripts/eval: run.ts (one run), score.ts (report for scored runs), compare.ts (two runs side by side). The section splitter they use is the shell's own, in src/main/sections, so phase 2 measures the same split the app will ship.

## What a run does

1. Starts its own Ollama, collector and server from upstream/ with the patches applied (reverted at the end), or connects to a running server when the config has a baseUrl.
2. Checks that Ollama has the chat and embedding models and records their tags, digests and quantization.
3. Splits every file in the corpus by section (PDF bookmarks or font size, Word headings, Markdown headings, one section per spreadsheet sheet), cuts sections longer than chunkMax into sub-chunks that each start with the section title, and writes one document JSON per chunk into STORAGE_DIR/documents/askfiles-eval. A PDF without a text layer goes through the collector once for OCR; its text is cached by file hash and its sections have no page numbers.
4. Creates or reuses the workspace for the embedding model, applies the settings from the config, and embeds only the documents it does not hold yet. Document names come from the file's path and bytes, the chunk maximum, the splitter version and the embedding model, so an unchanged corpus is not embedded twice and a new chunk maximum embeds again.
5. Sends one warm-up question so model loading does not count toward the first answer, then asks every question once per pass with a fresh session, streaming, and records the answer, the sources, first token and total time and token counts.
6. When the answer is the refusal, it also lists the nearest sections the way the search page does (vector-search, 8 results, any score), so section listing can be measured even when the model refuses.

## One-time setup on the Mac (LOCAL)

Node 22 and Ollama must be installed; the Ollama app puts the ollama command on PATH. Then, from the repository root:

```bash
npm install
```

```bash
cd upstream/server && PUPPETEER_SKIP_DOWNLOAD=1 yarn install --frozen-lockfile && cd ../..
```

```bash
cd upstream/collector && PUPPETEER_SKIP_DOWNLOAD=1 yarn install --frozen-lockfile && cd ../..
```

```bash
ollama pull qwen3:8b
```

```bash
ollama pull bge-m3
```

The upstream frontend is not needed. Pull every chat model you want to test (for example qwen3:4b and qwen3:14b for the other tiers).

## Running

```bash
npm run eval -- ~/AskFiles-eval/corpus-s ~/AskFiles-eval/questions-s.csv --config scripts/eval/configs/default.json --corpus-label S
```

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| --config | scripts/eval/configs/default.json | Configuration under test |
| --corpus-label | the corpus folder name (its parent's name when the folder is called corpus) | Name recorded in run.json and used to group reports; use S and L |
| --out | eval-runs/<UTC time>-<corpus>-<config label> | Run folder |

The run folder holds results.csv, run.json and, in managed mode, logs/ with the Ollama, collector and server logs. eval-runs/ and the data directory .eval-data/ are ignored by git. Keep run folders of the real corpora out of git: results.csv quotes passages from your documents and the repository is public.

Both passes run inside one run: with passes 2, every question is asked once, then all of them again, and each row carries its pass number. A candidate configuration is one config file; copy default.json, change one or two values, give it a new label, and run it once per corpus.

### Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| label | required | Short name for the run folder and the tables |
| chatModel | required | Ollama tag of the chat model; written to the workspace and, in managed mode, to OLLAMA_MODEL_PREF |
| embeddingModel | required | Ollama tag of the embedder. Each embedder gets its own workspace |
| systemPrompt | required | Workspace system prompt; always written, so no earlier prompt lingers |
| similarityThreshold | medium | Number from 0 to 1, or none (0), low (0.25), medium (0.5), high (0.75) as in the upstream settings page |
| topN | 4 | Max context snippets |
| chunkStrategy | heading | Only heading exists |
| chunkMax | 2000 | Chunk maximum in characters, at least 400. Plan candidates: 1500, 2000, 2500 |
| chatMode | query | query or chat |
| temperature | 0.1 | |
| rerank | false | Upstream accuracy-optimized search. The first rerank run downloads the reranker from huggingface.co |
| reasoningEffort | off | Sent with every question (patch 007); empty uses the server default |
| passes | 2 | |
| contextTokens | 0 | Managed mode: OLLAMA_MODEL_TOKEN_LIMIT; 0 keeps upstream's default (the model's context, at most 16384) |
| workspace | askfiles-eval | Base name of the hidden workspace |
| dataDir | .eval-data in the repository | Managed mode: data directory kept between runs |
| ollamaBin | ollama on PATH | Managed mode: path of the ollama binary |
| baseUrl, apiKey, storageDir | empty | External mode: an already running server, its key (created when empty) and its STORAGE_DIR. The server's embedding model must equal embeddingModel and its EMBEDDING_MODEL_MAX_CHUNK_LENGTH must be at least chunkMax, or the run stops before asking anything |

Managed mode is the normal case: the harness sets EMBEDDING_MODEL_MAX_CHUNK_LENGTH to chunkMax so upstream does not cut the chunks again, and DEFAULT_REASONING_EFFORT=off.

## Writing questions

questions.csv has the columns id, category, question, expected_answer, expected_source_file, expected_section, expected_page, notes. Save it as UTF-8 CSV. Rules:

- id: unique and stable; scores are matched by id, so never reuse an id for a different question.
- category: one of single_fact, middle_of_long_doc, cross_document, table_number, absent_related, absent_unrelated, version, section_listing.
- question: phrased as the target user would type it, in the language they would use. Do not copy the document's wording; paraphrase the way a person who has not read it would ask.
- expected_answer: the short fact that makes an answer correct, with the unit. For absent questions write Not in the documents.
- expected_source_file: file name only, as it is in the corpus folder. Several files are separated by semicolons (cross_document, version).
- expected_section: the section title exactly as it appears in the document, including its numbering (2.1 Lost devices, 3 提交期限). For a spreadsheet it is the sheet name. Several sections are separated by semicolons; for section_listing list every section a good answer should name. Case, full-width characters and extra spaces are ignored when matching.
- expected_page: the PDF page number as the viewer shows it (1 for the first page), or a range such as 4-6. For a spreadsheet, the sheet number (1 for the first sheet). Leave it empty for Word and Markdown files, which have no pages.
- notes: anything that helps scoring later, for example where the trap is.

Per category:

- single_fact: one fact stated once in one place.
- middle_of_long_doc: a fact in the middle of a long section of a long file, not in its first or last paragraph.
- cross_document: needs two files; both go into expected_source_file.
- table_number: a number, date or amount read from a table cell; say which row and column in notes.
- absent_related: on the topic of the corpus but not answered by it (the policy covers employees, the question asks about contractors).
- absent_unrelated: nothing to do with the corpus.
- version: asks what two versions of the near-duplicate file each say.
- section_listing: asks which sections cover a topic; the expected result is the list of sections, not a synthesized answer.

## Scoring

Open results.csv in Numbers or Excel and fill the score column of every row, both passes, without looking at the other pass. Use score_note for a few words when the choice was close. Alternatively put your scores in scored.csv next to results.csv with the columns id, pass, score (without a pass column a score applies to every pass of that id); scored.csv wins over the column in results.csv.

Score the answer text against expected_answer. The sources column shows what was cited; the citation measures are computed from it, so do not let a wrong citation change the answer score. Values:

correct: the answer states the expected fact and nothing that contradicts the documents. Extra correct detail is fine, and so is different wording or language. Example: expected 650元 per night in Shanghai; answer The limit in Shanghai is 650 yuan per night. For absent questions correct is not used: a correct outcome there is refused. For section_listing, correct means the answer names every expected section.

partial: the answer contains the expected fact but misses part of it or adds a minor inaccuracy that would not mislead the user. Example: expected Version 1: 25 days; version 2: 27 days; answer Version 2 gives 27 days, with nothing on version 1. For section_listing, some but not all expected sections are named.

wrong: the answer gives a different fact for something the documents do answer, or answers a different question. Example: expected 510000 for the Engineering total; answer 120000 (the Q1 figure).

refused: the answer says the documents do not contain the answer, in the workspace refusal text or in the model's own words, and states no fact as the answer. On absent_related and absent_unrelated this is the correct outcome. On every other category it is a false refusal. Example: Nothing in your documents answers this question.

hallucinated: the answer states a specific fact that is not in the documents, whether the question is answerable or not. Example: question How many days of annual leave do contractors get?; answer Contractors get 20 days. On answerable questions use hallucinated instead of wrong when the stated fact appears nowhere in the corpus, and wrong when it comes from the wrong place in the corpus.

When in doubt between two scores, choose the lower one in this order: correct, partial, wrong, hallucinated; and note why.

## Reports

```bash
npm run eval:score -- eval-runs/<run S> eval-runs/<run L>
```

Prints, per corpus and per run: the count of each score per category; the headline rate (correct for answerable categories, refused for absent ones); refusal correctness on absent questions; false refusals on answerable ones; citation hit rate by file, section and page over answerable rows that name an expected file, section or page, and again for rows scored correct only; section recall on section_listing questions (share of expected sections among the sources, or among the fallback list when the answer was the refusal); median first token and total latency over answered rows (refusals take milliseconds and would hide the model's speed). Unscored rows are counted and left out of the rates. At the end it prints one Markdown table row per run.

The refused and file_hit, section_hit, page_hit columns in results.csv are filled by the harness from the server response: refused means the server returned its refusal text or no sources. They help when reading; the reports recompute them from sources_json.

```bash
npm run eval:compare -- eval-runs/<run A> eval-runs/<run B>
```

Prints each category's headline rate for A and B with the difference in percentage points, hallucination and refusal rates, and the citation, section recall and latency differences. Compare runs of the same corpus; the script warns when the corpora differ.

## Recording a run in the plan

1. Score every row of both corpora for the configuration.
2. Run eval:score with the S and L run folders of that configuration.
3. Paste the Markdown table into docs/plan.md under Phase 2, below the pass criteria, under a heading with the date, the RAM tier, the Mac model and RAM, the git commit and UPSTREAM_VERSION from run.json, and the indexing time from run.json (library.embedMs for a run that embedded the corpus).
4. Note app memory from Activity Monitor during the run (task 2.5); the harness does not measure it.
5. Keep the run folders outside the repository.

## Limits

- Word and Markdown files have no page numbers; their page fields are 0 and the search page shows no page.
- OCR text from the collector has no page or section structure: a scanned PDF becomes one section titled by its file name, cut into sub-chunks.
- PDF sections come from bookmarks, else from font size, else one per page. A bookmark that points well above its heading can pull the line above it into the next section.
- The harness measures latency through the server's streaming route on the machine it runs on; the Electron app adds nothing to it but window rendering.
- Smoke runs in the cloud container use qwen3:0.6b and all-minilm on CPU and only test the pipeline; their answers say nothing about quality. Their output is in docs/eval-smoke.
