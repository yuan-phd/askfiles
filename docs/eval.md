# Evaluation harness

Plan task 2.3, extended by Session L. The harness takes one corpus folder and one questions CSV, puts the corpus into a hidden AnythingLLM workspace with the configuration under test, asks every question, and writes results.csv and run.json into a run folder. By default questions go through the shell's own answer pipeline (src/main/answer, the code the app runs); with --upstream they go through the upstream chat route as before, so both can be compared on the same questions.

Scripts are in scripts/eval: run.ts (one run), score.ts (report for one or more runs), compare.ts (two upstream-route runs side by side). The section splitter is the shell's own, in src/main/sections, so the eval measures the split the app ships.

## The tuning loop

Each loop is: set parameters, run, read the table, change parameters. A loop never needs a file edit: every value can be overridden with --set.

1. Stage 1, retrieval only (the default). For every question the harness runs candidates, fusion and reranking once and caches the result on disk under .eval-data/retrieval-cache/<index hash>/, keyed by the question text. The index hash covers the indexed chunks (file bytes, split settings, embedder) and the retrieval parameters (rerankerModel, rerankerBypassCjk, vectorTopK, keywordTopK, rrfK, candidateSections, sectionCapChars), so a second run with the same corpus and those values takes seconds. It then sweeps section count and rerank floor over a grid and prints the target-section hit rate for every pair, with the config's own pair in bold. No model is called.
2. Stage 2, answers (--answer). The model runs only for the configurations you name with --try (default: the config's scope values), on the cached retrievals, and the harness computes key element coverage and attribution accuracy next to target section hit and latency.

```bash
npm run eval -- ~/AskFiles-eval/corpus-s ~/AskFiles-eval/questions-s.csv --corpus-label S
```

```bash
npm run eval -- ~/AskFiles-eval/corpus-s ~/AskFiles-eval/questions-s.csv --corpus-label S --set candidateSections=8 --floors 0,0.05,0.1,0.3
```

```bash
npm run eval -- ~/AskFiles-eval/corpus-s ~/AskFiles-eval/questions-s.csv --corpus-label S --answer --try count=2,floor=0.3 --try count=3,floor=0.1
```

Changing section count or rerank floor needs no new retrieval; changing a retrieval parameter or the reranker fills a new cache folder once.

## What a run does

1. Starts its own Ollama, collector and server from upstream/ with the patches applied (reverted at the end), or connects to a running server when the config has a baseUrl.
2. Checks that Ollama has the embedding model (and the chat model for stage 2 and --upstream) and records their tags, digests and quantization.
3. Splits every file in the corpus by section (PDF bookmarks or font size, Word headings, Markdown headings, one section per spreadsheet sheet), cuts sections longer than chunkMax into sub-chunks that each start with the section title, and writes one document JSON per chunk into STORAGE_DIR/documents/askfiles-eval. A PDF without a text layer goes through the collector once for OCR; its text is cached by file hash and its sections have no page numbers.
4. Creates or reuses the workspace for the embedding model, applies the settings from the config, and embeds only the documents it does not hold yet. Document names come from the file's path and bytes, the chunk maximum, the splitter version and the embedding model, so an unchanged corpus is not embedded twice and a new chunk maximum embeds again.
5. Answer pipeline (default): builds the browse index and the watcher's file records from the split, so keyword search and section records are the app's own; fetches the config's reranker into rerankerDir when it is missing (pinned revision, sha256 checked); then runs stage 1 and, with --answer, stage 2.
6. Upstream route (--upstream): sends one warm-up question so model loading does not count toward the first answer, then asks every question once per pass with a fresh session, streaming, and records the answer, the sources, first token and total time and token counts. When the answer is the refusal it also lists the nearest sections (vector-search, 8 results, any score).

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

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| --config | scripts/eval/configs/default.json | Configuration under test |
| --set name=value | none | Overrides one value, repeatable. Answer parameters by name (rerankFloor=0.35 sets all three scopes, rerankFloor.balanced=0.35 one), any other config key at the top level (temperature=0, scope=strict, passes=1) |
| --answer | off | Stage 2: run the model too |
| --try count=N,floor=X | the config's scope values | Stage 2 configuration, repeatable |
| --counts | 1,2,3,4,5,6 | Section counts of the stage 1 sweep |
| --floors | 0,0.01,0.05,0.1,0.2,0.3,0.5,0.7 | Rerank floors of the stage 1 sweep |
| --upstream | off | Ask through the upstream chat route instead (owner scoring, as before Session L) |
| --corpus-label | the corpus folder name (its parent's name when the folder is called corpus) | Name recorded in run.json and used to group reports; use S and L |
| --out | eval-runs/<UTC time>-<corpus>-<config label> | Run folder |

The run folder holds results.csv (stage 1 rows, or stage 2 rows with retrieval.csv beside them), run.json (configuration, overrides, index hash, the sweep and the metric summaries) and, in managed mode, logs/. eval-runs/ and the data directory .eval-data/ are ignored by git. Keep run folders of the real corpora out of git: results.csv quotes passages from your documents and the repository is public.

### Answer parameters

The answer block of a config file holds the same keys, with the same names, as the answer block of each tier in config/presets.json; a value found here is copied into the preset unchanged. A config may list only the keys it changes. Defaults below are those of src/main/answer/params.ts; the presets set some per tier.

| Parameter | Default | Effect |
| --- | --- | --- |
| rerankerModel | Xenova/ms-marco-MiniLM-L-6-v2 | Cross-encoder: Xenova/ms-marco-MiniLM-L-6-v2 (English, 23 MB), Xenova/bge-reranker-base (Chinese and English, 296 MB), onnx-community/bge-reranker-v2-m3-ONNX (multilingual, 588 MB) |
| rerankerBypassCjk | true | Skip reranking when the question or a candidate section is mainly Chinese, Japanese or Korean, and select by fusion score with no floor; for the English-only reranker |
| vectorTopK | 30 | Sub-chunks from vector search, no score floor. Rarely worth changing |
| keywordTopK | 30 | Sections from the keyword index (BM25 over section text). Rarely worth changing |
| rrfK | 60 | k of reciprocal rank fusion; lower favours the top of each list. Rarely worth changing |
| candidateSections | 12 (8 in the bge tiers) | Sections passed to the reranker; bounds rerank time. Rarely worth changing |
| sectionCapChars | 0 (twice chunkMax) | Longest section text given to the reranker and the model. Rarely worth changing |
| sectionCount | strict 2, balanced 3, broad 5 | Most sections the model reads, per answer scope. Tuned in phase 2 |
| rerankFloor | strict 0.5, balanced 0.1, broad 0.01 | Lowest rerank score a section needs, per scope; with no section above it the model is not asked and the page shows the nearest sections. Tuned in phase 2 |
| contextBudgetTokens | 0 (context length minus 1536) | Tokens for the numbered sources; whole sections are kept, the longest is trimmed when they do not fit |
| promptVariant | default | default, or strict (every sentence must cite, no background knowledge, shortest answer) |

Two top-level keys complete the pipeline settings: scope (strict, balanced or broad; which section count and floor a run uses, default balanced) and temperature. contextTokens is the context length (0 means 8192, the presets' value); rerankerDir is where the reranker files are (default .eval-data/models/reranker).

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
| rerank | false | Upstream accuracy-optimized search. The first rerank run downloads the reranker from huggingface.co. scripts/eval/configs/rerank.json is default.json with rerank on, for the phase 2 comparison |
| reasoningEffort | off | Sent with every question (patch 007); empty uses the server default |
| passes | 2 | |
| contextTokens | 0 | Managed mode: OLLAMA_MODEL_TOKEN_LIMIT; 0 keeps upstream's default (the model's context, at most 16384) |
| workspace | askfiles-eval | Base name of the hidden workspace |
| dataDir | .eval-data in the repository | Managed mode: data directory kept between runs |
| ollamaBin | ollama on PATH | Managed mode: path of the ollama binary |
| scope | balanced | Answer scope of the pipeline run |
| answer | the defaults above | Answer parameters (table above) |
| rerankerDir | .eval-data/models/reranker | Reranker files; fetched here when missing |
| baseUrl, apiKey, storageDir | empty | External mode: an already running server, its key (created when empty) and its STORAGE_DIR. The server's embedding model must equal embeddingModel and its EMBEDDING_MODEL_MAX_CHUNK_LENGTH must be at least chunkMax, or the run stops before asking anything |

The keys from chatModel to passes also set up the upstream workspace, which only --upstream runs ask through; the pipeline reads chatModel, temperature, contextTokens, chunkMax, scope and answer.

Managed mode is the normal case: the harness sets EMBEDDING_MODEL_MAX_CHUNK_LENGTH to chunkMax so upstream does not cut the chunks again, and DEFAULT_REASONING_EFFORT=off.

## Writing questions

questions.csv has the columns id, category, question, expected_answer, expected_source_file, expected_section, expected_section_path, expected_page, key_elements, notes; expected_section_path and key_elements may be empty or missing. Save it as UTF-8 CSV. Rules:

- id: unique and stable; scores are matched by id, so never reuse an id for a different question.
- category: one of single_fact, middle_of_long_doc, cross_document, table_number, absent_related, absent_unrelated, version, section_listing.
- question: phrased as the target user would type it, in the language they would use. Do not copy the document's wording; paraphrase the way a person who has not read it would ask.
- expected_answer: the short fact that makes an answer correct, with the unit. For absent questions write Not in the documents.
- expected_source_file: file name only, as it is in the corpus folder. Several files are separated by semicolons (cross_document, version).
- expected_section: the section title exactly as it appears in the document, including its numbering (2.1 Lost devices, 3 提交期限). For a spreadsheet it is the sheet name. Several sections are separated by semicolons; for section_listing list every section a good answer should name. Case, full-width characters and extra spaces are ignored when matching.
- expected_page: the PDF page number as the viewer shows it (1 for the first page), or a range such as 4-6. For a spreadsheet, the sheet number (1 for the first sheet). Leave it empty for Word and Markdown files, which have no pages.
- expected_section_path: optional, the headings from the outside in down to the section, separated by >, as the source cards print them (Employee handbook > Leave > Annual leave). The end of the path is enough (Leave > Annual leave) when the outer headings do not matter. When it is set it is used instead of expected_section; several paths are separated by semicolons.
- key_elements: phrases a correct answer must contain, separated by semicolons. Write the smallest pieces that carry the fact: the number with its unit when the unit matters (27 days), the name (operations director), the code (IT-4521). Case and whitespace are ignored (27days matches 27 Days), so do not list spelling variants of spacing; list a second element instead of one long sentence. Each element should also appear verbatim in the expected section, because attribution accuracy looks for the elements in the cited sections. Leave it empty for absent questions.
- notes: anything that helps scoring later, for example where the trap is.

The Ask page's developer panel (ASKFILES_DEVELOPER=1) writes rows in this format: Save as eval case appends the last question with the candidate section you clicked as expected_source_file, expected_section and expected_section_path to <data directory>/eval-questions.csv (ASKFILES_EVAL_QUESTIONS overrides the file). Fill in expected_answer and key_elements before running it.

### Example: ten questions of one real library

The shape of the owner's first test (2026-10-30, ten questions on a private corpus) without its documents; the file names, headings and facts here are made up. It mixes single facts, an exact tool name, a lower-case phrase that only keyword search finds, a cross-document question and an absent one:

```csv
id,category,question,expected_answer,expected_source_file,expected_section,expected_section_path,expected_page,key_elements,notes
o01,single_fact,Which tool do we use for expense approvals?,Concur,finance-handbook.pdf,Approvals,Finance > Expenses > Approvals,12,Concur,exact tool name
o02,single_fact,What are task teams responsible for?,Delivery of one project each,org-guide.docx,Task teams,Organisation > Task teams,,task teams;one project,lower-case phrase that vector search misses
o03,middle_of_long_doc,How long are meeting minutes kept?,Seven years,records-policy.pdf,Retention,Records > Retention,31,seven years,
o04,table_number,What is the travel budget for 2026?,48000 EUR,budget-2026.xlsx,Budget 2026,,1,48000,
o05,single_fact,Who signs contracts above 50000 EUR?,The managing director,finance-handbook.pdf,Signatures,Finance > Signatures,15,managing director,
o06,cross_document,Which form starts onboarding and who sends it?,Form HR-7 sent by the team lead,hr-forms.pdf;onboarding.docx,HR-7;First week,,,HR-7;team lead,two files
o07,version,What notice period do v1 and v2 of the contract template give?,v1 one month; v2 three months,contract-v1.docx;contract-v2.docx,Notice;Notice,,,one month;three months,near-duplicates
o08,section_listing,Which sections cover remote work?,Remote work; Equipment,hr-handbook.pdf,Remote work;Equipment,,,remote work,
o09,single_fact,远程办公需要谁批准？,直属经理,员工手册.docx,远程办公,第三章 > 远程办公,,直属经理,Chinese
o10,absent_related,How many days of leave do interns get?,Not in the documents,,,,,,leave rules cover employees only
```

Per category:

- single_fact: one fact stated once in one place.
- middle_of_long_doc: a fact in the middle of a long section of a long file, not in its first or last paragraph.
- cross_document: needs two files; both go into expected_source_file.
- table_number: a number, date or amount read from a table cell; say which row and column in notes.
- absent_related: on the topic of the corpus but not answered by it (the policy covers employees, the question asks about contractors).
- absent_unrelated: nothing to do with the corpus.
- version: asks what two versions of the near-duplicate file each say.
- section_listing: asks which sections cover a topic; the expected result is the list of sections, not a synthesized answer.

## Metrics

Computed by the harness for pipeline runs (stage 2) and by eval:score for every run, per question and per configuration and category:

- Target section hit: every expected section is among the cited sections (stage 2) or among the selected sections (stage 1). A section matches when its file is the expected file and its path ends with expected_section_path (or its title equals expected_section). Not counted for absent questions or questions without an expected section.
- Key element coverage: the share of key_elements present in the answer text, case and whitespace insensitive. A not-found answer covers nothing. Not counted for questions without key_elements.
- Attribution accuracy: true when every cited section contains at least one key element, or when the answer is a refusal (the not-found state) to an absent question. An answer that cites nothing, a refusal to an answerable question, and any answer to an absent question are false. This catches a citation that points at the wrong file or section even when the answer text is right.
- Latency: median first token and total time. For stage 2, total is the cached retrieval's time plus the model call.

For upstream-route runs eval:score computes the same three metrics with the sources the server returned standing in for the cited sections, so the two routes can be compared on one table.

## Scoring by hand (upstream route)

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

For every run folder it prints one table: for a stage 1 run the sweep, for a stage 2 or upstream run target section hit, key element coverage, attribution accuracy and median latency per configuration and category (the all row first). For upstream runs it then prints, per corpus: the count of each score per category; the headline rate (correct for answerable categories, refused for absent ones); refusal correctness on absent questions; false refusals on answerable ones; citation hit rate by file, section and page over answerable rows that name an expected file, section or page, and again for rows scored correct only; section recall on section_listing questions; median first token and total latency over answered rows. Unscored rows are counted and left out of the rates. At the end it prints one Markdown table row per upstream run.

The refused and file_hit, section_hit, page_hit columns in an upstream results.csv are filled by the harness from the server response: refused means the server returned its refusal text or no sources. They help when reading; the reports recompute them from sources_json.

```bash
npm run eval:compare -- eval-runs/<run A> eval-runs/<run B>
```

For two upstream-route runs: each category's headline rate for A and B with the difference in percentage points, hallucination and refusal rates, and the citation, section recall and latency differences. Compare runs of the same corpus; the script warns when the corpora differ. Pipeline runs are compared by putting both folders on one eval:score command.

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
- The harness measures latency on the machine it runs on; the Electron app adds nothing to it but window rendering. The reranker runs in the harness's Node process here and in the app's main process there.
- The stage 1 cache is keyed by question text and index hash only: after changing the pipeline code itself, delete .eval-data/retrieval-cache.
- With rerankerBypassCjk on, a library that mixes Chinese and English sections bypasses the reranker for most questions, and the floor columns of the sweep then show the same numbers.
- Smoke runs in the cloud container use qwen3:0.6b and all-minilm on CPU and only test the pipeline; their answers say nothing about quality. Their output is in docs/eval-smoke: eval-s and eval-l through the upstream route (Session G), pipeline-s and pipeline-l through the answer pipeline, stages 1 and 2 (Session L).
