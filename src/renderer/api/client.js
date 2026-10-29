// Upstream REST client for the AskFiles pages. Plain ES module, fetch only, no dependencies,
// so it runs unchanged in Electron, a plain browser and Node 22.
//
// Every route below is the upstream developer API (upstream/server/endpoints/api) at the tag in
// UPSTREAM_VERSION, except generateApiKey, which uses the internal route the upstream settings page
// calls because the developer API cannot create its own first key.

/** Name of the one hidden workspace that holds the library. The user never sees it. */
export const LIBRARY_NAME = 'askfiles-library';

/** Prefix of the session id the page sends with every question. */
export const SEARCH_SESSION_PREFIX = 'askfiles-search';

/**
 * A fresh session id per question. Upstream backfills context from earlier answers in the same
 * session, so a shared id would let query mode answer from a previous question's sources
 * (docs/upstream-analysis.md Q9).
 */
export function newSessionId() {
  return `${SEARCH_SESSION_PREFIX}-${globalThis.crypto.randomUUID()}`;
}

/**
 * Text the library workspace answers with when query mode finds nothing. Set on the workspace so
 * the page can detect a refusal without guessing at model wording.
 */
export const REFUSAL_TEXT = 'Nothing in your documents answers this question.';

// Upstream's built-in refusal, used when a workspace has no queryRefusalResponse
// (upstream/server/utils/chats/apiChatHandler.js).
const UPSTREAM_REFUSAL_TEXT = 'There is no relevant information in this workspace to answer your query.';

// Appended by upstream to pinned and attached document passages (apiChatHandler.js).
const CONTINUED_SUFFIX = '...continued on in source document...';

export class ApiError extends Error {
  constructor(message, { status = 0, route = '', body = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.route = route;
    this.body = body;
  }
}

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * POST /api/system/generate-api-key  body { name }
 * Returns the key secret (string). Response shape: { apiKey: { id, name, secret, ... }, error }.
 * Works only while the server runs single-user without AUTH_TOKEN, which is how AskFiles runs it.
 */
export async function generateApiKey({ baseUrl, name = 'askfiles', fetchImpl = globalThis.fetch }) {
  const route = '/api/system/generate-api-key';
  const res = await fetchImpl(`${trimSlash(baseUrl)}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = await readBody(res);
  if (!res.ok || !body?.apiKey?.secret) {
    throw new ApiError(body?.error || `Could not create an API key (${res.status})`, {
      status: res.status,
      route,
      body,
    });
  }
  return body.apiKey.secret;
}

/**
 * Creates a client bound to one server and API key.
 * @param {{ baseUrl: string, apiKey: string, fetchImpl?: typeof fetch }} options
 */
export function createClient({ baseUrl, apiKey, fetchImpl = globalThis.fetch }) {
  const root = `${trimSlash(baseUrl)}/api`;

  async function request(method, route, { json, form, signal, raw = false } = {}) {
    const headers = { Authorization: `Bearer ${apiKey}` };
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form) {
      body = form;
    }
    const res = await fetchImpl(`${root}${route}`, { method, headers, body, signal });
    if (raw) {
      if (!res.ok) {
        const errBody = await readBody(res);
        throw new ApiError(errBody?.error || errBody?.message || `${method} ${route} failed (${res.status})`, {
          status: res.status,
          route,
          body: errBody,
        });
      }
      return res;
    }
    const data = await readBody(res);
    if (!res.ok) {
      const message = data?.error || data?.message || `${method} ${route} failed (${res.status})`;
      throw new ApiError(message, { status: res.status, route, body: data });
    }
    return data;
  }

  const slugPath = (slug) => `/v1/workspace/${encodeURIComponent(slug)}`;

  return {
    /** GET /api/v1/auth. Returns true when the key is valid. Response: { authenticated: true }. */
    async checkAuth() {
      try {
        const data = await request('GET', '/v1/auth');
        return data?.authenticated === true;
      } catch (e) {
        if (e.status === 403 || e.status === 401) return false;
        throw e;
      }
    },

    /**
     * POST /api/v1/workspace/new  body { name, ...settings }
     * settings are workspace columns such as chatMode, similarityThreshold, topN, queryRefusalResponse.
     * Returns the workspace: { id, name, slug, chatMode, topN, similarityThreshold, ... }.
     */
    async createWorkspace(name, settings = {}) {
      const data = await request('POST', '/v1/workspace/new', { json: { name, ...settings } });
      return data.workspace;
    },

    /** GET /api/v1/workspaces. Returns an array of workspaces, each with threads: []. */
    async listWorkspaces() {
      const data = await request('GET', '/v1/workspaces');
      return data.workspaces || [];
    },

    /**
     * GET /api/v1/workspace/:slug
     * Upstream answers { workspace: [ ws ] } (an array, from findMany); this returns ws or null.
     * ws includes documents: [{ docId, filename, docpath, metadata (JSON string), pinned, ... }]
     * and threads: [{ user_id, slug }].
     */
    async getWorkspace(slug) {
      const data = await request('GET', slugPath(slug));
      const ws = data?.workspace;
      return (Array.isArray(ws) ? ws[0] : ws) || null;
    },

    /**
     * Finds the library workspace by name or creates it. Settings apply only on creation.
     * Routes: GET /api/v1/workspaces, then POST /api/v1/workspace/new when missing.
     */
    async ensureLibrary({ name = LIBRARY_NAME, settings = {} } = {}) {
      const existing = (await this.listWorkspaces()).find((w) => w.name === name);
      if (existing) return existing;
      return this.createWorkspace(name, { chatMode: 'query', queryRefusalResponse: REFUSAL_TEXT, ...settings });
    },

    /**
     * POST /api/v1/workspace/:slug/update  body { ...settings }
     * Writes workspace columns such as similarityThreshold, topN, chatMode, openAiPrompt, openAiTemp,
     * vectorSearchMode; upstream drops unknown keys. Returns the updated workspace.
     */
    async updateWorkspace(slug, settings) {
      const data = await request('POST', `${slugPath(slug)}/update`, { json: settings });
      return data.workspace;
    },

    /**
     * POST /api/v1/document/upload  multipart: file, addToWorkspaces (comma separated slugs), metadata (JSON)
     * Parses the file in the collector; embeds it too when addToWorkspaces is given.
     * Returns documents: [{ id, location, title, url, docSource, chunkSource, published, wordCount,
     * token_count_estimate, pageContent }]. location is what embedDocuments and removeDocuments take.
     * @param {Blob} file
     */
    async uploadDocument(file, { filename, addToWorkspaces = [], metadata } = {}) {
      const form = new FormData();
      form.append('file', file, filename || file.name || 'document');
      const slugs = Array.isArray(addToWorkspaces) ? addToWorkspaces.join(',') : addToWorkspaces;
      if (slugs) form.append('addToWorkspaces', slugs);
      if (metadata) form.append('metadata', JSON.stringify(metadata));
      const data = await request('POST', '/v1/document/upload', { form });
      if (data?.success === false)
        throw new ApiError(data.error || 'Upload failed', { route: '/v1/document/upload', body: data });
      return data.documents || [];
    },

    /**
     * POST /api/v1/workspace/:slug/update-embeddings  body { adds: [location], deletes: [location] }
     * Embeds adds into the workspace and drops deletes from it. Returns the updated workspace.
     */
    async embedDocuments(slug, { adds = [], deletes = [] } = {}) {
      const data = await request('POST', `${slugPath(slug)}/update-embeddings`, { json: { adds, deletes } });
      return data.workspace;
    },

    /**
     * Removes documents from the library. Always unembeds them through update-embeddings; with
     * purge it also deletes the parsed copies with DELETE /api/v1/system/remove-documents
     * body { names: [location] }, response { success, message }.
     */
    async removeDocuments(slug, locations, { purge = true } = {}) {
      await this.embedDocuments(slug, { deletes: locations });
      if (purge) await request('DELETE', '/v1/system/remove-documents', { json: { names: locations } });
    },

    /**
     * POST /api/v1/workspace/:slug/chat  body { message, mode, sessionId, reasoningEffort? }
     * reasoningEffort is read by patches/007; without it the server uses DEFAULT_REASONING_EFFORT.
     * Returns { id, type: "textResponse" | "abort", textResponse, sources: [...], close, error, metrics }.
     */
    async chat(slug, message, { mode = 'query', sessionId = newSessionId(), reasoningEffort, signal } = {}) {
      return request('POST', `${slugPath(slug)}/chat`, {
        json: chatBody(message, mode, sessionId, reasoningEffort),
        signal,
      });
    },

    /**
     * POST /api/v1/workspace/:slug/stream-chat  body { message, mode, sessionId, reasoningEffort? }
     * Server-sent events over the POST response, one JSON object per data: line:
     *   { uuid, type: "textResponseChunk", textResponse, sources: [], close, error }
     *   { uuid, type: "finalizeResponseStream", close: true, chatId, metrics, sources }
     *   { uuid, type: "textResponse", textResponse, sources, close: true }  (query refusal, single event)
     *   { uuid, type: "abort", textResponse: null, sources: [], close: true, error }
     * Sources usually arrive only on the finalizeResponseStream event.
     * Yields each event object.
     */
    async *streamChat(slug, message, { mode = 'query', sessionId = newSessionId(), reasoningEffort, signal } = {}) {
      const res = await request('POST', `${slugPath(slug)}/stream-chat`, {
        json: chatBody(message, mode, sessionId, reasoningEffort),
        signal,
        raw: true,
      });
      const type = res.headers.get('content-type') || '';
      if (!type.includes('text/event-stream')) {
        // Validation errors come back as plain JSON with status 400, handled above; anything
        // else non-streaming is treated as one event so callers have a single code path.
        const body = await readBody(res);
        if (body && typeof body === 'object') yield body;
        return;
      }
      yield* parseEventStream(res.body);
    },

    /**
     * POST /api/v1/workspace/:slug/vector-search  body { query, topN, scoreThreshold }
     * Similarity search only, no model. Returns results: [{ id, text, metadata: { url, title, author,
     * description, docSource, chunkSource, published, wordCount, tokenCount }, distance, score }].
     * Used for the section-listing fallback because query-mode refusals return no sources.
     */
    async vectorSearch(slug, query, { topN, scoreThreshold, signal } = {}) {
      const json = { query };
      if (topN !== undefined) json.topN = topN;
      if (scoreThreshold !== undefined) json.scoreThreshold = scoreThreshold;
      const data = await request('POST', `${slugPath(slug)}/vector-search`, { json, signal });
      return data.results || [];
    },

    /**
     * Threads of the workspace, from GET /api/v1/workspace/:slug (threads: [{ user_id, slug }]).
     * Upstream has no dedicated thread listing route in the developer API.
     */
    async listThreads(slug) {
      const ws = await this.getWorkspace(slug);
      return ws?.threads || [];
    },

    /**
     * GET /api/v1/workspace/:slug/chats?apiSessionId=&limit=&orderBy=
     * Returns history: [{ role: "user" | "assistant", content, sentAt, sources?, chatId }].
     * Without sessionId upstream returns only chats sent without one, so the page's own questions
     * (one session each) are not listed; the page keeps its recent questions locally.
     */
    async listChats(slug, { sessionId = null, limit = 50, orderBy = 'desc' } = {}) {
      const params = new URLSearchParams({ limit: String(limit), orderBy });
      if (sessionId) params.set('apiSessionId', sessionId);
      const data = await request('GET', `${slugPath(slug)}/chats?${params}`);
      return data.history || [];
    },
  };
}

function chatBody(message, mode, sessionId, reasoningEffort) {
  const body = { message, mode, sessionId };
  if (reasoningEffort) body.reasoningEffort = reasoningEffort;
  return body;
}

/**
 * Parses a server-sent event body into JSON objects. Accepts a ReadableStream of bytes.
 * Upstream writes "data: <json>\n\n" per event (upstream/server/utils/helpers/chat/responses.js).
 */
export async function* parseEventStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      if (done) buffer += decoder.decode();
      buffer = buffer.replace(/\r\n/g, '\n');
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const event = parseEventBlock(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
        if (event) yield event;
      }
      if (done) {
        const event = parseEventBlock(buffer);
        if (event) yield event;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEventBlock(block) {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Splits model output into the visible answer and whether the model is still reasoning.
 * Reasoning models (qwen3 among them) stream a <think> block before the answer; upstream keeps it.
 */
export function splitThinking(text) {
  let answer = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const open = answer.indexOf('<think>');
  const thinking = open !== -1;
  if (thinking) answer = answer.slice(0, open);
  return { answer: answer.trim(), thinking };
}

function parseHeader(text) {
  const match = /^\s*<document_metadata>\n?([\s\S]*?)<\/document_metadata>\s*/.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields = {};
  for (const line of match[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { fields, body: text.slice(match[0].length) };
}

function firstDefined(...values) {
  for (const v of values) if (v !== undefined && v !== null && v !== '') return v;
  return null;
}

function toInt(v) {
  if (v === null) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// Section documents of formats without pages (Word, Markdown) carry page 0, because LanceDB needs
// the same column types on every row; 0 and below mean no page.
function toPage(v) {
  const n = toInt(v);
  return n !== null && n > 0 ? n : null;
}

function fileNameOf(url) {
  if (!url) return null;
  const clean = String(url).split(/[?#]/)[0];
  return decodeURIComponent(clean.slice(clean.lastIndexOf('/') + 1)) || null;
}

/**
 * Maps a chat source or a vector-search result to one shape:
 * { id, title, url, text, sectionTitle, sectionIndex, page, pageEnd, score }.
 * Section and pages are read from metadata keys first, then from the chunk header. Collector
 * uploads carry neither; section documents written by the shell carry sectionTitle, sectionIndex,
 * pageStart and pageEnd (docs/upstream-analysis.md Q13, Q15). The page hides what is missing.
 */
export function normalizeSource(raw = {}) {
  const meta = raw.metadata && typeof raw.metadata === 'object' ? { ...raw.metadata, ...raw } : raw;
  const { fields, body } = parseHeader(String(raw.text ?? meta.text ?? ''));
  let text = body.trim();
  if (text.endsWith(CONTINUED_SUFFIX)) text = text.slice(0, -CONTINUED_SUFFIX.length).trimEnd();
  const url = meta.url || null;
  return {
    id: meta.id || null,
    title: firstDefined(meta.title, fields.sourceDocument, fileNameOf(url), 'Untitled document'),
    url,
    text,
    sectionTitle: firstDefined(meta.sectionTitle, meta.section_title, fields.sectionTitle, fields.section),
    sectionIndex: toInt(firstDefined(meta.sectionIndex, meta.section_index, fields.sectionIndex)),
    page: toPage(
      firstDefined(meta.pageStart, meta.page, meta.pageNumber, meta.loc?.pageNumber, fields.pageStart, fields.page),
    ),
    pageEnd: toPage(firstDefined(meta.pageEnd, fields.pageEnd)),
    score: typeof meta.score === 'number' ? meta.score : null,
  };
}

/**
 * Groups normalized sources so sub-chunks of one section become one entry. Two hits belong to
 * the same section when they come from the same document and share section title and index.
 * Hits without any section information are never merged with each other, only de-duplicated.
 * Groups keep search-rank order (first appearance). Passages inside a group follow document
 * position: section index, then page; hits with the same position keep their rank order, since
 * upstream returns no finer chunk position.
 * Returns [{ key, title, url, sectionTitle, sectionIndex, pages: number[], passages: string[], score }].
 */
export function mergeBySection(sources) {
  const groups = new Map();
  for (const s of sources) {
    const doc = s.url || s.title;
    const hasSection = s.sectionTitle !== null || s.sectionIndex !== null;
    const key = hasSection
      ? `${doc}\u0000${s.sectionIndex ?? ''}\u0000${s.sectionTitle ?? ''}`
      : `${doc}\u0000chunk\u0000${s.id || s.text}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        title: s.title,
        url: s.url,
        sectionTitle: s.sectionTitle,
        sectionIndex: s.sectionIndex,
        pages: [],
        passages: [],
        hits: [],
        score: s.score,
      };
      groups.set(key, g);
    }
    if (s.page != null) {
      const last = s.pageEnd != null && s.pageEnd >= s.page ? s.pageEnd : s.page;
      for (let p = s.page; p <= last; p++) if (!g.pages.includes(p)) g.pages.push(p);
    }
    if (s.text && !g.hits.some((h) => h.text === s.text)) {
      g.hits.push({ text: s.text, sectionIndex: s.sectionIndex, page: s.page, rank: g.hits.length });
    }
    if (s.score !== null && (g.score === null || s.score > g.score)) g.score = s.score;
  }
  const position = (v) => (v == null ? Infinity : v);
  return [...groups.values()].map(({ hits, ...g }) => {
    hits.sort(
      (a, b) =>
        position(a.sectionIndex) - position(b.sectionIndex) || position(a.page) - position(b.page) || a.rank - b.rank,
    );
    return { ...g, pages: g.pages.sort((a, b) => a - b), passages: hits.map((h) => h.text) };
  });
}

function normalizeText(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * True when an answer means nothing was found: no sources at all, or the text is the workspace
 * refusal. Query mode returns sources: [] whenever it refuses, so the source list decides first.
 */
export function isNothingFound({ text, sources }, refusalText = REFUSAL_TEXT) {
  if (!sources || sources.length === 0) return true;
  const t = normalizeText(splitThinking(text).answer);
  return t === normalizeText(refusalText) || t === normalizeText(UPSTREAM_REFUSAL_TEXT);
}
