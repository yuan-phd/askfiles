// Network-level stand-in for the upstream routes the page calls, for tests that must not depend
// on a model's wording. Shapes copy what a v1.19.0 server returned in this container.
export const MOCK_BASE = 'http://127.0.0.1:1';

export function pageUrl(params) {
  const q = new URLSearchParams({ baseUrl: MOCK_BASE, apiKey: 'test-key', workspace: 'lib', ...params });
  return `${process.env.ASKFILES_PAGE_URL}/search/index.html?${q}`;
}

export function sse(events) {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

export function answerEvents(text, sources) {
  const words = text.split(/(?<= )/);
  return [
    {
      uuid: 'u',
      type: 'textResponseChunk',
      textResponse: '<think>reading</think>',
      sources: [],
      close: false,
      error: false,
    },
    ...words.map((w) => ({
      uuid: 'u',
      type: 'textResponseChunk',
      textResponse: w,
      sources: [],
      close: false,
      error: false,
    })),
    { uuid: 'u', type: 'textResponseChunk', textResponse: '', sources: [], close: true, error: false },
    { uuid: 'u', type: 'finalizeResponseStream', close: true, error: false, chatId: 1, sources },
  ];
}

export function refusalEvents(text) {
  return [{ id: 'u', type: 'textResponse', textResponse: text, sources: [], close: true, error: null }];
}

export function chunk({ id, file = 'handbook.pdf', text, sectionTitle, sectionIndex, page, score = 0.6 }) {
  const header = ['sourceDocument: ' + file, 'published: 10/29/2026, 7:09:07 AM'];
  return {
    id,
    url: `file:///library/${file}`,
    title: file,
    docSource: 'pdf file uploaded by the user.',
    chunkSource: '',
    text: `<document_metadata>\n${header.join('\n')}\n</document_metadata>\n\n${text}`,
    score,
    ...(sectionTitle !== undefined ? { sectionTitle } : {}),
    ...(sectionIndex !== undefined ? { sectionIndex } : {}),
    ...(page !== undefined ? { page } : {}),
  };
}

export function asVectorResult(c) {
  const { id, text, score, ...metadata } = c;
  return { id, text, metadata, distance: 1 - score, score };
}

/**
 * Routes every upstream call of the page. Options:
 *   documents: number of indexed documents, recent: questions seeded into the page's local storage,
 *   stream: (body) => events for stream-chat, vector: (body) => results for vector-search.
 * Returns { requests } with the parsed JSON bodies per route for assertions.
 */
export async function mockLibrary(page, { documents = 3, recent = [], stream, vector } = {}) {
  const requests = { stream: [], vector: [] };
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
    if (path === '/api/v1/workspace/lib/stream-chat') {
      const body = req.postDataJSON();
      requests.stream.push(body);
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' },
        body: sse(stream ? stream(body) : refusalEvents('no stream mock')),
      });
    }
    if (path === '/api/v1/workspace/lib/vector-search') {
      const body = req.postDataJSON();
      requests.vector.push(body);
      return json({ results: vector ? vector(body) : [] });
    }
    return json({ error: `unmocked ${req.method()} ${path}` }, 404);
  });
  return { requests };
}
