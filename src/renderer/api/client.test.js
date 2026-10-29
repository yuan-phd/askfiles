import { describe, it, expect, vi } from 'vitest';
import {
  createClient,
  generateApiKey,
  parseEventStream,
  normalizeSource,
  mergeBySection,
  isNothingFound,
  splitThinking,
  REFUSAL_TEXT,
  LIBRARY_NAME,
  newSessionId,
} from './client.js';

function streamOf(...parts) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

async function collect(gen) {
  const out = [];
  for await (const e of gen) out.push(e);
  return out;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('parseEventStream', () => {
  it('parses events split across reads and CRLF line endings', async () => {
    const events = await collect(
      parseEventStream(streamOf('data: {"a":1}\n', '\ndata: {"a"', ':2}\r\n\r\ndata: {"a":3}')),
    );
    expect(events).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it('skips blocks that are not JSON', async () => {
    const events = await collect(parseEventStream(streamOf(': ping\n\ndata: oops\n\ndata: {"ok":true}\n\n')));
    expect(events).toEqual([{ ok: true }]);
  });

  it('decodes multibyte characters split across reads', async () => {
    const bytes = new TextEncoder().encode('data: {"t":"年假"}\n\n');
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(bytes.slice(0, 12));
        c.enqueue(bytes.slice(12));
        c.close();
      },
    });
    expect(await collect(parseEventStream(stream))).toEqual([{ t: '年假' }]);
  });
});

describe('splitThinking', () => {
  it('removes closed think blocks', () => {
    expect(splitThinking('<think>hmm</think>27 days.')).toEqual({ answer: '27 days.', thinking: false });
  });
  it('hides an open think block while streaming', () => {
    expect(splitThinking('<think>still going')).toEqual({ answer: '', thinking: true });
  });
});

describe('normalizeSource', () => {
  it('strips the upstream chunk header and keeps file name', () => {
    const s = normalizeSource({
      id: 'x',
      url: 'file:///tmp/hotdir/handbook.pdf',
      title: 'handbook.pdf',
      text: '<document_metadata>\nsourceDocument: handbook.pdf\npublished: today\n</document_metadata>\n\n1 Annual leave\nBody',
      score: 0.6,
    });
    expect(s).toMatchObject({
      title: 'handbook.pdf',
      text: '1 Annual leave\nBody',
      sectionTitle: null,
      page: null,
      score: 0.6,
    });
  });

  it('reads section and page from metadata or from the header', () => {
    expect(
      normalizeSource({ title: 'a.pdf', text: 't', sectionTitle: 'Leave', sectionIndex: '2', page: 3 }),
    ).toMatchObject({
      sectionTitle: 'Leave',
      sectionIndex: 2,
      page: 3,
    });
    const fromHeader = normalizeSource({
      title: 'a.pdf',
      text: '<document_metadata>\nsectionTitle: Leave\nsectionIndex: 4\npage: 7\n</document_metadata>\n\nBody',
    });
    expect(fromHeader).toMatchObject({ sectionTitle: 'Leave', sectionIndex: 4, page: 7, text: 'Body' });
  });

  it('reads the page range written into section documents', () => {
    expect(
      normalizeSource({ title: 'a.pdf', text: 't', sectionTitle: 'Leave', sectionIndex: 1, pageStart: 2, pageEnd: 4 }),
    ).toMatchObject({
      page: 2,
      pageEnd: 4,
    });
  });

  it('accepts vector-search results with nested metadata', () => {
    const s = normalizeSource({
      id: 'v',
      text: 'Body',
      metadata: { title: 'b.docx', url: 'file:///b.docx' },
      score: 0.1,
    });
    expect(s).toMatchObject({ id: 'v', title: 'b.docx', text: 'Body', score: 0.1 });
  });

  it('drops the continued suffix upstream adds to pinned passages', () => {
    expect(normalizeSource({ title: 'a', text: 'Body...continued on in source document...' }).text).toBe('Body');
  });
});

describe('mergeBySection', () => {
  const base = { title: 'a.pdf', url: 'file:///a.pdf', score: null };
  it('merges sub-chunks with the same section title and index', () => {
    const groups = mergeBySection([
      { ...base, id: '1', text: 'part one', sectionTitle: 'Leave', sectionIndex: 2, page: 4, score: 0.4 },
      { ...base, id: '2', text: 'other', sectionTitle: 'Pay', sectionIndex: 3, page: 6 },
      { ...base, id: '3', text: 'part two', sectionTitle: 'Leave', sectionIndex: 2, page: 5, score: 0.7 },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      sectionTitle: 'Leave',
      pages: [4, 5],
      passages: ['part one', 'part two'],
      score: 0.7,
    });
  });

  it('orders passages by document position inside a card and cards by rank', () => {
    const groups = mergeBySection([
      { ...base, id: '1', text: 'leave p5', sectionTitle: 'Leave', sectionIndex: 1, page: 5, score: 0.9 },
      { ...base, id: '2', text: 'pay p8', sectionTitle: 'Pay', sectionIndex: 2, page: 8, score: 0.8 },
      { ...base, id: '3', text: 'leave p4 rank 1', sectionTitle: 'Leave', sectionIndex: 1, page: 4, score: 0.7 },
      { ...base, id: '4', text: 'leave p4 rank 2', sectionTitle: 'Leave', sectionIndex: 1, page: 4, score: 0.6 },
      { ...base, id: '5', text: 'leave no page', sectionTitle: 'Leave', sectionIndex: 1, page: null, score: 0.5 },
    ]);
    expect(groups.map((g) => g.sectionTitle)).toEqual(['Leave', 'Pay']);
    // Same page keeps rank order (upstream has no finer position); no page sorts last.
    expect(groups[0].passages).toEqual(['leave p4 rank 1', 'leave p4 rank 2', 'leave p5', 'leave no page']);
    expect(groups[0]).not.toHaveProperty('hits');
  });

  it('expands page ranges of merged sub-chunks', () => {
    const groups = mergeBySection([
      { ...base, id: '1', text: 'a', sectionTitle: 'S', sectionIndex: 1, page: 2, pageEnd: 3 },
      { ...base, id: '2', text: 'b', sectionTitle: 'S', sectionIndex: 1, page: 3, pageEnd: 4 },
    ]);
    expect(groups[0].pages).toEqual([2, 3, 4]);
  });

  it('keeps the same section index in different documents apart', () => {
    const groups = mergeBySection([
      { ...base, id: '1', text: 'x', sectionTitle: 'Intro', sectionIndex: 1, page: null },
      {
        ...base,
        url: 'file:///b.pdf',
        title: 'b.pdf',
        id: '2',
        text: 'y',
        sectionTitle: 'Intro',
        sectionIndex: 1,
        page: null,
      },
    ]);
    expect(groups).toHaveLength(2);
  });

  it('never merges chunks without section information', () => {
    const groups = mergeBySection([
      { ...base, id: '1', text: 'x', sectionTitle: null, sectionIndex: null, page: null },
      { ...base, id: '2', text: 'y', sectionTitle: null, sectionIndex: null, page: null },
      { ...base, id: '1', text: 'x', sectionTitle: null, sectionIndex: null, page: null },
    ]);
    expect(groups.map((g) => g.passages)).toEqual([['x'], ['y']]);
  });
});

describe('isNothingFound', () => {
  it('is true without sources or with the refusal text', () => {
    expect(isNothingFound({ text: '27 days', sources: [] })).toBe(true);
    expect(isNothingFound({ text: ` ${REFUSAL_TEXT}\n`, sources: [{}] })).toBe(true);
    expect(isNothingFound({ text: '27 days', sources: [{}] })).toBe(false);
  });
});

describe('createClient', () => {
  it('sends the bearer key and unwraps the workspace array', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ workspace: [{ slug: 'lib', documents: [1, 2] }] }));
    const client = createClient({ baseUrl: 'http://127.0.0.1:3001/', apiKey: 'K', fetchImpl });
    expect(await client.getWorkspace('lib')).toEqual({ slug: 'lib', documents: [1, 2] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3001/api/v1/workspace/lib');
    expect(init.headers.Authorization).toBe('Bearer K');
  });

  it('creates the library with query mode and the refusal text only when missing', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push([url, init?.body && JSON.parse(init.body)]);
      if (url.endsWith('/v1/workspaces')) return jsonResponse({ workspaces: [{ name: 'other', slug: 'other' }] });
      return jsonResponse({ workspace: { name: LIBRARY_NAME, slug: 'askfiles-library' } });
    });
    const client = createClient({ baseUrl: 'http://h', apiKey: 'K', fetchImpl });
    const ws = await client.ensureLibrary();
    expect(ws.slug).toBe('askfiles-library');
    expect(calls[1]).toEqual([
      'http://h/api/v1/workspace/new',
      { name: LIBRARY_NAME, chatMode: 'query', queryRefusalResponse: REFUSAL_TEXT },
    ]);
  });

  it('streams chat events', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          streamOf(
            'data: {"type":"textResponseChunk","textResponse":"Hi"}\n\n',
            'data: {"type":"finalizeResponseStream","sources":[{"title":"a"}]}\n\n',
          ),
          {
            headers: { 'Content-Type': 'text/event-stream' },
          },
        ),
    );
    const client = createClient({ baseUrl: 'http://h', apiKey: 'K', fetchImpl });
    const events = await collect(client.streamChat('lib', 'q'));
    expect(events.map((e) => e.type)).toEqual(['textResponseChunk', 'finalizeResponseStream']);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toEqual({
      message: 'q',
      mode: 'query',
      sessionId: expect.stringMatching(/^askfiles-search-[0-9a-f-]{36}$/),
    });
  });

  it('uses a new session per question and passes reasoningEffort only when given', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ type: 'textResponse', textResponse: 'a', sources: [] }));
    const client = createClient({ baseUrl: 'http://h', apiKey: 'K', fetchImpl });
    await client.chat('lib', 'one');
    await client.chat('lib', 'two', { reasoningEffort: 'off' });
    const [a, b] = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(a.sessionId).not.toBe(b.sessionId);
    expect(a).not.toHaveProperty('reasoningEffort');
    expect(b.reasoningEffort).toBe('off');
    expect(newSessionId()).not.toBe(newSessionId());
  });

  it('throws ApiError with the server message', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'Query parameter cannot be empty.' }, 400));
    const client = createClient({ baseUrl: 'http://h', apiKey: 'K', fetchImpl });
    await expect(client.vectorSearch('lib', '')).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      message: 'Query parameter cannot be empty.',
    });
  });

  it('removes documents by unembedding then purging', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ workspace: {}, success: true }));
    const client = createClient({ baseUrl: 'http://h', apiKey: 'K', fetchImpl });
    await client.removeDocuments('lib', ['custom-documents/a.json']);
    expect(fetchImpl.mock.calls.map(([u, i]) => `${i.method} ${u}`)).toEqual([
      'POST http://h/api/v1/workspace/lib/update-embeddings',
      'DELETE http://h/api/v1/system/remove-documents',
    ]);
  });
});

describe('generateApiKey', () => {
  it('returns the secret', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ apiKey: { secret: 'S' }, error: null }));
    expect(await generateApiKey({ baseUrl: 'http://h', fetchImpl })).toBe('S');
    expect(fetchImpl.mock.calls[0][0]).toBe('http://h/api/system/generate-api-key');
  });
});
