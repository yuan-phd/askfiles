import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript client from Session D without type declarations
import * as client from '../renderer/api/client.js';
import { ensureApiKey, ensureLibrary, LIBRARY_NAME, REFUSAL_TEXT } from './library.js';

type Reply = { status: number; body: unknown };

function fakeFetch(replies: Reply[]) {
  const calls: { url: string; method: string; auth?: string; json?: unknown }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init.method ?? 'GET',
      auth: headers.Authorization,
      json: init.body ? JSON.parse(init.body as string) : undefined,
    });
    const r = replies.shift();
    if (!r) throw new Error(`unexpected ${init.method} ${url}`);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const BASE = 'http://127.0.0.1:5000/';

describe('library setup', () => {
  it('uses the same library name and refusal text as the search page', () => {
    expect(LIBRARY_NAME).toBe(client.LIBRARY_NAME);
    expect(REFUSAL_TEXT).toBe(client.REFUSAL_TEXT);
  });

  it('keeps a stored key the server accepts', async () => {
    const f = fakeFetch([{ status: 200, body: { authenticated: true } }]);
    expect(await ensureApiKey(BASE, 'old', f.impl)).toEqual({ apiKey: 'old', created: false });
    expect(f.calls).toEqual([{ url: 'http://127.0.0.1:5000/api/v1/auth', method: 'GET', auth: 'Bearer old' }]);
  });

  it('creates a key when none is stored or the stored one is refused', async () => {
    const f = fakeFetch([
      { status: 403, body: { error: 'No valid api key found.' } },
      { status: 200, body: { apiKey: { secret: 'NEW' }, error: null } },
      { status: 200, body: { apiKey: { secret: 'NEW2' }, error: null } },
    ]);
    expect(await ensureApiKey(BASE, 'stale', f.impl)).toEqual({ apiKey: 'NEW', created: true });
    expect(await ensureApiKey(BASE, null, f.impl)).toEqual({ apiKey: 'NEW2', created: true });
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET http://127.0.0.1:5000/api/v1/auth',
      'POST http://127.0.0.1:5000/api/system/generate-api-key',
      'POST http://127.0.0.1:5000/api/system/generate-api-key',
    ]);
    expect(f.calls[1]!.json).toEqual({ name: 'askfiles' });
  });

  it('fails loudly when the server cannot be asked or will not create a key', async () => {
    await expect(
      ensureApiKey(BASE, 'k', fakeFetch([{ status: 500, body: { error: 'db locked' } }]).impl),
    ).rejects.toThrow('GET /v1/auth failed (500): db locked');
    await expect(
      ensureApiKey(BASE, null, fakeFetch([{ status: 401, body: { error: 'multi-user mode' } }]).impl),
    ).rejects.toThrow('POST /system/generate-api-key failed (401): multi-user mode');
  });

  it('creates the library workspace with the preset settings and the refusal text', async () => {
    const f = fakeFetch([
      { status: 200, body: { workspaces: [{ name: 'other', slug: 'other' }] } },
      { status: 200, body: { workspace: { slug: 'askfiles-library' } } },
    ]);
    const settings = { chatMode: 'query', similarityThreshold: 0.5, topN: 4, openAiTemp: 0.1, openAiPrompt: 'P' };
    expect(await ensureLibrary(BASE, 'K', settings, f.impl)).toBe('askfiles-library');
    expect(f.calls[1]).toEqual({
      url: 'http://127.0.0.1:5000/api/v1/workspace/new',
      method: 'POST',
      auth: 'Bearer K',
      json: { name: 'askfiles-library', queryRefusalResponse: REFUSAL_TEXT, ...settings },
    });
  });

  it('updates an existing library with the preset settings instead of creating a second one', async () => {
    const f = fakeFetch([
      { status: 200, body: { workspaces: [{ name: 'askfiles-library', slug: 'askfiles-library-2' }] } },
      { status: 200, body: { workspace: { slug: 'askfiles-library-2' } } },
    ]);
    expect(await ensureLibrary(BASE, 'K', { topN: 6 }, f.impl)).toBe('askfiles-library-2');
    expect(f.calls[1]).toMatchObject({
      url: 'http://127.0.0.1:5000/api/v1/workspace/askfiles-library-2/update',
      json: { chatMode: 'query', queryRefusalResponse: REFUSAL_TEXT, topN: 6 },
    });
  });
});
