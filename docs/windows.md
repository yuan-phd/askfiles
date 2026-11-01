# AskFiles on Windows

Phase 5 of docs/plan.md. Windows 10 and 11, x64. Built and smoke tested on the GitHub windows-latest runner (.github/workflows/windows.yml); there is no Windows test machine, so anything the runner cannot show is listed under Known limits as unverified.

## Install

Two downloads, the same app:

- **AskFiles-<version>-x64-setup.exe**, the installer. Double-click it. It installs for the current user only, into `%LOCALAPPDATA%\Programs\AskFiles`, without an administrator password or a UAC prompt, adds AskFiles to the Start menu and the desktop, and opens AskFiles when it is done. To remove it: Settings > Apps > Installed apps > AskFiles > Uninstall.
- **AskFiles-<version>-x64-portable.zip**, for people who cannot run installers. Right-click > Extract All to any folder, then open `AskFiles.exe` in it. Nothing is added to the Start menu. The portable copy keeps its library and models in the same place as the installed app (Data locations below), so the two share one library.

The download is large (about 1.2 to 1.6 GB, the job summary of each workflow run gives the exact size) because it carries the search engine, the model engine with its NVIDIA runtime and the reading tools. Models are downloaded on the first launch, a few more gigabytes depending on the machine's memory.

Silent install, for scripts and IT: `AskFiles-<version>-x64-setup.exe /S`. The smoke job installs this way.

## SmartScreen

AskFiles is not code signed yet (docs/plan.md, phase 5, Signing: a certificate or Azure Trusted Signing is the owner's decision). Windows therefore warns the first time:

1. The browser may say the file "isn't commonly downloaded". Choose **Keep** (Edge: the three dots next to the download, then Keep, then Show more, Keep anyway).
2. When the installer or AskFiles.exe starts, a blue window says **Windows protected your PC**. Click **More info**, check that the app is AskFiles-<version>-x64-setup.exe, then click **Run anyway**.

No administrator rights are needed for either step. The warning comes back for each new version until the app is signed and has a reputation. Windows Firewall does not ask anything: every part of AskFiles listens on 127.0.0.1 only, which the smoke job checks with netstat.

## First launch

What the user sees, in order:

1. A window titled AskFiles with the setup page: it checks the computer's memory and picks the matching tier (the same tiers and pinned models as on the Mac, config/presets.json).
2. The models download, with a progress bar per model (one chat model, the bge-m3 embedder). This takes from a few minutes to much longer on a slow connection; the window can stay open in the background. The 16 GB tier's model is checked against its pinned sha256 after the download, as on the Mac.
3. The empty All files library with one sentence and the Add button. Add files or a folder; they are read and indexed in the background, then questions can be asked on the Ask page.

Closing the window quits AskFiles and stops its background processes (the search server, the reading collector and Ollama with its model runners). Nothing keeps running in the notification area.

Memory tier on Windows: Windows reports the memory left after the firmware and the graphics chip take their share, so a 16 GB PC shows about 15.2 to 15.9 GB. The tiers follow the installed size, as on the Mac, so AskFiles reads it from the memory modules (Win32_PhysicalMemory) and falls back to the reported size when that fails; main.log records both (`RAM 16.0 GiB installed, 15.7 GiB usable; the tier follows the installed size`).

## Data locations

| What | Where |
| --- | --- |
| The app | `%LOCALAPPDATA%\Programs\AskFiles` (installer), or the folder the zip was extracted to |
| Library, index, search database, settings | `%LOCALAPPDATA%\AskFiles` (shell.json, libraries\, storage\, server\.env) |
| Models | `%LOCALAPPDATA%\AskFiles\ollama` (Ollama's OLLAMA_MODELS), `%LOCALAPPDATA%\AskFiles\models\reranker` and the OCR language data in `%LOCALAPPDATA%\AskFiles\storage\models\tesseract` |
| Logs | `%LOCALAPPDATA%\AskFiles\logs` (main.log, manager.log, ollama.log, collector.log, server.log, migrate.log) |
| Ports while running | `%LOCALAPPDATA%\AskFiles\ports.json`, removed on quit |

`%LOCALAPPDATA%` is usually `C:\Users\<name>\AppData\Local`; type it into the File Explorer address bar to open it. Local rather than the roaming AppData that Electron uses by default: a roaming profile copies its folder between machines at every sign-in, and gigabytes of models and an index of this machine's files do not belong there.

Uninstalling removes the app but keeps `%LOCALAPPDATA%\AskFiles`, so a reinstall finds the library and the models again. Delete that folder by hand to remove everything.

## What the build does

`npm run package:win`, on Windows only, under Git Bash (the workflow sets npm's script shell to it):

1. `PACKAGE_TARGET=win-x64 bash scripts/build.sh`: patches, frontend, the production installs of server and collector on this machine (so every native module gets its Windows prebuild), `prisma generate` (the Windows query engine), then only the Windows Prisma engines are kept (query_engine-windows.dll.node, schema-engine-windows.exe) and scripts/prune.mjs prunes for win32-x64: ELF and Mach-O files go, and of the PE files only x64 ones and 32-bit executables stay (a 32-bit DLL cannot load into the 64-bit app).
2. THIRD-PARTY-NOTICES regenerated from the pruned Windows trees and its test.
3. electron-builder: the NSIS installer and the zip. The shell is packed in app.asar, which keeps its own paths short; server, collector and Ollama are plain folders in resources, as on the Mac (native modules and engines load from real paths).

Ollama: the workflow downloads ollama-windows-amd64.zip of the pinned release (v0.40.4, published 2026-10-12, the version the Mac build ships), checks its sha256 (from the release's asset digest), unpacks it into resources/ollama and runs `node scripts/lib/ollama-runtimes.mjs resources/ollama --keep cuda_v12`. The package holds ollama.exe, the CPU libraries (always kept), and the GPU runtimes cuda_v12 (1.1 GB), cuda_v13 (634 MB) and vulkan (43 MB); ROCm, the AMD runtime, is a separate download that the build never fetches. Only cuda_v12 is kept: CUDA 12 runs on older NVIDIA drivers and cards than CUDA 13, and two CUDA generations would bring the installer near NSIS's 2 GB limit. The kept set is OLLAMA_WINDOWS_KEEP in the workflow.

After packaging, `node scripts/check-windows-package.mjs release/win-unpacked` writes a report into the job summary and fails the job on a problem:

- each native module has its win32-x64 binary and loads under the packaged AskFiles.exe run as Node: @lancedb/lancedb, onnxruntime-node (server and collector), sharp 0.33.5 (collector) and 0.32.6 (server), the Prisma query engine, the Prisma schema engine, ripgrep, @napi-rs/canvas (shell) and ollama.exe. canvas 3.2.1 has a win32-x64 prebuild (release asset canvas-v3.2.1-napi-v7-win32-x64.tar.gz) but scripts/prune.mjs removes it as unused, so it is reported as not shipped;
- every PE file under resources is x64 or a 32-bit executable;
- the longest path, installed under a 20 character user name (`C:\Users\uuuuuuuuuuuuuuuuuuuu\AppData\Local\Programs\AskFiles\`), stays under 260 characters.

Building by hand on a Windows machine: Node 22, Git for Windows, `npm install -g yarn@1.22.22`, `git config --global core.autocrlf false` before cloning (the patches are LF diffs), `npm config set script-shell "C:\Program Files\Git\bin\bash.exe"`, unpack and trim Ollama as above, then `npm ci` and `npm run package:win`. The output is in release/.

## Smoke test

The smoke job (scripts/smoke-windows.mjs) on a fresh windows-latest runner:

1. installs the setup.exe with /S and finds AskFiles.exe in `%LOCALAPPDATA%\Programs\AskFiles`, checking that the install has no ROCm runtime;
2. launches it on an empty `%LOCALAPPDATA%\AskFiles` (only the cached test models kept) with the smoke preset and a folder holding test/fixtures/handbook.pdf;
3. waits for `%LOCALAPPDATA%\AskFiles\ports.json`, checks with netstat that Ollama, collector and server listen on 127.0.0.1 only, waits for the first run and the Ask page, and checks the server API with the stored key (/api/ping, the library workspace);
4. waits for the handbook to be indexed and for the app's one answer through the pipeline (ASKFILES_SMOKE_QUESTION), and asserts it found an answer citing [1];
5. closes the window the way a user does (taskkill without /F sends WM_CLOSE) and checks that within 60 s no process whose executable lies in the install folder is left, ollama.exe and its runners included, and that ports.json is gone.

The handbook goes in through the app's own folder link, not through the server's document upload: the answer pipeline answers from the shell's section index, and a document uploaded to the server would sit in the library workspace without it (docs/upstream-analysis.md, risk on mixing collector uploads into the library workspace).

## Known limits

- **NVIDIA GPU: unverified.** The runner has no GPU, so only the CPU path has run. With an NVIDIA card and a current driver Ollama should use cuda_v12; ollama.log names the library it loaded.
- **AMD and Intel GPUs**: not used. ROCm is not shipped and the Vulkan runtime is removed, so these machines answer on the CPU, which is slower.
- **Windows on ARM**: not built. The x64 app should run under emulation (Prism) on Windows 11 ARM; not checked. Planned as a LOCAL check in a Windows 11 ARM virtual machine on the Mac (docs/plan.md, phase 5).
- **SmartScreen** warns on every new version until the app is signed (above).
- **Path length**: the build checks the longest installed path for a 20 character user name. A user who installs into a deeper folder by hand (the portable zip) could still exceed 260 characters; the app itself reads its files through Node, which handles long paths, but Explorer and some tools do not.
- **Force quit**: ending AskFiles.exe in Task Manager with End task on the main process leaves its children running (the same open point as on the Mac, docs/process-manager.md); End process tree, or the next sign-out, clears them.
- **Not observed on a real machine**: the SmartScreen texts above follow Microsoft's current wording and were not seen on this build; the first launch, the window and the Start menu entry have only been run on the CI runner.
