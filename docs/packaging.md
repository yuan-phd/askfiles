# Packaging AskFiles on the Mac

How to turn this repository into AskFiles.app and a DMG on an Apple Silicon Mac, sign it ad-hoc, and copy it to a second Mac. Everything here is LOCAL: cloud sessions stop before step 3.

State of the app at this point (after Session F): the packaged app starts Ollama, the collector and the server from its bundle (src/main/app.ts, docs/process-manager.md), shows a starting page, then opens the upstream interface on the server's port and writes the ports to ~/Library/Application Support/AskFiles/ports.json. No model is configured yet: the first-run wizard and presets are Session E, so the interface asks for a provider until they land. ASKFILES_PORT, or {"port": N} in the file named by ASKFILES_CONFIG (default ~/Library/Application Support/AskFiles/config.json), still makes the app connect to a server started by hand instead. The CI workflow .github/workflows/mac.yml builds the same DMG and smoke tests it with scripts/smoke-mac.sh.

## What you need

- Apple Silicon Mac, macOS 14 or later, about 10 GB free disk
- Xcode Command Line Tools: `xcode-select --install` (gives git, codesign, hdiutil)
- Node 22: `node -v` prints v22.x. With Homebrew: `brew install node@22`, then follow the PATH hint it prints
- Yarn classic for the upstream packages: `npm install -g yarn`, then `yarn -v` prints 1.22.x

## Steps

### 1. Get the code and install the shell dependencies

```
git clone https://github.com/yuan-phd/askfiles.git
cd askfiles
npm install
```

npm install does not download Electron. It is fetched the first time electron-builder needs it (about 100 MB).

### 2. Put the Ollama macOS binary into resources/ollama

The app bundles Ollama from its official release archive. resources/ is not committed.

```
OLLAMA_VERSION=v0.40.4
mkdir -p resources/ollama
curl -fL -o /tmp/ollama-darwin.tgz https://github.com/ollama/ollama/releases/download/$OLLAMA_VERSION/ollama-darwin.tgz
shasum -a 256 /tmp/ollama-darwin.tgz
tar -xzf /tmp/ollama-darwin.tgz -C resources/ollama
resources/ollama/ollama --version
```

Expected: the checksum is `a4ceae4b2aaf18df37ebcbfb56ba3a37a87838631112d66c2be07268693c8d58` (measured in Session B on 2026-10-29), and the last command prints the client version 0.40.4 plus a warning that it could not connect to a running Ollama instance. That warning is fine. If the checksum differs, stop: the file is not the one pinned here.

Why v0.40.4: the rule is the newest release that is at least 14 days old. Its macOS archive was uploaded on 2026-10-14 00:52 UTC and its Docker image pushed at 00:31 UTC the same day; v0.40.5 followed on 2026-10-15 18:49 UTC, less than 14 days before 2026-10-29. The GitHub releases API was refused in the cloud session, so the dates come from the asset Last-Modified header and Docker Hub, not from the release page. To change the version later, apply the same rule and update the version and checksum here.

The archive holds 59 entries, about 550 MB unpacked: the ollama binary (universal arm64 and x86_64), llama-server, dylibs, two mlx_metal folders and the license files (docs/upstream-analysis.md Q12). Keep all of them together: the binary loads its libraries from its own folder and the licenses must ship with it. The cloud environment runs a newer Ollama (0.40.13) for tests; differences between the two versions were not checked.

### 3. Build and package

```
npm run package:mac
```

This runs, in order:

1. `tsc` for src/main into dist/main
2. `scripts/build.sh` with PACKAGE_TARGET=mac-arm64: checks resources/ollama, applies patches/, builds the upstream frontend into upstream/server/public, installs server and collector production dependencies, runs prisma generate, removes Prisma engines for every platform except darwin-arm64, checks that dev dependencies are gone, prints sizes
3. `electron-builder --mac dir --arm64`: creates release/mac-arm64/AskFiles.app without a DMG (layout below)
4. `scripts/sign-adhoc.sh`: ad-hoc signs every Mach-O file under Contents/Resources, then the whole app, then verifies with `codesign --verify --deep --strict`
5. `electron-builder --mac dmg --arm64 --prepackaged release/mac-arm64/AskFiles.app`: wraps the signed app into release/AskFiles-0.1.0-arm64.dmg

The DMG is built after signing on purpose: signing the app after the DMG exists would leave an unsigned copy inside the DMG.

Expected time: 3 to 10 minutes on first run, mostly yarn installs. Expected output at the end: release/AskFiles-0.1.0-arm64.dmg.

Notes on messages you may see:

- `skipped macOS code signing reason=identity explicitly is set to null`: expected; step 4 signs.
- In step 2, if it stops with `no query engine for darwin-arm64` or `no schema engine for darwin-arm64`, prisma generate did not download the Mac engines. Run `cd upstream/server && node node_modules/prisma/build/index.js generate` once with network access, then run step 3 again.

To sign an app by hand, for example after a manual electron-builder run: `bash scripts/sign-adhoc.sh release/mac-arm64/AskFiles.app`.

### Bundle layout

Only the shell's own code is in app.asar. Server and collector are copied as plain folders (electron-builder.yml, extraResources), because Prisma's schema engine and ripgrep are spawned as executables, the Prisma runtime cannot find its engine inside asar, and native modules load from real paths (docs/upstream-analysis.md Q1, Q2).

```
AskFiles.app/Contents/
  MacOS/AskFiles                      Electron; also runs server and collector with ELECTRON_RUN_AS_NODE=1 (Session C)
  Resources/app.asar                  package.json and dist/main
  Resources/server/                   upstream/server: code, public/ (frontend build), node_modules, prisma/
  Resources/server/storage/assets/    default logo images only; no runtime data
  Resources/collector/                upstream/collector: code and node_modules; no hotdir or storage
  Resources/ollama/                   the Ollama release archive from step 2
  Resources/licenses/                 AnythingLLM license
```

Not copied: server and collector storage/, hotdir/, .env files, tests, yarn.lock, and onnxruntime-node binaries for other platforms. The bundle is read-only once signed. Upstream still writes its SQLite DB, .env and hotdir next to its code (analysis risk 1); Session C's patches move them to ~/Library/Application Support/AskFiles. Until then, do not start the server from inside the bundle.

### 4. Check the package on this Mac

```
open release/AskFiles-0.1.0-arm64.dmg
```

Drag AskFiles to Applications, eject the DMG, open AskFiles from Applications. Expected: a starting page, then the upstream interface. To make it connect to a server started by hand on port 3001 (upstream/BARE_METAL.md) instead, run:

```
ASKFILES_PORT=3001 /Applications/AskFiles.app/Contents/MacOS/AskFiles
```

Logs are in ~/Library/Logs/AskFiles/main.log, one line per event with the [main] prefix.

Things to look at and report back in the PR for task 1.7, because they could not be checked in the cloud:

- `ls /Applications/AskFiles.app/Contents/Resources/server/node_modules/.prisma/client` lists libquery_engine-darwin-arm64.dylib.node
- `ls /Applications/AskFiles.app/Contents/Resources/server/node_modules/@prisma/engines` lists schema-engine-darwin-arm64
- `ls /Applications/AskFiles.app/Contents/Resources/server/public/_index.html` exists
- `ls /Applications/AskFiles.app/Contents/Resources/collector/node_modules | wc -l` is in the hundreds, not 0
- `ls /Applications/AskFiles.app/Contents/Resources/ollama/ollama` exists
- `du -sh /Applications/AskFiles.app` (expect roughly 2 GB)

### 4b. Check that the server boots without canvas

The server's canvas module draws thumbnails for chat export and charts for the Telegram bot. AskFiles uses neither. canvas 3.2.1 is N-API (docs/upstream-analysis.md Q1); in the cloud it loaded under this repository's Electron 44.10.0 (Node 24.22.1) on Linux, but on the Mac it depends on a prebuilt download at install time, so it may fail to load there. That is accepted: it only breaks those two features. What must hold is that the server still starts. This check boots the built server under the packaged app's Electron with every require of canvas forced to fail:

```
bash scripts/check-server-boot.sh /Applications/AskFiles.app/Contents/MacOS/AskFiles
```

Expected last line: `[check-server-boot] ok: /api/ping returned {"online":true} with canvas blocked`. It runs prisma migrate deploy and the server from upstream/server in the repository (not from the bundle, see Bundle layout), on port 3901 (CHECK_PORT to change), with a temporary STORAGE_DIR, and stops the server when done. It leaves upstream/server/storage/anythingllm.db behind (analysis risk 1); delete it if you like, it is not packaged. While it runs the server listens on all interfaces until the Session C bind-host patch lands. Ollama does not need to be running.

Also record whether canvas itself loads on the Mac, for the record only:

```
cd upstream/server && ELECTRON_RUN_AS_NODE=1 /Applications/AskFiles.app/Contents/MacOS/AskFiles -e "require('canvas'); console.log('canvas ok')"
```

### 5. Copy to a second Mac by USB

1. Copy release/AskFiles-0.1.0-arm64.dmg to a USB drive (Finder drag, or `cp`).
2. On the second Mac, copy the DMG from the USB drive to the Desktop, open it, drag AskFiles to Applications.
3. Open AskFiles from Applications.

## What to expect from Gatekeeper

- Copied from a USB drive or over LAN file sharing: the file does not get the quarantine attribute, so the app opens with no warning. The ad-hoc signature is what lets the arm64 binaries run at all.
- Downloaded from the internet, or sent by AirDrop, mail or a chat app: the file gets the quarantine attribute and macOS 15 refuses to open AskFiles because Apple could not verify it. Open System Settings, Privacy and Security, scroll down to the message about AskFiles, click Open Anyway, confirm with your password, then open the app again. This is needed once per installed copy.
- Check for quarantine: `xattr -l /Applications/AskFiles.app`. If com.apple.quarantine is listed and you trust the copy, `xattr -dr com.apple.quarantine /Applications/AskFiles.app` removes it.
- If the app quits at once with no window, run `/Applications/AskFiles.app/Contents/MacOS/AskFiles` in Terminal. `Killed: 9` means a binary inside the bundle is not signed: run `codesign --verify --deep --strict --verbose=4 /Applications/AskFiles.app` and report the file it names.

## Clean up

`make clean` removes dist/, release/, upstream/server/public and upstream/frontend/dist. It keeps node_modules and resources/ollama.
