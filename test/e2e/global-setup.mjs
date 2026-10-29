// Starts the page server and, when Ollama has the test models, a real upstream seeded with the
// handbook fixture. Results reach the specs through environment variables.
import { readFile } from "node:fs/promises";
import { createClient, generateApiKey, REFUSAL_TEXT } from "../../src/renderer/api/client.js";
import { startStaticServer } from "./static-server.mjs";
import { startUpstream, ollamaAvailable, CHAT_MODEL, EMBED_MODEL } from "./upstream.mjs";
import { buildPdf } from "../fixtures/make-handbook-pdf.mjs";

const OLLAMA_URL = process.env.OLLAMA_HOST_URL || "http://127.0.0.1:11434";

export default async function globalSetup() {
  const page = await startStaticServer();
  process.env.ASKFILES_PAGE_URL = page.url;
  const stops = [page.stop];

  if (!(await ollamaAvailable(OLLAMA_URL))) {
    process.env.ASKFILES_UPSTREAM_SKIP = `Ollama at ${OLLAMA_URL} is not reachable or lacks ${CHAT_MODEL} and ${EMBED_MODEL}; real-server test skipped, mocked tests still run`;
    console.log(`[e2e] ${process.env.ASKFILES_UPSTREAM_SKIP}`);
  } else {
    try {
      const upstream = await startUpstream({ ollamaUrl: OLLAMA_URL });
      stops.push(upstream.stop);
      const apiKey = await generateApiKey({ baseUrl: upstream.baseUrl, name: "askfiles-e2e" });
      const client = createClient({ baseUrl: upstream.baseUrl, apiKey });
      // Unique name because the upstream SQLite file is shared across runs (see upstream.mjs).
      const ws = await client.createWorkspace(`askfiles-e2e-${Date.now()}`, {
        chatMode: "query",
        queryRefusalResponse: REFUSAL_TEXT,
        openAiTemp: 0.1,
      });
      const pdf = await readFile(new URL("../fixtures/handbook.pdf", import.meta.url)).catch(() => buildPdf());
      const docs = await client.uploadDocument(new Blob([pdf], { type: "application/pdf" }), {
        filename: "handbook.pdf",
        addToWorkspaces: [ws.slug],
      });
      const embedded = await client.getWorkspace(ws.slug);
      if (!embedded?.documents?.length) throw new Error("fixture uploaded but not embedded into the workspace");
      console.log(`[e2e] seeded workspace ${ws.slug} with ${docs.map((d) => d.title).join(", ")}`);
      Object.assign(process.env, {
        ASKFILES_UPSTREAM_URL: upstream.baseUrl,
        ASKFILES_API_KEY: apiKey,
        ASKFILES_WORKSPACE: ws.slug,
      });
    } catch (e) {
      process.env.ASKFILES_UPSTREAM_SKIP = `upstream could not be started or seeded: ${e.message}`;
      console.log(`[e2e] ${process.env.ASKFILES_UPSTREAM_SKIP}`);
    }
  }

  return async () => {
    for (const stop of stops.reverse()) await stop();
  };
}
