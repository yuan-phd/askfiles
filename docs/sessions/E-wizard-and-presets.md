# Session E: first-run wizard, presets and model manager (plan tasks 1.4, 1.5, 1.6)

Executor: CLOUD for the logic and tests; the visual run happens LOCAL
Dependencies: Session A merged (Q5, Q7, Q10 are inputs). Session C merged is helpful but not required; if absent, code against the process manager interface described in docs/sessions/C-process-manager.md.
Branch: session/e-wizard-presets
PR title: [Session E] First-run wizard, preset generator and model manager

## Goal

Make the first launch decide everything for the user: detect RAM, pick a tier, download the models, write the server configuration, mark onboarding as done. Then give the shell a model manager page for later changes.

## Deliverables

1. config/presets.json: one entry per tier with chat model tag, embedding model tag, context length, max snippets, similarity threshold, chat mode, temperature, system prompt. Tiers: 8 GB, 16 GB, 32 GB and above. Fill the values from docs/upstream-analysis.md Q7 and Q10 and from docs/plan.md phase 2 starting values. Mark every value as starting value in a comment field; phase 2 replaces them.
2. src/main/presets/: a loader with schema validation, a tier chooser from total RAM (os.totalmem with an override for tests), and a generator that turns a preset into the exact server/.env lines (variable names from Q7) plus any workspace-level settings that cannot be set by env and must be written through the API or the database after the server starts (from Q5 and Q7). Document which path each setting takes.
3. src/main/wizard/: a state machine with steps detectRam, chooseTier, pullModels, writeConfig, markOnboarded, done, plus error and retry states. Model pulls run through the Ollama HTTP API (POST /api/pull with streaming progress), not the CLI, so progress can be shown. Expose progress events with bytes and percent.
4. src/renderer/onboarding/: a plain HTML page that shows the steps, the progress bar, and a single retry button on failure. Reads events from a small bridge object; in tests, from a stub.
5. src/renderer/models/ and src/main/models/: list installed models, pull a model by tag, delete a model, switch the active chat model and restart the server. All through the Ollama HTTP API.
6. Unit tests: tier mapping at the boundaries (7.9, 8, 15.9, 16, 32, 64 GB), preset validation failures, .env generation byte for byte, state machine transitions including retry after a failed pull.
7. Integration test (RUN_INTEGRATION=1, Ollama present): pull all-minilm through the wizard code path, assert the progress events reach 100 percent and the model appears in /api/tags.

## Do not

- Do not pick product model tags by guesswork. Take them from Q10 and the plan; where the report leaves a choice open, list the candidates in the PR and pick the smallest for now.
- Do not open any GUI. The onboarding page is tested with a stubbed bridge.
- Do not edit upstream/.

## Acceptance

- npm test green; integration test green or skipped with the printed reason.
- The generated .env matches the variable names in Q7 exactly; include a test fixture showing the full file for the 16 GB tier.
- PR opened with the list of open choices for the owner.
