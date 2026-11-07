# AskFiles user guide

AskFiles finds answers in your own documents. Everything runs on your computer: your files and your questions never leave it.

## Adding documents

Click Add at the top right:

- **Add files** copies files into the library.
- **Add folder** links a folder. AskFiles watches it and reads new and changed files, but never changes the folder itself.

You can also drop files or folders anywhere on the window. AskFiles reads PDF, Word, Excel, CSV, Markdown and text files.

While AskFiles reads new files, the top bar says Indexing and how many are left.

## Libraries

A library is a set of documents you ask about together. All files is always there. To make another, open the library menu (the library name at the top) and type a name. Next to the name, choose what kind of documents it holds:

- **Legal and finance** (the usual choice): regulations, guidance, templates, contracts, records, data.
- **Team work**: meetings, reports, tickets, specs.
- **General**: books, articles, notes, reference works.

The kind only changes how documents are grouped and linked on the Graph page. You can change it later in the library menu, under Kind of documents. Nothing is read again.

## Asking

Type a question on the Ask page and press Enter. The answer cites its sources with numbers, and a card for each source shows the file, the section and the page. Click Read section to see the passage in the document, or Open file to open the original.

A sentence with an asterisk (*) after it is shown in a lighter colour. The line under the answer says: Starred sentences have no word-for-word support in the sources. They may be a summary or conclusion drawn from the sources, or they may be inaccurate. Check them against the source cards. For an answer in Chinese it says: 带星号的句子在来源中没有逐字对应的原文，可能是根据来源归纳的结论，也可能不准确，请对照来源卡片核实。

While AskFiles is reading new files, the question box is switched off and says Reading new files, and how many are left. It comes back as soon as they are read, so an answer never misses a file you just added.

## How accurate is it

These figures were measured on our own test documents: procurement regulations and guidance, one set in English and one in Chinese. Results on other documents may differ.

- **Questions about one document, answer complete** (checked by hand): English 32 of 36 (89 percent), Chinese 19 of 20 (95 percent). Most answers state everything the question asks for, without mistakes.
- **Comparing two documents, when the question names both files**: the right sources are cited in 9 of 10 (90 percent), and the answer is complete in 8 of 10 (80 percent). Naming both files lets AskFiles look in each one.
- **Comparing two documents, when the question describes them or names neither** (for example the 2024 directive, the guidance): the right sources are cited in 2 of 8 (25 percent), and the answer is complete in 3 of 8 (38 percent). The main reason is that AskFiles did not recognise which two documents were meant.
- **Questions with no answer in the documents**: AskFiles said it could not find the answer in 21 of 21 (100 percent), and made nothing up. When your documents do not hold the answer, it says so.
- **Time**: about 14 seconds per question in English and about 7 seconds in Chinese. A question that names two documents takes about 76 seconds in all, because AskFiles looks through each named document once more. This was measured on a Mac with 64 GB of memory; it is slower on computers with less memory.

## What it cannot do well

- **Arithmetic on tables can be wrong.** AskFiles may misread a cell or add up wrongly. Check numbers it works out against the table itself.
- **Comparing documents works best when you name both files.** Asking about each document in a question of its own is more reliable still.
- **Poor-quality scans may be misread.** Text recognised from a blurred or faint scan can be wrong or missing.
- **Spreadsheet formulas are not read**, only the values in the cells.
- **Starred sentences (*) have no word-for-word support** in the sources. Check them against the source cards.
- **On computers with 8 GB of memory, Ask is off.** Browse and Find, and the Graph, work there.
- **The first launch has to be allowed** in the system's security settings: on a Mac in System Settings, Privacy & Security (Open Anyway); on Windows in the SmartScreen window (More info, then Run anyway).

## Browsing

Click Browse at the top left to read your documents without asking anything:

- **Library**: every document, with its outline, its type and a one-sentence summary.
- **Compare**: the same heading across several files, shown side by side. A section that runs over several pages shows once, with all its text.
- **Find**: words and phrases in your documents.
- **Graph**: a map of the library (below).
- **Document**: the document you opened, with its outline on the left.

## Graph

Each dot is a document. Its colour shows its type, as the legend says, and bigger dots have more links. The lines show what documents have in common:

- **A solid line**: the two share headings. Click it to compare those sections side by side.
- **A dashed line**: one document mentions the other. Click it to read the place where it does.
- **A dotted line**: two versions or copies of one document, such as the 2024 and 2025 issues, or the PDF and Word copy.

Point at a dot to see the document's title, type and summary, and to light up the documents it links to. Click a dot to open the document. Type in the search box to find documents by name. Drag a dot to move it, and scroll to zoom.

Organic and Layered switch the arrangement. Layered puts each type in its own row.

## Types

AskFiles guesses each document's type from its name and its text, and shows it next to the document on the Library page with (detected) after it, for example Regulation (detected). If it guesses wrong, click the type and choose the right one. Your choice is kept and shows without (detected). The first entry of the list, for example Detected: Regulation, goes back to AskFiles's guess.

When AskFiles is not sure whether two files are copies or versions of one document, the Library page asks: Are these the same document? Answer Same document or Different.

## Summaries

On a computer with 16 GB of memory or more, AskFiles writes a one-sentence summary of each document after reading it. The summary appears under the document's name, on its page and on the Graph page. Until it is ready, it says Summary pending.

Each summary is checked against the document. A sentence the document does not back up is thrown away and never shown, so some documents may have no summary.

Summaries of each section are off unless you turn them on. There are two ways:

- **One document**: on its page, click Summarize each section. The button says about how many minutes it will take.
- **The whole library**: in the library menu, tick Summarize every section. This also covers documents you add later.

Summaries use the model on this computer, so asking is slower while they are being written. AskFiles stops writing summaries while it answers a question, and starts again a few seconds later. While it reads new files it waits until all of them are read; the top bar then says Summaries paused until indexing finishes (4 of 10 done). Otherwise it shows Summaries 3 of 10 while it works. Click Pause to stop, and Resume to go on.

The Markdown export is the folder Open Markdown export in the library menu shows in Finder: <your home folder>/Library/Application Support/AskFiles/libraries/<library>/export, for the first library .../libraries/all-files/export. Open it in Obsidian as a vault.

A computer with 8 GB of memory makes no summaries (see What it cannot do well).

## Markdown export

In the library menu, Open Markdown export opens a folder with one note per document: its summary, its section summaries, and links to the documents it mentions and to the headings it shares. Obsidian can open this folder as a vault. AskFiles keeps it up to date, and leaves alone any notes of your own that you put in it.
