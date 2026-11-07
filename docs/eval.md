# Evaluation harness

Plan task 2.3, extended by Session L. The harness takes one corpus folder and one questions CSV, puts the corpus into a hidden AnythingLLM workspace with the configuration under test, asks every question, and writes results.csv and run.json into a run folder. By default questions go through the shell's own answer pipeline (src/main/answer, the code the app runs); with --upstream they go through the upstream chat route as before, so both can be compared on the same questions.

Scripts are in scripts/eval: run.ts (one run), score.ts (report for one or more runs), compare.ts (two upstream-route runs side by side). The section splitter is the shell's own, in src/main/sections, so the eval measures the split the app ships.

## The tuning loop

Each loop is: set parameters, run, read the table, change parameters. A loop never needs a file edit: every value can be overridden with --set.

1. Stage 1, retrieval only (the default). For every question the harness runs candidates, fusion and reranking once and caches the result on disk under .eval-data/retrieval-cache/<index hash>/, keyed by the question text. The index hash covers the indexed chunks (file bytes, split settings, embedder) and the retrieval parameters (rerankerModel, rerankerBypassCjk, vectorTopK, keywordTopK, rrfK, candidateSections, sectionCapChars, and documentAffinity when on), so a second run with the same corpus and those values takes seconds. It then sweeps section count and rerank floor over a grid and prints the target-section hit rate for every pair, with the config's own pair in bold. No model is called.
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
3. Splits every file in the corpus by section (PDF bookmarks or font size, Word headings, Markdown headings, one section per spreadsheet sheet), cuts sections longer than chunkMax into sub-chunks that each start with the section title, and writes one document JSON per chunk into STORAGE_DIR/documents/askfiles-eval. The split is the watcher's own (splitWithOcr, docs/app.md, OCR in the watcher): a PDF without a text layer, and the garbled pages of one with a text layer, go through the collector page by page, cached by file hash under STORAGE_DIR/askfiles-eval-cache/ocr-pages, and run.json lists the replaced pages per file (library.files[].ocrPages). Long sections without sub-headings are split by page.
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

scripts/eval/configs/mac-32gb.json is the 32 GB tier of the presets (qwen3:14b, bge-m3:567m, reranker off) with ollamaPort 11434, so the harness uses the Ollama app instead of starting a second Ollama:

```bash
npm run eval -- <corpus folder> ~/AskFiles-eval/questions.csv --config scripts/eval/configs/mac-32gb.json
```

## Running

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| --config | scripts/eval/configs/default.json | Configuration under test |
| --set name=value | none | Overrides one value, repeatable. Answer parameters by name (rerankFloor=0.35 sets all three scopes, rerankFloor.balanced=0.35 one), any other config key at the top level (temperature=0, scope=strict, passes=1) |
| --answer | off | Stage 2: run the model too |
| --try count=N,floor=X | the config's scope values | Stage 2 configuration, repeatable |
| --counts | 1,2,3,4,5,6 | Section counts of the stage 1 sweep |
| --floors | 0,0.01,0.05,0.1,0.2,0.3,0.5,0.7; with rerankerModel none 0,0.3,0.4,0.45,0.5,0.55,0.6,0.65 | Floors of the stage 1 sweep: rerank floors, or vector floors without a reranker |
| --upstream | off | Ask through the upstream chat route instead (owner scoring, as before Session L) |
| --corpus-label | the corpus folder name (its parent's name when the folder is called corpus) | Name recorded in run.json and used to group reports; use S and L |
| --out | eval-runs/<UTC time>-<corpus>-<config label> | Run folder |

The run folder holds results.csv (stage 1 rows, or stage 2 rows with retrieval.csv beside them), run.json (configuration, overrides, index hash, the sweep and the metric summaries) and, in managed mode, logs/. eval-runs/ and the data directory .eval-data/ are ignored by git. Keep run folders of the real corpora out of git: results.csv quotes passages from your documents and the repository is public.

### Answer parameters

The answer block of a config file holds the same keys, with the same names, as the answer block of each tier in config/presets.json; a value found here is copied into the preset unchanged. A config may list only the keys it changes. Defaults below are those of src/main/answer/params.ts; the presets set some per tier.

The presets (docs/plan.md, Phase 2 result) turn on verifyCitations, enumerateWhenAsked, dropUnsupportedHedges, cjkOverlap, crossDocQuota, scopedQuotaV2, headingPathBonus, judgeRerank (round B), ruleEchoRefusal (round V1), verifyStripQuestion (round V2, with verifyStripMin 3), leadInExempt (round P1), verifyStemEnglish (round P3) and, with duplicateTextAttribution, duplicateTextTiers (round P2). crossDocument, fileScopedQuota, paragraphSelection, verdictLine, documentAffinity, enumerateFollowUp, noSummarizing, decomposeQuestions, answerMode quoted, promptVariant strict or complete, keywordStemming (round S1), perFileSubquery (round X1), namedFileQuota8 (round X3), sourceFileNames (round N1), sourceDisplayNames, questionFileNames, verifyStripNames and dropAnswerFileNames (round N2) are unused options: kept in the code for later measurements, off on every tier.

| Parameter | Default | Effect |
| --- | --- | --- |
| rerankerModel | Xenova/ms-marco-MiniLM-L-6-v2 | Cross-encoder: Xenova/ms-marco-MiniLM-L-6-v2 (English, 23 MB), Xenova/bge-reranker-base (Chinese and English, 296 MB), onnx-community/bge-reranker-v2-m3-ONNX (multilingual, 588 MB), or none: no cross-encoder, sections in fused order, vectorFloor instead of rerankFloor. none is the value of every preset and of default.json for now, because onnxruntime-node crashed (EXC_BREAKPOINT) on the owner's Mac when a bge reranker loaded (2026-10-30) |
| rerankerBypassCjk | true | Skip reranking when the question or a candidate section is mainly Chinese, Japanese or Korean, and select by fusion score with no floor; for the English-only reranker |
| vectorTopK | 30 | Sub-chunks from vector search, no score floor. Rarely worth changing |
| keywordTopK | 30 | Sections from the keyword index (BM25 over section text). Rarely worth changing |
| rrfK | 60 | k of reciprocal rank fusion; lower favours the top of each list. Rarely worth changing |
| candidateSections | 12 (8 in the bge tiers) | Sections passed to the reranker; bounds rerank time. Rarely worth changing |
| sectionCapChars | 0 (twice chunkMax) | Longest section text given to the reranker and the model. Rarely worth changing |
| sectionCount | strict 2, balanced 3, broad 5 (presets since 2026-10-31: 3, 5, 6) | Most sections the model reads, per answer scope. Tuned in phase 2 |
| rerankFloor | strict 0.5, balanced 0.1, broad 0.01 | Lowest rerank score a section needs, per scope; with no section above it the model is not asked and the page shows the nearest sections. Tuned in phase 2 |
| vectorFloor | strict 0, balanced 0, broad 0 (presets since 2026-10-31: 0.6, 0.55, 0.5) | With rerankerModel none: lowest vector similarity a section's best sub-chunk needs, per scope. A section found by the keyword index alone has no similarity and passes only 0. bge-m3 scores through upstream sit between about 0.3 and 0.8; an unrelated question tops out near 0.39 on the owner's first corpus. The stage 1 sweep and --try floor= set this floor when the reranker is off |
| contextBudgetTokens | 0 (context length minus 1536) | Tokens for the numbered sources; whole sections are kept, the longest is trimmed when they do not fit |
| promptVariant | default | default; strict (every sentence must cite, no background knowledge, shortest answer); or complete (name every condition, exception, step and figure, in the sources' own terms, names and numbers; round 5, not kept) |
| answerMode | single | single: one model call over the selected sections. quoted: an extraction call over the top extractSections sections (table-of-contents sections left out) returns verbatim excerpts, code keeps those found in the section text, and a composition call answers from them only (docs/app.md, Answer pipeline) |
| extractSections | 6 | quoted mode: sections sent to the extraction call (N); bounded by candidateSections |
| verifyCitations | false | single mode: check every sentence against the source it cites by content-token overlap (0.5), move it to a better source or mark it unsupported; the cards show what stays cited (docs/app.md, Answer pipeline) |
| paragraphSelection | false | send a selected section longer than twice chunkMax as its 3 paragraphs closest to the question (embedding cosine plus keyword hits) with one neighbour each; paragraphs embedded when the pipeline is built, stored in <out>/paragraphs |
| verdictLine | false | the reply starts with a line FOUND or NOT_FOUND, which code reads for the not-found state instead of the NOT_IN_SOURCES marker |
| documentAffinity | false | a question naming a file (its name, cover title, or a type word such as Policy or Template that only it has; src/main/browse/identifiers.ts) multiplies the fused score of that file's sections by 1.5; naming exactly one file restricts citation verification to its sections; source headers carry file name and type and flag same-title sections of different files; same-title sources are chosen by overlap, never order; naming two or more files selects 6 sections (AFFINITY_MULTI_SECTIONS) instead of the scope's count. Results column affinity lists the files named |
| enumerateWhenAsked | false | a set question (a count before a plural noun, or what are the, list, each, all, components, steps, conditions, requirements, activities, elements, factors, or their Chinese equivalents) gets one more rule: count the items in the cited sources and give every one with its citation |
| enumerateFollowUp | false | with enumerateWhenAsked: when the question states a count and the answer enumerates fewer items (list lines, else inline (1) markers, else cited sentences), one follow-up call with the same sources asks for the missing items; results column follow_up |
| noSummarizing | false | one rule on every question in place of the enumerateWhenAsked set rule: do not summarize, merge or group what the sources say; state each listed item separately with its citation; give every member of a set (round 9a, not kept) |
| decomposeQuestions | false | split a question on explicit structure only (asks joined by and, as well as or a comma list, each starting with a question word, after a lead-in; or Compare A and B: ask), run the whole pipeline per part, merge the answers under lead-ins with citations renumbered against the union of sources; each part's retrieval is cached by its own question; results column split (how, parts, time per part, parts not found) (round 9b, not kept) |
| dropUnsupportedHedges | false | after verifyCitations: delete a sentence marked unsupported that only says information is missing (not specified, not stated, not explicitly, not mentioned, not provided, no information and equivalents, also Chinese) when the answer keeps a supported sentence; never a supported sentence, never all; each deletion logged; the text then is the kept sentences; results column hedges_dropped (on in the presets) |
| cjkOverlap | false | with verifyCitations: a mainly Chinese, Japanese or Korean sentence (30 percent of its letters and digits) is measured by character pairs against the source, the spaces PDF text puts between characters closed up first, with its own threshold VERIFY_MIN_OVERLAP_CJK 0.3 (calibrated on the Chinese set, docs/plan.md round A1); English sentences keep content words and 0.5 |
| crossDocument | false | a question naming two or more files (file identifiers built at index time, src/main/browse/identifiers.ts namedFileGroups: file names, cover titles, type words, Chinese titles from the file name; a name that two formats of one document share counts once for both) gets three parts, crossDocumentParts: quota (each named file's top 3 sections of the fused list, CROSS_DOCUMENT_QUOTA, plus the overall top sections up to the scope's count; the floor applies to the overall ones only), grouped (sources ordered by file under a line Sources from <file>:, and the rules to answer per file first, each part naming its file and citing only that file's sources, then compare), verify (a sentence that names a file is attributed only to that file's sources). A question naming one file is unchanged. Results column affinity lists the files named |
| crossDocumentParts | ["quota", "grouped", "verify"] | the parts crossDocument applies; for measuring one part at a time |
| crossDocQuota | false | crossDocument's quota part alone (round A2a, on in the presets): a question naming two or more files gets each named file's top 3 fused sections in its selection, plus the overall top sections up to the scope's count; prompt and verification as without it. Results column affinity lists the files named |
| fileScopedQuota | false | With the quota (crossDocQuota or crossDocument's quota part): a named file's 3 quota sections come from retrieval inside the file, vector search and keyword search restricted to its sections and fused by RRF, instead of its best sections in the library-wide fused list (round C1). Upstream's vector search takes no file filter, so one search of FILE_SCOPED_VECTOR_POOL (2000) chunks is filtered to the named files; its LanceDB search is exact, so that is the restricted search while the library holds at most 2000 chunks. A quota section found only inside its file joins the end of the fused list. Changes the stage 1 cache key |
| scopedQuotaV2 | false | C1's search inside each named file (needs the quota, with or without fileScopedQuota) without the file's table-of-contents sections in either list (isContentsSection), 5 quota sections per file (SCOPED_V2_QUOTA), and at most 8 sections (SCOPED_V2_MAX_SECTIONS) for a question naming two or more files, the files' quota sections taken in turn (round C3, on in the presets). Changes the stage 1 cache key |
| keywordStemming | false | The keyword index (BM25 in src/main/browse/rank.ts) and the question's keyword terms match English words by their Porter stem, as whole words: every run of ASCII letters becomes its marked stem on both sides (src/main/browse/stem.ts), so procurement planning meets Procurement Plan at procur plan, while plan no longer matches inside planet. Chinese text and terms are unchanged. The stemmed copy of each section is built in memory from the browse index on first use, so no file is indexed again. Terms keep their written form for everything after retrieval. Measured in round S1 and not kept (tuning cited -12; docs/plan.md), off on every tier. Changes the stage 1 cache key |
| perFileSubquery | false | With the in-file search of fileScopedQuota or scopedQuotaV2 (and the quota): a question naming two or more files is cut into clauses (sentences; inside a sentence at a semicolon, a colon, a comma before and, but, while or whereas, and the full-width ，：；), and each named file is searched inside with the clauses that name its file group alone (src/main/answer/subquery.ts, namedFileGroups); a clause naming two files, such as the lead-in Compare A and B, belongs to neither, and a file without a clause uses the whole question. One wide vector search and one keyword ranking per distinct query. The global candidates, the selection, the single model call and verification are unchanged. Measured in round X1 and not kept (no gain on any set; docs/plan.md), off on every tier. Changes the stage 1 cache key |
| headingPathBonus | false | In fusion (src/main/answer/fusion.ts, heading-bonus.ts), a section of the fused list whose heading path holds one of the question's keyword terms gets a fixed bonus of 0.5/(rrfK+1) (HEADING_BONUS_SHARE of a rank-1 RRF score, 0.0082 at k 60), once however many terms match. English terms match by Porter stem as whole words (procurement planning meets Procurement Plan), Chinese n-grams anywhere in the path, spaces ignored. Cap: a section found by one list scores at most 1.6/(k+1) with the bonus and the multi-hit tie-breaker, less than a section both lists rank in their top 16; a section in neither list gets nothing. Applies to every question, in the library-wide fusion and in the in-file search of scopedQuotaV2 (with the terms of that file's query). Measured in round X2 and kept: on in every preset. Changes the stage 1 cache key |
| namedFileQuota8 | false | With scopedQuotaV2, for a question naming two or more files only: 8 quota sections per file (NAMED_FILE_QUOTA) and at most 10 sections (NAMED_FILE_MAX_SECTIONS), the files in turn, so two named files get 5 each. Measured in round X3 and not kept (cross-document cited -20 points), off on every tier. Changes the stage 1 cache key |
| sourceFileNames | false | Each source header in the prompt reads [n] display name (file name) > heading path; the display name comes from the file name (displayName in src/main/browse/identifiers.ts: sequence number and extension dropped, derived-copy markers 网页正文, 衍生, 副本, copy, draft dropped, years and version markers kept, underscores as spaces). Prompt only: retrieval, selection, verification and source cards unchanged, so the stage 1 cache key does not change. Measured in round N1, not kept, off on every tier |
| questionFileNames | false | In the question the model reads, an indexed file name written with its extension (in backticks or not, on word boundaries) becomes its display name; the retrieval query is the question as asked (rewriteFileNames in src/main/browse/identifiers.ts). Measured in round N2 with sourceDisplayNames, not kept, off. Does not change the stage 1 cache key |
| sourceDisplayNames | false | Each source header reads [n] display name > heading path (no file name). Prompt only. Round N2, not kept, off |
| verifyStripNames | false | Before citation verification scores a sentence, whole display names (and their Chinese 《…》 forms, also without a trailing year or version) and backticked file names are taken out of the copy it scores; the sentence shown is unchanged (src/main/answer/file-names.ts). Never single words. Round N2b, not kept, off |
| dropAnswerFileNames | false | Backticked file names are deleted from the answer text before verification; display names stay. The streamed text is not changed, only the final result. Round N2b, not kept, off |
| judgeRerank | false | With scopedQuotaV2 and the quota, for a question naming two or more files only: each named file's first 15 sections (JUDGE_WINDOW) of its in-file list, searched with the file's own clause as perFileSubquery does (whether that switch is on or not), are scored 0 to 3 by the chat model, one sequential call each (src/main/answer/judge.ts: prompt fixed in code; the question as asked, the heading path and the matched sub-chunks only; temperature 0, thinking off, seed 42, num_predict 8, the answer call's num_ctx), and reordered by score (fused rank breaks ties; a reply that is not one digit is a missing score, logged, and keeps its fused position) before the quota of 5 is taken. results.csv gains judge_ms (all judge calls of the question) and judge_json (per file its query and every candidate's fused rank, judged rank, score, failure, time and text length). With --answer the harness loads the chat model before stage 1, so the first judged question does not carry the load time. Round B, not kept (cited_without_key rose on Chinese Q64), off; it costs a median 50 s per judged question. Changes the stage 1 cache key, with the chat model's name |
| ruleEchoRefusal | false | A reply sentence at least 0.8 of whose content words (the marker counting as one) occur in the not-found rule's text is a rule echo (rule-echo.ts): a reply of nothing else is a refusal (not-found path, nearest sections, no cards); otherwise the echo sentences are removed and the rest verified. Round V1, on in every preset |
| verifyStripQuestion | false | Verification scores a sentence on its content tokens that are not in the question as asked or sent, unless fewer than three distinct ones remain; then on all of them. Round V2, on in every preset (holdout H06's [2] restored; Chinese Q17 drops a citation of the 12 PDF's table row, which names the two fields but holds neither value) |
| verifyStripMin | 3 | verifyStripQuestion's guard: with fewer distinct content tokens than this left after stripping, the sentence is scored on all of them. Round P1 F3 measured 5 and did not keep it (check Q40's wrong sentence cited again, holdout H06's [2] lost again); 3 in every preset |
| leadInExempt | false | An uncited sentence ending with : or ： whose next sentence with words (a list marker alone is skipped) carries a written citation is a structural lead-in: neither cited nor marked unsupported, no attribution credit. Round P1 F1, on in every preset (Chinese Q18 and Q20, cross-document Q56, holdout H01's two lead-ins lose their markers) |
| duplicateTextTiers | false | With duplicateTextAttribution, of a cited section and its same-text sections: a. the one document the sentence names by display name (Chinese 《》 forms included; a format label is part of the name, also after the 》), b. else the one document the question names, or, when the sections come from files that differ only in format and the question's format words (a fixed list in duplicates.ts FORMAT_WORDS: Word, docx, Word版本, PDF, PDF版本, Excel, xlsx and similar) name exactly one format, that file; c. else all of them. Round D4b, the format part from round P2; on in every preset from P2 (Chinese Q02 shows only the Word card; no other row of any set changes) |
| displayFormatSuffix | false | Files of one library that give the same display name and differ in format each get a format label after the name: PDF版, Word版 after a Chinese name, (PDF), (Word) after another, other formats by extension in capitals (XLSX版, (XLSX)); files of one format with the same name keep it. Used wherever the display name is: source headers, the question as sent, source cards, the identical-text tiers (identifiers.ts libraryDisplayNames). Round P2, measured and off: on the two corpora only Chinese 04 and 13 (必须招标的工程项目规定) change, and the changed headers move Chinese cross-document Q64's reply to cite 13 第四条, a card without a key element (cited_without_key 1 to 2 on the set) |
| verifyStemEnglish | false | Citation verification compares English content words by their Porter stems on both sides (sentence and source) and in the question words it strips; numbers and Chinese pairs unchanged; retrieval and the keyword index untouched. Round P3, on in every preset (the five class B sentences of round P1 cited; no C or D marker lost) |

### Indexing switches

Each changes the section records, so a run with a switch on splits, names and embeds the corpus again (the switch and its revision are part of the split key, src/main/sections/types.ts INDEXING_REVISION; bump the revision whenever a change to a switch's code changes its chunks, or a later run reuses the earlier documents and vectors under the same names). Measured in rounds I1 to I3 (docs/plan.md, Indexing rounds).

| Switch | Effect |
| --- | --- |
| structuredTables | Tables kept as rows (src/main/sections/tables.ts): PDF tables from text positions (columns from gaps that run through the rows, rows from the column with the most separate cells), Word tables, spreadsheet sheets. With a header row each row is one line Header: value \| Header: value in a section of its own, titled by the caption above the table or the section it stands in, cut only between rows, with the caption and header line repeated in every chunk; text after the table goes on in <title> (continued). A table without a header stays in its section as row lines. Tables that continue over a page break are joined |
| cjkHeadings | Mainly Chinese documents only (30 percent CJK or more; src/main/sections/cjk.ts): 第X章, 第X节, 第X条, 一、, （一）, 1. 1.1 1.1.1 at line start as headings next to larger fonts, articles split from their first sentence, wrapped titles joined, page numbers and running headers removed, contents pages dropped, letter-spaced titles closed up. Word and plain text without heading styles get the numbered headings too |
| ocrUpscale | Page images scaled to about 300 dpi and at least 2400 px wide (at most 4 times, gray, bilinear) before the collector's OCR; cached apart from plain OCR. The OCR log line gives the time per image |

When a switch moves or renames sections, the answer key's expected sections have to follow the facts. The rounds remapped them mechanically: for each question, the sections of the same file that hold the literal key elements of the old expected section (a labelled table row counts when all words of the element are on one of its lines), fewest sections first, the old title and the old pages preferred on a tie; a question whose old section still holds them all keeps its key.

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
| ollamaPort | 0 | Managed mode: port of an Ollama already running (11434 for the Ollama app on the Mac), used instead of starting one; 0 starts one |
| scope | balanced | Answer scope of the pipeline run |
| answer | the defaults above | Answer parameters (table above) |
| rerankerDir | .eval-data/models/reranker | Reranker files; fetched here when missing |
| indexing | all off | Indexing switches, the indexing block of config/presets.json: structuredTables, cjkHeadings, ocrUpscale (below). Set one with --set indexing.structuredTables=true |
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
- expected_section: the section title exactly as it appears in the document, including its numbering (2.1 Lost devices, 3 提交期限). For a spreadsheet it is the sheet name. Several sections are separated by semicolons; two sections that both count as the expected one are written A | B (4.2 交货前检验 | 4.1 监造), and citing either is a hit; a section of another file that counts as well is written A | file :: B (Chinese Q17: ... | 14_台式计算机采购指标摘录_衍生.xlsx :: 采购指标摘录); for section_listing list every section a good answer should name. Case, full-width characters and extra spaces are ignored when matching. A semicolon that is part of a title is written \; (STATES GO,RNM\;:: (page 7)).
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
- section_listing: asks which sections cover a topic; the expected result is the list of sections, not a synthesized answer. In the app the correct output is the no-answer state with the closest sections listed. That list has no rerank floor: it is the best reranked candidates, up to 8, whatever their scores. Sections that answer a listing question often score low (0.02 to 0.08 with the bge rerankers on the fixtures), so a floor that keeps them out of the model's sources is expected, not a loss.

## Metrics

Computed by the harness for pipeline runs (stage 2) and by eval:score for every run, per question and per configuration and category:

- Target section hit: every expected section is among the cited sections (stage 2) or among the selected sections (stage 1). A section matches when its file is the expected file and its path ends with expected_section_path (or its title equals expected_section). Not counted for absent questions or questions without an expected section.
- Key element coverage: the share of key_elements present in the answer text, case and whitespace insensitive, counted only over the key elements that appear word for word (same normalization) in the expected sections' text; the others are paraphrases no quoting answer can contain. Before stage 2 the harness prints the key elements without a literal match per question and stores them in run.json (keyElementsWithoutLiteralMatch). A not-found answer covers nothing. Not counted for questions without key_elements or without a literal one.
- Attribution accuracy: checks the citations against what the answer says. The stated elements are the key elements found in the answer text. From round D1 (2026-11-05, docs/plan.md) true when the answer states at least one, every stated element is in a cited section, and every cited section supports the sentence that cites it: the sentence reached the citation verification threshold against that section (the score each kept citation had is recorded per sentence in claims_json; a sentence verification did not score, too short or verification off, is not held to it). The earlier requirement that every cited section contain a stated element (since 2026-10-31) is reported beside it: attribution_strict is the old definition and cited_without_key counts the cited sections that hold none. True also for a refusal (the not-found marker, with or without the sections it says it checked) to an absent question. An answer that states no key element, cites nothing, a refusal to an answerable question, and any non-refusal to an absent question are false. eval:score, which has no per-sentence scores, checks only the elements.

  Blind spot of the definition of round D1: an extra citation to a section that shares vocabulary with the correct one passes, as long as the stated facts are in another cited section. The extra section only has to reach the verification threshold by token overlap; nothing requires it to hold the fact the sentence states. cited_without_key is the count that shows these citations, so it is reported beside attribution and gated per question in docs/plan.md (round rules from round D4b on).

  Hand check of the five questions that went from fail to pass with the new definition (owner, 2026-11-05; evidence printed from the D1 run folders, S0 replies, ~/AskFiles-eval/d1-fail-to-pass-evidence.md):
  - Q05 (tuning): wrong pass. The sentence with the Sustainability row (10%, score 1, weighted 10) cites Illustrative Scoring Example 2 (overlap 0.57, threshold 0.5), which holds the 0 to 4 and percentage scales but not the row; the row is in the other cited section, Bid/Proposal Example.
  - Q17 (Chinese): borderline. The sentence with ≥2MB and ≥2666MT/s cites the xlsx extract (holds both) and the 2023 standard's table (overlap 0.45, threshold 0.3), which names the two fields (末级缓存容量, 内存的最高速率) but not the values. From round V2 (verifyStripQuestion) that table citation is dropped (0.20 on the words not in the question), so Q17 cites the xlsx extract only; recorded as a borderline case turned correct, and its key accepts the xlsx extract as well since 2026-11-06 (docs/plan.md).
  - Q61 (Chinese cross-document): identical-text sections. 2.4 招标文件的异议 is the same text in the equipment and the materials template; the citations stand for both (see duplicateTextAttribution, round D4).
  - Q63 (Chinese cross-document): wrong pass. The fact-free lead-in (...如下：) cites the 印发 notice of the 暂行办法 (overlap 0.41, threshold 0.3), which holds none of the disclosure items.
  - Q64 (Chinese cross-document): true support. The closing sentence on what each file addresses cites 第四条 of 必须招标的工程项目规定 (overlap 0.62), which states that the scope of infrastructure projects is set separately.
- Duplicate documents share credit (since round A3b): a cited section of another file with the same document name as the expected file (the name without its number prefix and extension: 13_必须招标的工程项目规定.docx for 04_必须招标的工程项目规定.pdf) counts as the expected section for right section cited when its text holds every key element of the question.
- Section listing questions are measured on the listed sections when the answer is the no-answer state: target section hit when they include every expected section, key element coverage over their section paths, attribution correct when the target is listed. In stage 1 they are measured on the nearest list (best reranked candidates, no floor, up to 8) for every count and floor of the sweep. For upstream runs the fallback list plays this part.
- Latency: median first token and total time. For stage 2, total is the cached retrieval's time plus the model call (both calls in quoted mode).
- False refusals: answerable questions answered with the not-found state, over answerable questions. False answers: absent questions given an answer, over absent questions. They replace the single correct-abstention figure (docs/plan.md, Acceptance and stopping rules).
- Unsupported sentences per answer: sentences with no valid citation; in quoted mode also those citing a source with no verified excerpt.
- Matching (key elements, passages): NFKC, lower case, every dash to -, curly quotes straight, a word broken across a line joined, the percent sign dropped from the first number of a range (0%-15% is 0-15%), whitespace removed. Attribution leaves out stated elements the question itself contains.
- A question whose notes contain [unsupported: reason] (a spreadsheet formula the split does not keep) is run and written to results.csv but left out of the sweep and every summary; the summary counts it as excluded.

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

Rescoring a recorded pipeline run without the model (round D1): every answer goes through the answer stage again with the model's recorded reply in place of the chat call, on the run's cached retrieval and browse index, so a change to verification or to the metrics is measured on the same replies. The reply is raw_answer, or for runs before it was recorded the answer column (the reply as written unless hedges were dropped; then the dropped hedges are put back). Rescoring S0, N1 and N2a with their own settings reproduces every recorded outcome. Timings are the recorded ones; sentenceMatch embeds through Ollama.

```
npm run eval:rescore -- eval-runs/<run> --out eval-runs/<new folder> [--set restatementExempt=true ...]
```

## Recording a run in the plan

1. Score every row of both corpora for the configuration.
2. Run eval:score with the S and L run folders of that configuration.
3. Paste the Markdown table into docs/plan.md under Phase 2, below the pass criteria, under a heading with the date, the RAM tier, the Mac model and RAM, the git commit and UPSTREAM_VERSION from run.json, and the indexing time from run.json (library.embedMs for a run that embedded the corpus).
4. Note app memory from Activity Monitor during the run (task 2.5); the harness does not measure it.
5. Keep the run folders outside the repository.

## Limits

- Word and Markdown files have no page numbers; their page fields are 0 and the search page shows no page.
- OCR text has no heading structure: a scanned PDF becomes one section per page titled Page N; OCRed pages of a PDF with a text layer keep the sections its bookmarks give.
- PDF sections come from bookmarks, else from font size, else one per page. A bookmark that points well above its heading can pull the line above it into the next section.
- The harness measures latency on the machine it runs on; the Electron app adds nothing to it but window rendering. The reranker runs in the harness's Node process here and in the app's main process there.
- The stage 1 cache is keyed by question text and index hash only: after changing the pipeline code itself, delete .eval-data/retrieval-cache.
- With rerankerBypassCjk on, a library that mixes Chinese and English sections bypasses the reranker for most questions, and the floor columns of the sweep then show the same numbers.
- Smoke runs in the cloud container use qwen3:0.6b and all-minilm on CPU and only test the pipeline; their answers say nothing about quality. Their output is in docs/eval-smoke: eval-s and eval-l through the upstream route (Session G), pipeline-s and pipeline-l through the answer pipeline, stages 1 and 2 (Session L).

## Seeded runs

The config key seed (default -1, off) sends options.seed with every answer-pipeline chat call (`--set seed=42`). Run Ollama with OLLAMA_NUM_PARALLEL=1 for it, since batched requests are not deterministic under a seed (on macOS: `launchctl setenv OLLAMA_NUM_PARALLEL 1` before starting the Ollama app; its server log prints the value). Three seeded runs of the kept configuration gave identical answers on every question (docs/plan.md, round S0), so every round from S0 on is measured with one seeded run per configuration.
