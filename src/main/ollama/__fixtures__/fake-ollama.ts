import http from 'node:http';

export interface FakeModel {
  name: string;
  size: number;
  capabilities?: string[];
}

export interface FakeOllamaOptions {
  installed?: FakeModel[];
  /** Layers each pull reports, in bytes. */
  layers?: number[];
  /** Pull of these tags answers with an error line after the first layer. */
  failPull?: Set<string>;
  /** Also serve the two upstream onboarding routes, as if this were the upstream server. */
  onboarding?: boolean;
}

export interface FakeOllama {
  url: string;
  installed: FakeModel[];
  pulls: string[];
  deletes: string[];
  onboardingPosts: number;
  options: FakeOllamaOptions;
  close(): Promise<void>;
}

/** A small HTTP stand-in for the Ollama routes the shell uses, streaming NDJSON like the real one. */
export async function startFakeOllama(options: FakeOllamaOptions = {}): Promise<FakeOllama> {
  const state: FakeOllama = {
    url: '',
    installed: [...(options.installed ?? [])],
    pulls: [],
    deletes: [],
    onboardingPosts: 0,
    options,
    close: () => new Promise((r) => server.close(() => r())),
  };
  let onboarded = false;

  const readJson = (req: http.IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let s = '';
      req.on('data', (d) => (s += d));
      req.on('end', () => resolve(s ? JSON.parse(s) : {}));
    });
  const send = (res: http.ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

  const server = http.createServer(async (req, res) => {
    const route = `${req.method} ${req.url}`;
    if (route === 'GET /api/tags') {
      return send(res, 200, {
        models: state.installed.map((m) => ({ name: m.name, size: m.size, digest: 'd-' + m.name, modified_at: 'x' })),
      });
    }
    if (route === 'POST /api/pull') {
      const body = await readJson(req);
      const tag = String(body.model);
      state.pulls.push(tag);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
      const layers = options.layers ?? [1000, 10];
      for (const [i, total] of layers.entries()) {
        const digest = `sha256:${i}`;
        // Split one line across two writes to exercise the line buffer.
        const half = JSON.stringify({ status: `pulling ${digest}`, digest, total, completed: total / 2 }) + '\n';
        res.write(half.slice(0, 10));
        res.write(half.slice(10));
        if (options.failPull?.has(tag)) {
          res.end(JSON.stringify({ error: 'connection reset by peer' }) + '\n');
          return;
        }
        res.write(JSON.stringify({ status: `pulling ${digest}`, digest, total, completed: total }) + '\n');
      }
      state.installed.push({
        name: tag.includes(':') ? tag : `${tag}:latest`,
        size: layers.reduce((a, b) => a + b, 0),
      });
      res.write(JSON.stringify({ status: 'verifying sha256 digest' }) + '\n');
      res.end(JSON.stringify({ status: 'success' }));
      return;
    }
    if (route === 'DELETE /api/delete') {
      const tag = String((await readJson(req)).model);
      const i = state.installed.findIndex((m) => m.name === tag);
      if (i < 0) return send(res, 404, { error: `model '${tag}' not found` });
      state.installed.splice(i, 1);
      state.deletes.push(tag);
      return send(res, 200, {});
    }
    if (route === 'POST /api/show') {
      const tag = String((await readJson(req)).model);
      const m = state.installed.find((x) => x.name === tag);
      if (!m) return send(res, 404, { error: `model '${tag}' not found` });
      return send(res, 200, { capabilities: m.capabilities ?? ['completion'] });
    }
    if (options.onboarding && route === 'POST /api/onboarding') {
      onboarded = true;
      state.onboardingPosts += 1;
      return res.writeHead(200).end('OK');
    }
    if (options.onboarding && route === 'GET /api/onboarding') {
      return send(res, 200, { onboardingComplete: onboarded });
    }
    send(res, 404, { error: 'not found' });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  state.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return state;
}
