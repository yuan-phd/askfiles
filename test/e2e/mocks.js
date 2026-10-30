// Stand-ins for what the pages call: the upstream library routes at the network level, and the
// preload bridge in the page, including the answer pipeline's event stream
// (src/main/answer/service.ts), so tests never depend on a model's wording.
export const MOCK_BASE = 'http://127.0.0.1:1';

export function pageUrl(params) {
  const q = new URLSearchParams({ baseUrl: MOCK_BASE, apiKey: 'test-key', workspace: 'lib', ...params });
  return `${process.env.ASKFILES_PAGE_URL}/ask/index.html?${q}`;
}

/**
 * Routes the upstream calls the Ask page still makes (the library count). Options: documents,
 * the number of indexed documents; recent, questions seeded into the page's local storage.
 */
export async function mockLibrary(page, { documents = 3, recent = [] } = {}) {
  if (recent.length) {
    await page.addInitScript((list) => {
      window.localStorage.setItem('askfiles.recentQuestions', JSON.stringify(list));
    }, recent);
  }
  await page.route(`${MOCK_BASE}/api/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const json = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(body),
      });

    if (req.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE',
        },
      });
    }
    if (path === '/api/v1/workspace/lib' && req.method() === 'GET') {
      return json({
        workspace: [{ slug: 'lib', documents: Array.from({ length: documents }, (_, i) => ({ id: i })), threads: [] }],
      });
    }
    return json({ error: `unmocked ${req.method()} ${path}` }, 404);
  });
}

/**
 * In-page stand-in for the preload bridge (src/main/preload.ts) as the Ask page uses it:
 * window.askfiles.watcher and .app. window.__watcher(status) pushes a status event the way the
 * main process does; window.__bridgeCalls records pageReady calls. status is what status() answers.
 */
export async function stubBridge(page, { status = null } = {}) {
  await page.addInitScript((initial) => {
    const listeners = [];
    window.__bridgeCalls = [];
    window.__watcher = (s) => listeners.forEach((l) => l(s));
    window.askfiles = {
      watcher: {
        status: async () => initial,
        onStatus: (cb) => {
          listeners.push(cb);
          return () => listeners.splice(listeners.indexOf(cb), 1);
        },
      },
      app: {
        info: async () => ({ name: 'AskFiles', version: '0.1.0' }),
        pageReady: (info) => window.__bridgeCalls.push(['pageReady', info]),
      },
    };
  }, status);
}

/** A watcher status as src/main/watcher reports it, with the folder the shell adds. */
export function watcherStatus(over = {}) {
  return {
    state: 'idle',
    pending: 0,
    current: null,
    indexed: 0,
    deadLetters: [],
    folder: '/Users/anna/Documents/HR',
    ...over,
  };
}

/** A source card as the pipeline sends it (src/main/answer/pipeline.ts, SourceCard). */
export function card(n, over = {}) {
  return {
    n,
    file: 'handbook.pdf',
    relPath: 'handbook.pdf',
    url: 'file:///library/handbook.pdf',
    documentId: 'doc-handbook',
    sectionIndex: n,
    title: `Section ${n}`,
    path: ['Handbook', `Section ${n}`],
    pageStart: n,
    pageEnd: n,
    pageLabel: null,
    passage: `Passage of section ${n}.`,
    rerank: 0.9,
    trimmed: false,
    ...over,
  };
}

/**
 * The events of one answered question: stages, the numbered sources, the streamed parts, then
 * done with the result. result fills in what the defaults leave out.
 */
export function answerRun({ sources, deltas = [], result = {} }) {
  return [
    { type: 'stage', stage: 'retrieving' },
    { type: 'sources', sources },
    { type: 'stage', stage: 'answering' },
    ...deltas.map((parts) => ({ type: 'delta', parts })),
    {
      type: 'done',
      result: {
        text: '',
        notFound: false,
        claims: [],
        cited: [],
        considered: [],
        nearest: [],
        skippedModel: false,
        timings: { firstTokenMs: 5, modelMs: 10 },
        stats: { promptTokens: 1, completionTokens: 1 },
        ...result,
      },
    },
  ];
}

/** Text parts and citations from a string such as 'Leave is 27 days [1].' */
export function partsOf(text) {
  const parts = [];
  for (const piece of text.split(/(\[\d+\])/)) {
    const m = /^\[(\d+)\]$/.exec(piece);
    if (m) parts.push({ type: 'cite', n: Number(m[1]) });
    else if (piece) parts.push({ type: 'text', text: piece });
  }
  return parts;
}

/**
 * window.askfiles.answer in the page. runs maps a question to its events (answerRun); any other
 * question gets fallback. The first event goes out before ask() resolves, as in the app, where
 * the run starts before the id reaches the page; the rest follow one per task. developer is what
 * developer() answers. Calls are recorded in window.__answerCalls. Register after stubBridge.
 */
export async function stubAnswer(
  page,
  { runs = {}, fallback = null, developer = { enabled: false, overrides: {}, trace: null } } = {},
) {
  await page.addInitScript(
    ({ runs, fallback, developer }) => {
      const listeners = [];
      let next = 0;
      window.__answerCalls = [];
      window.askfiles = Object.assign(window.askfiles || {}, {
        answer: {
          ask: async (question) => {
            window.__answerCalls.push(['ask', question]);
            const id = `run-${++next}`;
            const events = runs[question] ?? fallback ?? [{ type: 'error', message: `no stub for ${question}` }];
            const send = (e) => listeners.forEach((l) => l({ id, ...e }));
            if (events.length) send(events[0]);
            let i = 1;
            const tick = () => {
              if (i >= events.length) return;
              send(events[i++]);
              setTimeout(tick, 5);
            };
            setTimeout(tick, 5);
            return { id };
          },
          onEvent: (cb) => {
            listeners.push(cb);
            return () => listeners.splice(listeners.indexOf(cb), 1);
          },
          cancel: async (id) => {
            window.__answerCalls.push(['cancel', id]);
          },
          developer: async () => developer,
          setOverrides: async (o) => {
            window.__answerCalls.push(['setOverrides', o]);
            return o;
          },
          saveCase: async (c) => {
            window.__answerCalls.push(['saveCase', c]);
            return { id: 'case-1', file: '/data/eval-questions.csv' };
          },
        },
      });
    },
    { runs, fallback, developer },
  );
}
