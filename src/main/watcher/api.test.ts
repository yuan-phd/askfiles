import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLibraryApi } from './api.js';
import { loadIndex, saveIndex } from './index-store.js';

function recordingFetch(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method!,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    const r = responses.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('createLibraryApi', () => {
  it('sends the documented routes with the bearer key', async () => {
    const f = recordingFetch([
      { status: 200, body: { workspace: {} } },
      { status: 200, body: { workspace: {} } },
      { status: 200, body: { success: true } },
      { status: 200, body: { workspace: [{ documents: [{ docpath: 'askfiles/a.json', docId: 'd1' }] }] } },
    ]);
    const api = createLibraryApi({ baseUrl: 'http://127.0.0.1:5000/', apiKey: 'K', fetchImpl: f.impl });
    await api.updateEmbeddings('library', { adds: ['askfiles/a.json'], deletes: [] });
    await api.removeDocuments('library', ['askfiles/b.json']);
    await api.removeDocuments('library', []);
    const docs = await api.workspaceDocuments('library');

    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://127.0.0.1:5000/api/v1/workspace/library/update-embeddings',
      'POST http://127.0.0.1:5000/api/v1/workspace/library/update-embeddings',
      'DELETE http://127.0.0.1:5000/api/v1/system/remove-documents',
      'GET http://127.0.0.1:5000/api/v1/workspace/library',
    ]);
    expect(f.calls[0]!.headers.Authorization).toBe('Bearer K');
    expect(f.calls[0]!.body).toEqual({ adds: ['askfiles/a.json'], deletes: [] });
    expect(f.calls[1]!.body).toEqual({ adds: [], deletes: ['askfiles/b.json'] });
    expect(f.calls[2]!.body).toEqual({ names: ['askfiles/b.json'] });
    expect([...docs]).toEqual([['askfiles/a.json', 'd1']]);
  });

  it('throws with the status and the server message', async () => {
    const f = recordingFetch([{ status: 403, body: { error: 'No valid api key found.' } }]);
    const api = createLibraryApi({ baseUrl: 'http://127.0.0.1:5000', apiKey: 'bad', fetchImpl: f.impl });
    await expect(api.updateEmbeddings('library', { adds: [], deletes: [] })).rejects.toThrow(
      'POST /v1/workspace/library/update-embeddings failed (403): No valid api key found.',
    );
  });

  it('reports a missing workspace', async () => {
    const f = recordingFetch([{ status: 200, body: { workspace: [] } }]);
    const api = createLibraryApi({ baseUrl: 'http://127.0.0.1:5000', apiKey: 'K', fetchImpl: f.impl });
    await expect(api.workspaceDocuments('nope')).rejects.toThrow('workspace nope not found');
  });
});

describe('index.json', () => {
  it('round-trips, starts empty when missing and sets a damaged file aside', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-index-'));
    const file = path.join(dir, 'index.json');
    expect(loadIndex(file)).toEqual({ version: 1, files: {} });
    saveIndex(file, { version: 1, files: {} });
    expect(loadIndex(file)).toEqual({ version: 1, files: {} });
    fs.writeFileSync(file, '{ half');
    const logs: string[] = [];
    expect(loadIndex(file, (m) => logs.push(m))).toEqual({ version: 1, files: {} });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(dir).some((n) => n.startsWith('index.json.broken-'))).toBe(true);
    expect(logs[0]).toContain('unreadable');
    fs.rmSync(dir, { recursive: true });
  });
  it('uploads a file for its text without a workspace, purges copies, and follows a moving base URL', async () => {
    const calls: { url: string; method: string; form?: FormData; json?: unknown }[] = [];
    const replies = [
      {
        status: 200,
        body: {
          success: true,
          documents: [
            { location: 'custom-documents/scan.pdf-1.json', pageContent: 'Page one' },
            { location: 'custom-documents/scan.pdf-2.json', pageContent: 'Page two' },
          ],
        },
      },
      { status: 200, body: { success: true } },
      { status: 200, body: { success: false, error: 'No text content found for scan.pdf' } },
    ];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: init.method!,
        form: init.body instanceof FormData ? init.body : undefined,
        json: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const r = replies.shift()!;
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch;
    let port = 5000;
    const api = createLibraryApi({ baseUrl: () => `http://127.0.0.1:${port}`, apiKey: 'K', fetchImpl: impl });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-api-'));
    const file = path.join(dir, 'scan.pdf');
    fs.writeFileSync(file, '%PDF-1.4');

    expect(await api.uploadForText(file)).toEqual({
      text: 'Page one\n\nPage two',
      locations: ['custom-documents/scan.pdf-1.json', 'custom-documents/scan.pdf-2.json'],
    });
    const form = calls[0]!.form!;
    expect(calls[0]!.url).toBe('http://127.0.0.1:5000/api/v1/document/upload');
    expect(form.has('addToWorkspaces')).toBe(false);
    expect((form.get('file') as File).name).toBe('scan.pdf');

    port = 5001;
    await api.purgeDocuments(['custom-documents/scan.pdf-1.json']);
    expect(calls[1]).toMatchObject({
      url: 'http://127.0.0.1:5001/api/v1/system/remove-documents',
      method: 'DELETE',
      json: { names: ['custom-documents/scan.pdf-1.json'] },
    });
    await api.purgeDocuments([]);
    expect(calls).toHaveLength(2);
    await expect(api.uploadForText(file)).rejects.toThrow('upload of scan.pdf failed: No text content found');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
