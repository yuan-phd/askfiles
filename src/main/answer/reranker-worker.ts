// Child process that runs the cross-encoder (reranker.ts, rerankerProcess). onnxruntime-node runs a
// model call on the calling thread, so in the Electron main process a rerank would freeze the
// window and IPC for seconds; here it blocks only this process. Started with ELECTRON_RUN_AS_NODE
// in the app and plain node in the eval and tests. Settings come in the environment.
import { crossEncoder } from './reranker.js';

interface Request {
  id: number;
  query: string;
  texts: string[];
}

const reranker = crossEncoder({
  transformersDir: process.env.ASKFILES_RERANKER_TRANSFORMERS ?? '',
  modelsDir: process.env.ASKFILES_RERANKER_MODELS ?? '',
  repo: process.env.ASKFILES_RERANKER_REPO ?? '',
  log: (m) => console.log(m),
});

process.on('message', (msg: Request) => {
  reranker.score(msg.query, msg.texts).then(
    (scores) => process.send?.({ id: msg.id, scores }),
    (e: Error) => process.send?.({ id: msg.id, error: e.message }),
  );
});
// The parent going away closes the channel; nothing is left to answer.
process.on('disconnect', () => process.exit(0));
