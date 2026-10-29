# Cloud environment settings

Create one environment at claude.ai/code (environment selector under the message box, New environment) and use it for every session of this project. Do not use Default: it cannot reach the Ollama registry and its command timeouts are too short for builds.

## Name

askfiles

## Network access

Custom. Check the box that includes the default list of common package managers, then add these lines in Allowed domains:

```
ollama.com
registry.ollama.ai
*.ollama.ai
huggingface.co
cdn-lfs.huggingface.co
*.hf.co
cdn.playwright.dev
playwright.download.prss.microsoft.com
```

Already on the default list and needed by this project: github.com, objects.githubusercontent.com, release-assets.githubusercontent.com, registry.npmjs.org, registry.yarnpkg.com, binaries.prisma.sh, *.r2.cloudflarestorage.com (Ollama model blobs).

If a session reports a refused host, add it here. The change reaches running sessions within about a minute.

## Environment variables

```
BASH_DEFAULT_TIMEOUT_MS=600000
BASH_MAX_TIMEOUT_MS=1800000
RUN_INTEGRATION=1
PUPPETEER_SKIP_DOWNLOAD=1
```

The first two raise the default and maximum timeout of commands Claude runs to 10 and 30 minutes. The third tells our test scripts that integration tests may run; they still skip with a message when Ollama is not reachable. The fourth stops puppeteer, a dependency of upstream/collector, from downloading Chromium during yarn install; the product does not use web scraping.

## Setup script

Paste the contents of cloud-env/setup-script.sh. It installs Ollama and pulls qwen3:0.6b and all-minilm as test models. These are test models only; product models are chosen in config/presets.json.

If the script runs longer than about five minutes, the environment is not cached and every session pays the full setup. If that happens, remove the qwen3 pull from the script and let sessions pull it on demand.

## Checks after creating the environment

Start a throwaway session in it and ask Claude to run:

```
check-tools
ollama list
curl -fsI https://registry.ollama.ai >/dev/null && echo registry ok
echo $BASH_DEFAULT_TIMEOUT_MS
```

Expected: Node 22 listed, two models listed, registry ok, 600000.
