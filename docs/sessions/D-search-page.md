# Session D: search page and API client (plan tasks 3.1 and 3.3)

Executor: CLOUD
Dependencies: none hard. Use docs/upstream-analysis.md Q9 for endpoints if it exists; otherwise read upstream/server/endpoints and upstream/server/utils to find them, and note every assumption.
Branch: session/d-search-page
PR title: [Session D] Search page and AnythingLLM API client

## Goal

Build the page the user will actually see: one folder, one question box, an answer with its sources. It talks to AnythingLLM only through its REST API, so the upstream UI can be replaced without touching the backend.

## Interaction model

Search, not chat and not workspaces. One library; the client uses one hidden workspace for it and the user never sees the word. No model picker, no settings page. Every answer shows the source passages with file name, section title and page when available. Hits from the same section (sub-chunks that share a section title and section index) are merged into one card. When the answer indicates nothing was found, the page shows a section-listing fallback: the matching sections, each with file name, section title and page, so the user can read them. Clicking a source opens the original file (in this phase: emits an event the shell will handle; in the browser test, logs it).

Thinking output: some chat models return their reasoning inside the answer as `<think>...</think>` (docs/upstream-analysis.md Q9). The answer area always removes these blocks, whatever the preset, including a block that is still open while the stream is running (hide text after an unclosed `<think>` until `</think>` arrives). Add a test with a mocked stream that sends a think block split across several chunks.

Section title and index come from chunk metadata (docs/upstream-analysis.md Q15). If the report says upstream does not return them, show file name and page only, keep the card layout ready for the section title, and note it in the PR. The source of the fallback list (near-miss sources or a search-only endpoint) also comes from Q15; if neither exists, note it in the PR as open.

## Deliverables

1. src/renderer/api/client.js: a small ES module with functions for: create API key or use a provided one, create workspace, list workspaces, upload document, embed documents into a workspace, remove document, chat with sources (non-streaming), streaming chat (server-sent events or whatever the upstream route uses), list threads. Each function documents the route it calls and the response shape it returns. No framework, fetch only.
2. src/renderer/search/index.html, search.css, search.js: layout with a top status bar (library folder, indexed count, indexing state), a query box, the answer area (streaming text), source cards (passage text, file name, section title and page if present, open button; hits from the same section merged), the section-listing fallback state, and a recent questions list. Keyboard: Enter submits, Shift+Enter newline, Escape clears.
3. Light and dark mode through CSS variables and prefers-color-scheme. Typography and spacing clean enough that the owner will only tune, not rebuild. No icon fonts, no external resources.
4. A config hook: the page reads base URL and API key from window.shellConfig if present, otherwise from query parameters, so it works both inside Electron and in a plain browser during tests.
5. test/e2e/search.spec.js with Playwright against a running upstream server in this container: start the server (reuse the process manager if Session C has merged; otherwise a minimal script), create a workspace, upload a small PDF from test/fixtures, embed it, open the page, ask a question, assert an answer and at least one source card render with file name and page (and section title when the server returns it). Add a test for card merging (two sources with the same section index render as one card) and one for the fallback state (a refusal answer renders the section list). These two may mock the chat route. If Ollama is missing, mock the chat route at the network level in Playwright and still assert the page behaviour.
6. Screenshots of the page in light and dark mode attached to the PR.

## Do not

- Do not use React, Vue or any framework. Plain HTML, CSS and JS.
- Do not implement folder watching (Session F), onboarding (Session E) or the Electron wiring (plan task 3.5).
- Do not copy or restyle the upstream frontend. This page is independent.
- Do not edit upstream/.

## Acceptance

- Playwright test green in this container, either against a real model or against the documented mock.
- The API client has no dependency and works from a plain browser.
- PR opened with screenshots (including the fallback state) and a list of every upstream route used.
