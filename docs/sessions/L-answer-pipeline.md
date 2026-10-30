# Session L: the answer pipeline moves into the shell

Executor: CLOUD for code and tests; evaluation on the owner's Mac
Dependencies: Sessions A to J merged on main. Runs in parallel with Session K, which owns the library model, the top bar, the browse pages, the splitter and the settings pages. Session L owns src/main/answer (new), the Ask page (src/renderer/search, renamed to src/renderer/ask in this session), the eval harness and the bridge calls they need. If the two sessions need the same file, L stops and says so in the PR.
Branch: whatever the session assigns
PR title: [Session L] Answer pipeline: hybrid retrieval, section reranking, numbered citations

## Why

Measured on a real corpus (owner's test, 2026-10-30, 10 questions): 2 pass, 4 partial, 4 fail. Three findings drive this session. First, the upstream chat route retrieves by vector only, so exact terms in a question (a tool name, a phrase like task teams) are missed although the keyword index finds them at once. Second, retrieval returns many topically similar passages instead of the few sections that prove the answer; enabling reranking improved this, section-level selection is the rest. Third, citations are written by the model, which attributed one file's text to another; pages and file names must come from metadata only.

Decision recorded in docs/plan.md by this session: the shell owns retrieval, prompt assembly and the model call. Upstream remains the document store, parser, OCR, embedder and vector database. Upstream code is not modified; its chat route is simply no longer used by the app.

## The pipeline (src/main/answer)

1. Candidates. Vector: call the upstream vector-search route for the current workspace with no score floor, top 30 sub-chunks, keeping scores and metadata. Keyword: extract from the question the rare terms, quoted phrases, numbers, codes and capitalized multiword names (for Chinese, character n-grams of 2 to 4 that are infrequent in the index) and query the shell's keyword index (src/main/browse, extended with a scoring query if needed) for sections containing them. Fuse both lists with reciprocal rank fusion.
2. Sections. Map every candidate sub-chunk to its section record; score sections by the fused scores of their chunks; take the top 12 sections. For each, assemble the section text from its sub-chunks in document order, capped at the chunk maximum times 2.
3. Rerank. Score question against each section with a cross-encoder. Start with the model upstream already uses (Xenova/ms-marco-MiniLM-L-6-v2 through @xenova/transformers, which is already in the tree) and evaluate a multilingual alternative (bge-reranker-v2-m3 or similar in ONNX) for Chinese; record sizes, speed on the CI Mac, and whether it can be shipped. The model runs in the shell process, never downloads at runtime, and is bundled through the packaging config (coordinate the electron-builder.yml change by adding lines only).
4. Select. Keep sections with rerank score above a floor, at most N sections within a token budget derived from the context length setting, whole sections preferred, longest trimmed last. N and the floor are mapped from Answer scope: Strict 2 sections and a high floor, Balanced 3 and medium, Broad 5 and low. Read Answer scope through the bridge from the settings store Session K adds; default Balanced when absent.
5. Prompt. System instructions: answer only from the numbered sources; cite as [n] after each claim; never state page numbers, file names or section names in the text; if the sources do not contain the answer, reply with a fixed marker. User message: the numbered sources, each with its section path and text, then the question. Thinking off through the Ollama option. Call the bundled Ollama chat endpoint directly with streaming.
6. Output. Stream the answer text to the page. Parse [n] citations as they arrive. Cards show only cited sections, in citation order, each with file name, full section path, PDF page and printed page label when present, and the passage. Uncited but selected sections appear under a collapsed heading Other sections considered. The fixed not-found marker renders as the existing nothing-found state with the top reranked sections listed. Any claim without a citation is shown with a muted marker so the reader can see it is unsupported.
7. Multi-turn: none. Every question is independent, as today.

## The Ask page

- Rename src/renderer/search to src/renderer/ask; update tests, docs and the smoke script. The top-bar label itself belongs to Session K.
- Switch the page from the upstream chat route to the new pipeline through a bridge call with streaming events. Keep the API client for library and document calls.
- Recent questions unchanged.

## Evaluation

1. Extend scripts/eval to run through the new pipeline (default) or the upstream chat route (flag) so both can be compared on the same questions.
2. questions.csv gains key_elements (semicolon separated phrases that a correct answer must contain) and expected_section_path. score.ts computes, per question and per category: target section hit (expected section among cited sections), key element coverage (fraction present in the answer text, case and whitespace insensitive), attribution accuracy (every cited section actually contains at least one key element, or the answer is a correct refusal), plus latency.
3. docs/eval.md documents the three metrics and how to write key_elements. Add the owner's ten-question shape as an example without their documents.
4. Smoke run in the container with the fixture corpora and the test models through the new pipeline.

## Tests and acceptance

- Unit tests: term extraction (English and Chinese), fusion, section grouping and text assembly, budget selection per scope, prompt assembly, citation parsing including a citation split across stream chunks, not-found handling, metadata-only card fields.
- Integration (real backend, test models): a question whose answer term appears only in one section is answered with that section cited; a question with no answer yields the not-found state; a Chinese question against the Chinese fixture cites a Chinese section.
- Playwright: Ask page streaming with citations and the Other sections group, with the bridge stub.
- Mac workflow green; the smoke job asks its question through the new pipeline and asserts a [1] citation in the answer.
- PR body: the reranker chosen and why, model sizes, timings on the CI Mac, the scope mapping table, and everything not verified.

## Rules

- Do not edit upstream/. No new patches expected.
- Do not touch the browse pages, the splitter, the watcher or the settings pages; Session K owns them. Read the section records as they are today; if K changes their shape before you merge, rebase and adapt.
- No runtime dependency beyond the reranker model files without a one-line reason.
- Watch the PR after opening it and fix mac runs until green.

## Added: tuning loop for the owner

The owner will tune by repeating set parameters, run, read results, change parameters. Make each loop take minutes, not hours.

1. Eval in two stages. Stage 1, retrieval only: for each question run candidates, fusion and reranking once, cache every stage's output on disk keyed by question and index hash, then sweep section count and rerank floor over a grid and report target-section hit rate per configuration without calling the model. Stage 2, answer: run the model only for the configurations the owner names, and compute key element coverage and attribution accuracy. The default eval command runs stage 1; a flag runs stage 2. Both print one table per run and write results.csv and run.json as today.
2. One parameter file. Every tunable value lives in scripts/eval/configs/*.json and in config/presets.json with the same names: vector top-k, keyword top-k, RRF k, candidate section count, section cap, section count per scope, rerank floor per scope, reranker model, context budget, temperature, system prompt variant. The eval command takes a config file and optional overrides on the command line (for example --set rerank_floor=0.35) so a loop never needs a file edit. docs/eval.md documents each parameter in one line with its default and its effect.
3. Developer debug panel on the Ask page, visible only with ASKFILES_DEVELOPER=1: for the last question, show both candidate lists with scores, the section fusion scores, the rerank scores, and which sections were selected; live controls for section count and rerank floor that apply to the next question without restart; a Save as eval case button that writes the question and the section the owner clicks as the expected section into the eval questions file.
4. Defaults: vector top-k, RRF k, candidate section count and the section cap are set generously and documented as rarely worth changing; section count, rerank floor and the scope mapping are the values phase 2 tunes.
