# Presets, first-run wizard and model manager

Session E, plan tasks 1.4, 1.5 and 1.6. Code in src/main/presets, src/main/wizard, src/main/models, src/main/ollama; pages in src/renderer/onboarding and src/renderer/models.

## config/presets.json

One entry per RAM tier. The values are the v1 result of phase 2 (docs/plan.md, v1 result), measured on the owner's Mac or fixed by the plan; each tier's comment says where its values come from. The validator (src/main/presets/schema.ts) checks every field.

chatModel is null on a tier with Ask off (8 GB, owner decision 2026-11-01): the wizard pulls only the embedder, the server .env names no OLLAMA_MODEL_PREF, the Ask page shows one line (Ask needs a Mac with 16 GB of memory or more; on this Mac use Browse and Find to read your documents.) with the question box disabled, the answer pipeline refuses, and Settings offers no Faster model on the tier above. Browse and Find are unchanged.

chatModelFile pins a chat model pulled from Hugging Face: repository, revision, file, sha256 and sizeBytes of the GGUF file measured in phase 2, with chatModel hf.co/<repository>:<quant>. Ollama pulls the repository's current file and cannot ask for a revision, so the pin is a check: after the pull, and also when the model was installed before, the wizard reads the weights blob from POST /api/show (the modelfile's FROM line names blobs/sha256-<hex>) and refuses the model unless its sha256 is the pinned one (src/main/models/pinned.ts, PinnedModelError). Settings does the same when Faster switches a 32 GB Mac to the 16 GB model. A repository that replaces the file therefore stops setup with a message naming the expected file instead of installing a different model.

| Field | 8 GB | 16 GB | 32 GB and above | Source |
| --- | --- | --- | --- | --- |
| minRamGb | 8 | 16 | 32 | Plan tiers |
| chatModel | null (Ask off) | hf.co/unsloth/Qwen3-14B-GGUF:Q3_K_M, chatModelFile Qwen3-14B-Q3_K_M.gguf at revision a04a82c4739b3ef5fa6da7d10261db2c67dd1985, sha256 9694f1db203d5a18bea6f19a36be01b2d2c79bf9b7f8df553a4cc5cff870b47e, 7321313664 bytes | qwen3:14b-q4_K_M (Ollama library) | Owner decision 2026-11-01 from the quantization and context matrix and the tuning rounds (docs/plan.md, v1 result); was 4B, 8B, 14B class Q4 (owner choice 2026-10-29) |
| embeddingModel | bge-m3:567m | same | same | Q10 |
| contextLength (OLLAMA_MODEL_TOKEN_LIMIT) | 8192 | 8192 | 8192 | Quantization and context matrix (docs/plan.md): 4096 cuts the section budget and cost 6 points of right section cited |
| chunkMaxChars (EMBEDDING_MODEL_MAX_CHUNK_LENGTH) | 2000 | 2000 | 2000 | Plan phase 2 chunk maximum |
| maxSnippets (topN) | 4 | 4 | 4 | Plan phase 2 |
| similarityThreshold | 0.5 | 0.5 | 0.5 | Plan phase 2 Medium; upstream's Medium option is 0.5 (upstream/frontend/src/pages/WorkspaceSettings/VectorDatabase/DocumentSimilarityThreshold/index.jsx:25) |
| chatMode | query | query | query | Plan decision |
| temperature | 0.1 | 0.1 | 0.1 | Plan phase 2 |
| reasoningEffort | off | off | off | Plan phase 2, Session C patch 7 |
| ocrLanguages (TARGET_OCR_LANG) | eng,chi_sim | same | same | Q7, Q14 |
| systemPrompt | Answer only from the provided context. Cite the source document for what you say. If the context does not contain the answer, say that you do not know. | same | same | Plan phase 2 wording |

Chat model candidates found on 2026-10-29 (download size from registry.ollama.ai manifests): 4B class qwen3:4b 2.50 GB, qwen3.5:4b 3.32 GB; 8B class qwen2.5:7b 4.68 GB, qwen3:8b 5.23 GB, qwen3.5:9b 6.55 GB; 14B class qwen2.5:14b 8.99 GB, qwen3:14b 9.28 GB. bge-m3:567m is 1.16 GB.

## Tier matching

Total RAM in GiB (os.totalmem() / 1024^3; a 16 GB Mac reports exactly 17179869184 bytes). The machine gets the highest tier whose minRamGb is not above its RAM. Below the lowest tier it still gets the lowest tier, flagged belowMinimum so the onboarding page can warn. Boundaries: 7.9 gets 8 GB (flagged), 8 and 15.9 get 8 GB, 16 gets 16 GB, 32 and 64 get 32 GB.

## Where each setting goes

| Setting | Path | When |
| --- | --- | --- |
| LLM_PROVIDER=ollama, OLLAMA_MODEL_PREF, OLLAMA_MODEL_TOKEN_LIMIT, EMBEDDING_ENGINE=ollama, EMBEDDING_MODEL_PREF, EMBEDDING_MODEL_MAX_CHUNK_LENGTH, VECTOR_DB=lancedb, DISABLE_TELEMETRY=true, TARGET_OCR_LANG | server .env (presetEnv) | Wizard step writeConfig, before the server restart |
| OLLAMA_BASE_PATH, EMBEDDING_BASE_PATH | server .env with the first-run URL; the process manager passes the current URL in the spawn environment at every start, which wins | Same |
| DEFAULT_REASONING_EFFORT=off | server .env and the server's spawn environment (presetSpawnEnv) | .env at writeConfig; spawn env at every start. Upstream dumpENV rewrites .env from an allow list on any settings change and that list does not contain this key (upstream/server/utils/helpers/updateENV.js, dumpENV), so the file alone would lose it. A test fails if the preset gains another key dumpENV drops |
| Onboarding complete | Upstream sets system_settings onboarding_complete at boot because LLM_PROVIDER and VECTOR_DB are set (Q5); the wizard also calls POST /api/onboarding and checks GET /api/onboarding | Wizard step markOnboarded, after the server restart |
| chatMode, similarityThreshold, topN, openAiTemp, openAiPrompt | Library workspace columns through POST /api/v1/workspace/new or /api/v1/workspace/{slug}/update (workspaceSettings) | markOnboarded calls deps.applyWorkspaceSettings when given; the library setup must also pass them when it creates the workspace |
| chunkMaxChars | The shell's section splitter (folder watcher, Session F) and EMBEDDING_MODEL_MAX_CHUNK_LENGTH; upstream's chunk size defaults to that limit (upstream/server/utils/TextSplitter/index.js:47-57), so a section up to this size stays one chunk | Splitter reads it from the preset |

The 16 GB .env, byte for byte, is in src/main/presets/__fixtures__/server-16gb.env (secrets replaced by test values).

Writes keep every other line of the file, secrets included. A key that appears twice (dumpENV output plus ours) is replaced in place and the later copy dropped. The file is written through a temporary file and a rename, mode 0600.

## Wizard

```
idle -> detectRam -> chooseTier -> pullModels -> writeConfig -> markOnboarded -> done
any step --fails--> error --retry()--> retry -> the step that failed
```

- detectRam: os.totalmem, or the totalMemBytes override.
- chooseTier: emits a tier event (RAM, tier, models, belowMinimum).
- pullModels: embedder first, then chat model, through POST /api/pull with streaming. Models already in /api/tags are skipped, so a retry does not download a finished model again. Progress events carry model, index, count, status, completedBytes, totalBytes and percent. Percent never goes back and is 100 only after Ollama reports success.
- writeConfig: merges presetEnv into the server .env; creates the file with fresh secrets if the process manager has not written it.
- markOnboarded: deps.restartServer() (with the Session C manager: stop() then start(), because start() reads the .env), then the onboarding calls, then deps.applyWorkspaceSettings.

start() and retry() never reject; they resolve with a snapshot whose state is done or error. Events go to the onboarding page through the bridge described at the top of src/renderer/onboarding/onboarding.js.

## Model manager

ModelManager lists installed models (GET /api/tags) with their role from the server .env, pulls by tag with progress, deletes (DELETE /api/delete) and switches the chat model (OLLAMA_MODEL_PREF in .env, then restartServer). It refuses to delete the active chat or embedding model and refuses a chat model whose /api/show capabilities lack completion. Switching the embedder is not offered: it needs a full re-index (Q10). The page's bridge is described at the top of src/renderer/models/models.js.

## Not done here

- Electron wiring (LOCAL): a preload script exposing window.askfiles.wizard and window.askfiles.models over IPC, src/main/index.ts starting the process manager, running the wizard when GET /api/onboarding is false, passing presetSpawnEnv in the server spec env, and loading the onboarding page. Not written because none of it can run in a cloud session.
- Visual pass on the onboarding and models pages (LOCAL, plan task 3.6). Both pages take their tokens from src/renderer/ask/ask.css.
