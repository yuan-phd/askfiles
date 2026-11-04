# Summaries

Session N. Code in src/main/summaries. Each summary is one sentence written by the library's chat model. It is checked against the text it was made from, the way an Ask sentence is checked, and a sentence the text does not support is dropped and never shown. This changes the plan's "No compiled wiki" decision (owner decision 2026-11-04, docs/plan.md). Everything else on the Browse pages still comes from the documents.

## The two kinds

| | Document summary | Section summary |
| --- | --- | --- |
| Length | One sentence of at most 40 English words; for a Chinese document up to two sentences and 100 Chinese characters in all | One sentence of at most 25 English words or 60 Chinese characters |
| Made from | The title, the top-level outline (up to 30 entries) and the first section with text (up to 3000 characters). For a Chinese document: the outline down to three levels (up to 30 titles, so articles and numbered clauses count) and the text of the first sections in order, 3000 characters in all | The document title, the section path and the section text (up to 4000 characters) |
| Cited to | That first section | The section |
| When | Automatically, after the document is indexed | Off by default. Two ways to turn it on: Summarize each section on the Document page (that document only, with an estimate in minutes), or Summarize every section in the library menu (every document, and every document added later) |
| Shown on | The Library page (under the name), the Document page (under the title, with a link to the section it cites) and the overview node's tooltip | The Document page, above each section's text |

Both section controls have the same tooltip: Uses the model on this computer. Ask is slower while it runs. You can pause it in the top bar.

## Prompt and checks

src/main/summaries/text.ts. The system prompt asks for one sentence that says what the document (or section) is and covers. It must use only facts in the given text, with no preamble, label, quotes, list or citation marks. The sentence is in Chinese with the Chinese cap when the source is mainly Chinese, otherwise in English with the word cap. A Chinese document summary is asked for in exactly two sentences, 60 to 100 characters: the first says what the document is, with its issuer and date when the text gives them; the second names three to five of its main topics or sections. A Chinese section summary is asked for in 30 to 60 characters and must state the concrete rule or content (who must do what, amounts, time limits, conditions), not the name of its topic. The lower bounds are asked for, not enforced; the caps are. Prompt version 3 for Chinese documents (SUMMARY_PROMPT_VERSION_CJK).

The reply is cleaned: thinking, citation marks, a leading label (Summary:, 摘要：), list marks and quotes are taken off, and only the first sentence is kept. Then it is checked in two ways:

- **Cap.** A reply over the cap gets one more try asking for a shorter sentence. A second miss is dropped (too-long).
- **Sentences.** English summaries and Chinese section summaries keep the first sentence; a Chinese document summary keeps up to two (split on 。！？ only, so 3.5% stays whole).
- **Support.** src/main/answer/verify.ts verifyClaims runs with the source as the only passage and cjkOverlap on. The threshold is the Ask one: half the sentence's content words, or 0.3 of its character pairs for Chinese. Below that the sentence is dropped (unsupported). Each sentence of a two-sentence Chinese summary is checked on its own; an unsupported one is left out and the summary is dropped only when neither is supported.

A dropped summary is stored with its reason and not asked for again until its source, the model or the prompt version changes. Its document shows no summary.

Measured on the owner's corpora with qwen3 14B Q3_K_M (the 16 GB tier's model, local Ollama on the M1 Max): a document summary took 2 to 15 s, a section summary 2.5 to 7 s. Of 5 document summaries, 4 were kept and 1 was dropped as unsupported. The Value for Money Guidance summary claimed "effective purchasing practices", which its first pages do not say. Of 5 section summaries, 1 was dropped as too long.

## Queue

src/main/summaries/queue.ts runs one job at a time, at the lowest priority:

1. document summaries;
2. the section summaries the user asked for on a Document page;
3. the library switch's section summaries.

It pauses while any of these holds:

- the current library is indexing (watcher state starting or working, or files pending);
- a question is being answered (AnswerService onBusy);
- the user pressed Pause;
- the tier makes no summaries.

A pause that starts while a job runs aborts the job, which goes back to the front of the queue, so Ask never waits for a summary. Work starts again only after the gates have been open for 5 s (IDLE_MS). Between jobs there is no wait.

The top bar shows Summaries n of m, with Pause and Resume, while there is work. n and m count the current batch, which ends when the queue empties. A pause shows its reason: paused, waiting for the answer. While the library indexes it reads Summaries paused until indexing finishes (n of m done): the queue waits for the whole batch of files, not per file, and so does the Markdown export (writing it reads the overview graph, which would otherwise be rebuilt after every file).

Summaries use the Ask model in server/.env (OLLAMA_MODEL_PREF) and the Settings context length, so Ollama keeps one chat model loaded. A tier's preset can turn on summariesFasterModel: summaries then use the Faster tier's model (Settings, Answer model: the model of the tier below) when this Mac has it installed. It is never pulled for summaries, a pinned file whose sha256 does not match is not used, and it is looked up when the library opens and after a model is pulled or removed or the answer model changes; a change of model marks every summary stale. It is off on every tier (owner decision 2026-11-04): on the owner's Mac (M1 Max, 32 GB tier) the Faster model, qwen3 14B Q3_K_M, was slower than the Ask model's q4_K_M (Batches below) and kept a second chat model in memory.

- **The 8 GB tier** (Ask off, chatModel null) makes no summaries. The pages show no summary and no pending state, and the library switch is hidden.
- **A changed file** gets its document summary made again, and its section summaries only for sections whose text changed. Summaries of sections the file no longer has are removed.
- **A removed file** loses its summaries, its export note and its node.
- **Version key.** Every stored summary carries `<model tag>|p<prompt version>`: SUMMARY_PROMPT_VERSION (1) for English documents, SUMMARY_PROMPT_VERSION_CJK (2) for documents whose summary source is mainly Chinese. A new chat model (Settings, Answer model) or a prompt change marks the summaries stale, and they are queued again. The Chinese version moved to 2 with the Chinese caps of 2026-11-04 (owner request: 100 characters in up to two sentences for a document, 60 for a section), so only Chinese summaries were made again. With version 3 (two sentences asked for, the deeper source) the dev library's two Chinese documents got two verified sentences each, 61 and 59 Chinese characters; with version 2 they had one sentence of 35 and 38, and with the version 3 prompt on the old source 04's second sentence was dropped as unsupported, since that source held only the decree line.

### Batches

Section summaries of one document go to the model up to 5 at a time (BATCH_MAX_SECTIONS), as long as their text stays under about 4000 tokens (BATCH_MAX_TOKENS; one token per Chinese character, one per four other characters). The prompt numbers the sections and asks for one line per section starting with its number (sectionBatchPrompt); the reply is read back by number (parseBatchReply). Verification is unchanged: each sentence is cleaned, capped and checked against its own section alone, exactly as a single summary. A section the reply skips or runs over the cap for is asked again on its own, with the shorter retry, so a batch never keeps less than single calls would. In the queue each section stays its own job, so Summaries n of m still counts sections, and a pause puts the whole batch back at the front.

Measured on 2026-11-04 on the owner's Mac over 20 sections of the Procurement Regulations (with more than 200 characters of text):

| Model | One section per call | Batched | Kept, one per call | Kept, batched |
| --- | --- | --- | --- | --- |
| qwen3 14B Q3_K_M (Faster) | 4.0 s per section | 4.1 s per section | 12 of 20 | 15 of 20 |
| qwen3 14B q4_K_M (Ask) | 3.9 s per section | 3.6 s per section | 13 of 20 | 16 of 20 |

Batching does not make a section much cheaper on this Mac: the time goes into reading each section's text and writing its sentence, which a batch does not reduce. It keeps more sentences (fewer run over the cap). No reply skipped a number.

The Document page's estimate is the number of sections without a current summary, times the average time per section of the last 20 section summaries (a batch counts its time divided by its size; 3.6 s until there are any, DEFAULT_MS_PER_SECTION, the Ask model's batched pace in the table), rounded up to whole minutes. The document with 254 sections that was estimated at 34 minutes at the old 8 s default now shows about 16 minutes.

## Storage

`<dataDir>/libraries/<id>/summaries/<document id>.json`, next to the library's index.json and browse/. Each file holds:

- the document summary and the section it cites;
- the section summaries by section index;
- whether the user asked for this document's sections.

Every summary keeps its text (or null), its status (ok, too-long, unsupported, empty, failed), the version key, a fingerprint of its source and the time. The document summary's fingerprint includes the file hash.

## Markdown export

src/main/summaries/export.ts writes `<dataDir>/libraries/<id>/export/`, a folder Obsidian opens as a vault. Open Markdown export in the library menu shows it in Finder. It holds:

- One note per document, named by the file name without its extension; two formats of one name get (pdf) and (docx). It has:
  - front matter with title, type, source (the original file's path) and summary, as JSON strings, which are valid YAML;
  - the summary;
  - the section summaries;
  - [[links]] under References and Referenced by to the documents it references and that reference it;
  - [[Headings/...]] links to its shared headings.
- Headings/: one note per heading found in two or more documents, with front matter (heading, documents) and a [[link]] and the section summary per document (No section summary yet. when there is none).

The export is rewritten 2 s after summaries or files change, and only files whose content changed are written. A manifest (.askfiles-export.json) lists what the export wrote, so stale notes are removed and the user's own notes in the folder are never touched.

## Ask during indexing

While the current library is indexing, the Ask page's question box and Search button are off, with one line: Reading new files, n left. They come back when indexing finishes. An answer during indexing would miss the files still being read, and the summary queue pauses at the same time. The line follows the top bar's indexing state (src/renderer/shared/topbar.js lockLine).
