import fs from 'node:fs';
import path from 'node:path';
import type { LibraryApi, OcrApi } from './types.js';

/**
 * The developer API calls the watcher makes, ported from src/renderer/api/client.js
 * (embedDocuments, removeDocuments, getWorkspace, uploadDocument) because the main process build
 * only compiles src/main. Routes and payloads: docs/upstream-analysis.md Q9.
 * baseUrl may be a function: the server port changes when the shell restarts the server.
 */
export function createLibraryApi(options: {
  baseUrl: string | (() => string);
  apiKey: string;
  fetchImpl?: typeof fetch;
}): LibraryApi & OcrApi {
  const base = typeof options.baseUrl === 'function' ? options.baseUrl : () => options.baseUrl as string;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request(method: string, route: string, json?: unknown, form?: FormData): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: `Bearer ${options.apiKey}` };
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetchImpl(`${base().replace(/\/+$/, '')}/api${route}`, {
      method,
      headers,
      body: json === undefined ? form : JSON.stringify(json),
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const body = data as { error?: string; message?: string } | null;
      throw new Error(
        `${method} ${route} failed (${res.status}): ${body?.error ?? body?.message ?? text.slice(0, 200)}`,
      );
    }
    return data;
  }

  const slugPath = (slug: string) => `/v1/workspace/${encodeURIComponent(slug)}`;

  return {
    async updateEmbeddings(slug, { adds, deletes }) {
      await request('POST', `${slugPath(slug)}/update-embeddings`, { adds, deletes });
    },
    async removeDocuments(slug, locations) {
      if (locations.length === 0) return;
      await request('POST', `${slugPath(slug)}/update-embeddings`, { adds: [], deletes: locations });
      await request('DELETE', '/v1/system/remove-documents', { names: locations });
    },
    async workspaceDocuments(slug) {
      const data = (await request('GET', slugPath(slug))) as { workspace?: unknown } | null;
      // Upstream answers { workspace: [ws] } from findMany.
      const ws = (Array.isArray(data?.workspace) ? data.workspace[0] : data?.workspace) as
        { documents?: { docpath?: string; docId?: string }[] } | undefined;
      if (!ws) throw new Error(`workspace ${slug} not found`);
      const out = new Map<string, string>();
      for (const d of ws.documents ?? []) if (d.docpath) out.set(d.docpath, d.docId ?? '');
      return out;
    },
    async uploadForText(filePath) {
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
      const data = (await request('POST', '/v1/document/upload', undefined, form)) as {
        success?: boolean;
        error?: string;
        documents?: { location?: string; pageContent?: string }[];
      } | null;
      if (data?.success === false) throw new Error(`upload of ${path.basename(filePath)} failed: ${data.error}`);
      const docs = data?.documents ?? [];
      return {
        text: docs.map((d) => d.pageContent ?? '').join('\n\n'),
        locations: docs.map((d) => d.location).filter((l): l is string => !!l),
      };
    },
    async purgeDocuments(locations) {
      if (locations.length === 0) return;
      await request('DELETE', '/v1/system/remove-documents', { names: locations });
    },
  };
}
