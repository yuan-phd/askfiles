# Summaries

Session N. Code in src/main/summaries. Each summary is one sentence written by the library's chat model. It is checked against the text it was made from, the way an Ask sentence is checked, and a sentence the text does not support is dropped and never shown. This changes the plan's "No compiled wiki" decision (owner decision 2026-11-04, docs/plan.md). Everything else on the Browse pages still comes from the documents.

## The two kinds

| | Document summary | Section summary |
| --- | --- | --- |
| Length | At most 40 English words or 50 Chinese characters | At most 25 English words or 35 Chinese characters |
| Made from | The title, the top-level outline (up to 30 entries) and the first section with text (up to 3000 characters) | The document title, the section path and the section text (up to 4000 characters) |
| Cited to | That first section | The section |
| When | Automatically, after the document is indexed | Off by default. Two ways to turn it on: Summarize each section on the Document page (that document only, with an estimate in minutes), or Summarize every section in the library menu (every document, and every document added later) |
| Shown on | The Library page (under the name), the Document page (under the title, with a link to the section it cites) and the overview node's tooltip | The Document page, above each section's text |

Both section controls have the same tooltip: Uses the model on this computer. Ask is slower while it runs. You can pause it in the top bar.

## Prompt and checks

src/main/summaries/text.ts. The system prompt asks for one sentence that says what the document (or section) is and covers. It must use only facts in the given text, with no preamble, label, quotes, list or citation marks. The sentence is in Chinese with the Chinese cap when the source is mainly Chinese, otherwise in English with the word cap.

The reply is cleaned: thinking, citation marks, a leading label (Summary:, 摘要：), list marks and quotes are taken off, and only the first sentence is kept. Then it is checked in two ways:

- **Cap.** A reply over the cap gets one more try asking for a shorter sentence. A second miss is dropped (too-long).
- **Support.** src/main/answer/verify.ts verifyClaims runs with the source as the only passage and cjkOverlap on. The threshold is the Ask one: half the sentence's content words, or 0.3 of its character pairs for Chinese. Below that the sentence is dropped (unsupported).

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

The top bar shows Summaries n of m, with Pause and Resume, while there is work. n and m count the current batch, which ends when the queue empties. A pause shows its reason: paused, waiting for indexing, waiting for the answer.

Summaries use the same model and context length as Ask: the chat model in server/.env (OLLAMA_MODEL_PREF) and the Settings context length. That way Ollama keeps one model loaded and never loads a second one for summaries.

- **The 8 GB tier** (Ask off, chatModel null) makes no summaries. The pages show no summary and no pending state, and the library switch is hidden.
- **A changed file** gets its document summary made again, and its section summaries only for sections whose text changed. Summaries of sections the file no longer has are removed.
- **A removed file** loses its summaries, its export note and its node.
- **Version key.** Every stored summary carries `<model tag>|p<SUMMARY_PROMPT_VERSION>`. A new chat model (Settings, Answer model) or a prompt change marks every summary stale, and they are queued again.

The Document page's estimate is the number of sections without a current summary, times the average time of the last 20 summaries (8 s until there are any), rounded up to whole minutes.

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
