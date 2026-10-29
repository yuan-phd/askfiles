// Starts the page server and, when Ollama and the upstream packages are present, a real upstream
// with two seeded workspaces. Results reach the specs through environment variables.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createClient, generateApiKey, REFUSAL_TEXT } from '../../src/renderer/api/client.js';
import { startStaticServer } from './static-server.mjs';
import { startUpstream, skipReason } from './upstream.mjs';
import { SECTION_DOCS } from '../fixtures/handbook-sections.mjs';

const WORKSPACE_SETTINGS = { chatMode: 'query', queryRefusalResponse: REFUSAL_TEXT, openAiTemp: 0.1 };

/**
 * Writes one document JSON per section into STORAGE_DIR/documents/askfiles and returns their
 * paths for update-embeddings: route (b2) of docs/upstream-analysis.md Q13, the one the folder
 * watcher will use, so sectionTitle, sectionIndex, pageStart and pageEnd reach the chat sources.
 */
function writeSectionDocs(storageDir: string): string[] {
  const folder = path.join(storageDir, 'documents', 'askfiles');
  mkdirSync(folder, { recursive: true });
  const published = new Date().toLocaleString();
  return SECTION_DOCS.map((s: { name: string; text: string; [key: string]: unknown }) => {
    const { name, text, ...section } = s;
    const doc = {
      id: randomUUID(),
      url: 'file:///Users/test/Documents/Handbook/handbook.pdf',
      title: 'handbook.pdf',
      docAuthor: 'Northwind',
      description: 'Employee handbook',
      docSource: 'askfiles section split',
      chunkSource: '',
      published,
      wordCount: text.split(/\s+/).length,
      token_count_estimate: Math.ceil(text.length / 4),
      pageContent: text,
      ...section,
    };
    writeFileSync(path.join(folder, `${name}.json`), JSON.stringify(doc));
    return `askfiles/${name}.json`;
  });
}

export default async function globalSetup() {
  const page = await startStaticServer();
  process.env.ASKFILES_PAGE_URL = page.url;
  const stops = [page.stop];
  const teardown = async () => {
    for (const stop of stops.reverse()) await stop();
  };

  const reason = skipReason();
  if (reason) {
    process.env.ASKFILES_UPSTREAM_SKIP = `${reason}; real-server tests skipped, mocked tests still run`;
    console.log(`[e2e] ${process.env.ASKFILES_UPSTREAM_SKIP}`);
    return teardown;
  }
  try {
    const upstream = await startUpstream({ allowedOrigins: [page.url] });
    stops.push(upstream.stop);
    const apiKey = await generateApiKey({ baseUrl: upstream.baseUrl, name: 'askfiles-e2e' });
    const client = createClient({ baseUrl: upstream.baseUrl, apiKey });

    // Collector uploads and section documents go to separate workspaces: LanceDB fixes a table's
    // columns from its first rows and would drop the section keys (upstream-analysis Q13).
    const pdfWs = await client.createWorkspace('askfiles-e2e-pdf', WORKSPACE_SETTINGS);
    const pdf = readFileSync(new URL('../fixtures/handbook.pdf', import.meta.url));
    await client.uploadDocument(new Blob([pdf], { type: 'application/pdf' }), {
      filename: 'handbook.pdf',
      addToWorkspaces: [pdfWs.slug],
    });
    const sectionWs = await client.createWorkspace('askfiles-e2e-sections', WORKSPACE_SETTINGS);
    await client.embedDocuments(sectionWs.slug, { adds: writeSectionDocs(upstream.storageDir) });

    for (const ws of [pdfWs, sectionWs]) {
      const n = (await client.getWorkspace(ws.slug))?.documents?.length ?? 0;
      if (!n) throw new Error(`nothing was embedded into ${ws.slug}`);
      console.log(`[e2e] seeded ${ws.slug} with ${n} document(s)`);
    }
    Object.assign(process.env, {
      ASKFILES_UPSTREAM_URL: upstream.baseUrl,
      ASKFILES_API_KEY: apiKey,
      ASKFILES_PDF_WORKSPACE: pdfWs.slug,
      ASKFILES_SECTION_WORKSPACE: sectionWs.slug,
    });
  } catch (e) {
    process.env.ASKFILES_UPSTREAM_SKIP = `upstream could not be started or seeded: ${(e as Error).message}`;
    console.log(`[e2e] ${process.env.ASKFILES_UPSTREAM_SKIP}`);
  }
  return teardown;
}
