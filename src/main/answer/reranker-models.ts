/**
 * The cross-encoders a preset may name, pinned to one Hugging Face revision with the size and
 * sha256 of every file the shell loads. The first-run wizard downloads the preset's model into
 * <dataDir>/models/reranker/<repo>; nothing is ever fetched while answering a question.
 * Measured in docs/plan.md (Answer pipeline, reranker choice).
 */

export interface RerankerFile {
  path: string;
  size: number;
  sha256: string;
}

export interface RerankerModel {
  repo: string;
  revision: string;
  /** Short name for logs and the wizard's progress line. */
  label: string;
  /** Languages it scores well; an English-only model needs rerankerBypassCjk. */
  multilingual: boolean;
  files: RerankerFile[];
}

export const RERANKER_MODELS: Record<string, RerankerModel> = {
  'Xenova/ms-marco-MiniLM-L-6-v2': {
    repo: 'Xenova/ms-marco-MiniLM-L-6-v2',
    revision: 'a09144355adeed5f58c8ed011d209bf8ee5a1fec',
    label: 'ms-marco-MiniLM-L-6-v2',
    multilingual: false,
    files: [
      { path: 'config.json', size: 824, sha256: 'd827779a72d27ae68cf878a6fc2e954542663fe21ca515d9f4783fc96be2d37e' },
      {
        path: 'special_tokens_map.json',
        size: 125,
        sha256: 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
      },
      {
        path: 'tokenizer.json',
        size: 711396,
        sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
      },
      {
        path: 'tokenizer_config.json',
        size: 1242,
        sha256: '0b29c7bfc889e53b36d9dd3e686dd4300f6525110eaa98c76a5dafceb2029f53',
      },
      {
        path: 'onnx/model_quantized.onnx',
        size: 23143499,
        sha256: 'e9d8ebf845c413e981c175bfe49a3bfa9b3dcce2a3ba54875ee5df5a58639fbe',
      },
    ],
  },
  'Xenova/bge-reranker-base': {
    repo: 'Xenova/bge-reranker-base',
    revision: '280bcc27a84e0b898c251e06fddb25171bd9b101',
    label: 'bge-reranker-base',
    multilingual: true,
    files: [
      { path: 'config.json', size: 782, sha256: 'b6575b9d5be20d6747417c8e20c5a0db1636356e0b6d422d7244c628423c4d4c' },
      {
        path: 'special_tokens_map.json',
        size: 279,
        sha256: 'd5469a60db23249c7f8945013d78df30b44b6bf686c6bb4740f4223f77b1b535',
      },
      {
        path: 'tokenizer.json',
        size: 17098079,
        sha256: '48564c5c7d3fa64d85d95e65414a542385f88b0f128fd8d4163fd7a57f2be05c',
      },
      {
        path: 'tokenizer_config.json',
        size: 443,
        sha256: 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
      },
      {
        path: 'onnx/model_quantized.onnx',
        size: 279301077,
        sha256: 'dd98f3e67837d23210a6b7550c08cced4f61845b940ac45be3565840a10f3244',
      },
    ],
  },
  'onnx-community/bge-reranker-v2-m3-ONNX': {
    repo: 'onnx-community/bge-reranker-v2-m3-ONNX',
    revision: '6f5ff65298512715a1e669753bc754d2bc8f367b',
    label: 'bge-reranker-v2-m3',
    multilingual: true,
    files: [
      { path: 'config.json', size: 848, sha256: '122e922dcfed6503c8721e6fe1daf090340c3d95ca7f3aa3a72730b321a51cfd' },
      {
        path: 'special_tokens_map.json',
        size: 964,
        sha256: '8c785abebea9ae3257b61681b4e6fd8365ceafde980c21970d001e834cf10835',
      },
      {
        path: 'tokenizer.json',
        size: 17082900,
        sha256: '8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3',
      },
      {
        path: 'tokenizer_config.json',
        size: 1203,
        sha256: 'b87c8703482b0300d3da30e201519aa641f6a450f5eb5bf1e624afbf70c74d80',
      },
      {
        path: 'onnx/model_quantized.onnx',
        size: 570727094,
        sha256: '912fc1215c2dbff6499700534bd8d31253af01573861abbfc43afd1fab6cce5d',
      },
    ],
  },
};

export function rerankerModel(repo: string): RerankerModel {
  const m = RERANKER_MODELS[repo];
  if (!m) throw new Error(`unknown reranker ${repo}; known: ${Object.keys(RERANKER_MODELS).join(', ')}`);
  return m;
}

export function rerankerBytes(m: RerankerModel): number {
  return m.files.reduce((a, f) => a + f.size, 0);
}
