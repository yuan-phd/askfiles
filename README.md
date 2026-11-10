# AskFiles

Ask questions about your own documents, on your own computer.

AskFiles is a desktop app for macOS and Windows. You point it at your files, ask a question in plain English or Chinese, and get an answer with numbered sources you can open and check. The documents, the questions and the answers never leave your machine: the language model, the search index and the text recognition all run locally, and after the first setup the app works without an internet connection.

> **Status: test builds.** AskFiles is in early testing with invited users. Expect rough edges, and please report what you find.

## What it does

**Ask**
- Answers questions from your documents with numbered citations, each linked to a source card showing the file, the section and the page.
- Checks every sentence of the answer against the sources by the share of its words found in the passage it cites. A citation that does not hold moves to a source that supports the sentence; a sentence no source supports loses its citation and is marked with †, so you know which parts to verify yourself.
- Says so when your documents do not contain the answer, and lists the closest sections instead of making one up.
- Handles questions that compare two documents when you name them, by searching each document separately (slower, about a minute longer).

**Browse**
- **Library**: every document with its outline, its type and a one-sentence summary (16 GB of memory or more); open a document to read its full text.
- **Compare**: the same heading across several documents, side by side.
- **Find**: word search across your documents; every word must appear in the section, and words in quotes are found as a phrase.
- **Graph**: how your documents relate, for example through shared headings, references and versions (the links drawn depend on the kind of library), with Folders and Local views for large libraries.

**Your files**
- PDF (including scanned pages, with built-in English and simplified Chinese text recognition), Word (.docx), Excel (.xlsx, .xlsm, .xls), CSV, Markdown and plain text.
- Several libraries, each built from linked folders and individually added files. Changes to your files are picked up automatically.
- Optional summaries of every section (16 GB of memory or more), and an export of the library as Markdown notes that Obsidian can open.

## Requirements

| Memory | What you get | First download |
|---|---|---|
| 32 GB or more | Ask, Browse and Find, with the Qwen3 14B model | about 10.4 GB |
| 16 GB | Ask, Browse and Find, with a smaller version of the same model | about 8.5 GB |
| 8 GB | Browse and Find only | about 1.2 GB |

- macOS 14 (Sonoma) or later on Apple Silicon (M1 or later), or Windows 10/11 on x64.
- At least 15 GB of free disk space.
- An internet connection for the first start only, to download the models.

## Install

Download the latest build from the [Releases page](https://github.com/yuan-phd/askfiles/releases): the `.dmg` for macOS or the setup `.exe` for Windows.

The builds are not yet code-signed, so your system will warn you the first time:

- **macOS**: if macOS says it cannot verify the app, open System Settings, Privacy & Security, and click **Open Anyway**. If that does not work, run this in Terminal and open the app again:
  ```
  xattr -dr com.apple.quarantine "/Applications/AskFiles Test.app"
  ```
  (For a release build the app is called `AskFiles.app`.) Work computers managed by an organisation may block unsigned apps entirely.
- **Windows**: if SmartScreen appears, click **More info**, then **Run anyway**.

On first start, AskFiles checks your computer's memory, downloads the matching models, and opens. Add a folder or some files, wait for indexing to finish, and ask.

## How accurate is it?

Measured on our own test documents (one English and one Chinese set of public procurement regulations and guidance); results on other documents may differ.

| Question type | Result |
|---|---|
| About one document, answer complete (hand graded) | English 32 of 36, Chinese 19 of 20 |
| Comparing two documents named in the question | right sources cited 9 of 10, answer complete 8 of 10 |
| Comparing two documents described rather than named | right sources cited 2 of 8, answer complete 3 of 8 |
| No answer in the documents | said it could not find it 21 of 21, made nothing up |

Typical time on a 64 GB Mac: about 14 seconds per question in English and 7 in Chinese; questions comparing two named documents take about 76 seconds. Machines with less memory are slower.

## Known limits

- Arithmetic on tables can be wrong. Check calculated figures against the source.
- Comparison questions work best when you name both documents; asking about each document separately is more reliable.
- Poor-quality scans may be misread.
- Spreadsheet formulas are not read, only their values.
- Sentences marked † may be accurate summaries or may be wrong; always check them against the source cards.

## How it works

AskFiles is an [Electron](https://www.electronjs.org/) app that runs everything locally:

- [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) as the document store, embedding and vector search backend, used headless with local-only patches.
- [Ollama](https://ollama.com/) to run [Qwen3](https://github.com/QwenLM/Qwen3) for answers and [bge-m3](https://huggingface.co/BAAI/bge-m3) for embeddings, with its cloud features turned off.
- Hybrid search (vector and keyword), section-level selection, and a citation check that runs on every answer as soon as it is complete.
- Tesseract for text recognition of scanned pages.

Third-party licenses are listed in [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES). The AnythingLLM core in [upstream/](upstream/) is MIT-licensed ([upstream/LICENSE](upstream/LICENSE)); AskFiles' own code is licensed under the Apache License 2.0 (see [License](#license)).

## Documentation

- [User guide](docs/user-guide.md)
- [How the app is built](docs/app.md)
- [Packaging](docs/packaging.md) and [Windows](docs/windows.md)
- [Evaluation](docs/eval.md)

## Feedback

Please open an [issue](https://github.com/yuan-phd/askfiles/issues) with what you asked, what you expected, and what happened. Do not paste content from confidential documents.

## License

Copyright 2026 yuan-phd.

AskFiles is licensed under the [Apache License 2.0](LICENSE). You may use, modify, distribute and sell it, provided you keep the copyright and license notices (including [NOTICE](NOTICE)) and state significant changes you make.

The AnythingLLM core in [upstream/](upstream/) is MIT-licensed ([upstream/LICENSE](upstream/LICENSE)). Third-party components keep their own licenses, listed in [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).

Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md).
