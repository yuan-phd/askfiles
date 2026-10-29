# Packaging AskFiles on the Mac

How to turn this repository into AskFiles.app and a DMG on an Apple Silicon Mac, sign it ad-hoc, and copy it to a second Mac. Everything here is LOCAL: cloud sessions stop before step 3.

State of the app at this point (after Session B): the window opens http://127.0.0.1:<port>, where the port comes from ASKFILES_PORT or from {"port": N} in the file named by ASKFILES_CONFIG (default ~/Library/Application Support/AskFiles/config.json). The shell does not start Ollama, the collector or the server yet; that is Session C. With no port configured the window shows a short page saying there is no server. The point of this first package is to prove that packaging, signing and copying work.

## What you need

- Apple Silicon Mac, macOS 14 or later, about 10 GB free disk
- Xcode Command Line Tools: `xcode-select --install` (gives git, codesign, hdiutil)
- Node 22: `node -v` prints v22.x. With Homebrew: `brew install node@22`, then follow the PATH hint it prints
- Yarn classic for the upstream packages: `npm install -g yarn`, then `yarn -v` prints 1.22.x

## Steps

### 1. Get the code and install the shell dependencies

```
git clone https://github.com/<owner>/askfiles.git
cd askfiles
npm install
```

npm install does not download Electron. It is fetched the first time electron-builder needs it (about 100 MB).

### 2. Put the Ollama macOS binary into resources/ollama

The app bundles Ollama from its official release archive. resources/ is not committed.

```
OLLAMA_VERSION=v0.40.13
mkdir -p resources/ollama
curl -fL -o /tmp/ollama-darwin.tgz https://github.com/ollama/ollama/releases/download/$OLLAMA_VERSION/ollama-darwin.tgz
shasum -a 256 /tmp/ollama-darwin.tgz
tar -xzf /tmp/ollama-darwin.tgz -C resources/ollama
resources/ollama/ollama --version
```

Expected: the checksum is `bae29252232b9e1358cf5801a7d65a07442af18fb5467cb68c7fc3711f59c511` (measured in Session B on 2026-10-29 for v0.40.13), and the last command prints the client version 0.40.13 plus a warning that it could not connect to a running Ollama instance. That warning is fine.

The archive holds about 60 files, around 600 MB unpacked: the ollama binary (universal arm64 and x86_64), llama-server, dylibs, two mlx_metal folders and license files. Keep all of them together; the binary loads the libraries from its own folder. v0.40.13 is the version the cloud environment ran in Session B. If you choose another version, record it in the PR or in docs/plan.md.

### 3. Build and package

```
npm run package:mac
```

This runs, in order:

1. `tsc` for src/main into dist/main
2. `scripts/build.sh` with PACKAGE_TARGET=mac-arm64: checks resources/ollama, applies patches/, builds the upstream frontend into upstream/server/public, installs server and collector production dependencies, runs prisma generate, removes Prisma engines for every platform except darwin-arm64, checks that dev dependencies are gone, prints sizes
3. `electron-builder --mac dir --arm64`: creates release/mac-arm64/AskFiles.app without a DMG
4. `scripts/sign-adhoc.sh`: ad-hoc signs every Mach-O file under Contents/Resources, then the whole app, then verifies with `codesign --verify --deep --strict`
5. `electron-builder --mac dmg --arm64 --prepackaged release/mac-arm64/AskFiles.app`: wraps the signed app into release/AskFiles-0.1.0-arm64.dmg

The DMG is built after signing on purpose: signing the app after the DMG exists would leave an unsigned copy inside the DMG.

Expected time: 3 to 10 minutes on first run, mostly yarn installs. Expected output at the end: release/AskFiles-0.1.0-arm64.dmg.

Notes on messages you may see:

- `skipped macOS code signing reason=identity explicitly is set to null`: expected; step 4 signs.
- In step 2, if it stops with `no query engine for darwin-arm64` or `no schema engine for darwin-arm64`, prisma generate did not download the Mac engines. Run `cd upstream/server && node node_modules/prisma/build/index.js generate` once with network access, then run step 3 again.

To sign an app by hand, for example after a manual electron-builder run: `bash scripts/sign-adhoc.sh release/mac-arm64/AskFiles.app`.

### 4. Check the package on this Mac

```
open release/AskFiles-0.1.0-arm64.dmg
```

Drag AskFiles to Applications, eject the DMG, open AskFiles from Applications. Expected: a window with the AskFiles no-server page. To see it connect to a server, start the upstream server by hand on port 3001 (upstream/BARE_METAL.md) and run:

```
ASKFILES_PORT=3001 /Applications/AskFiles.app/Contents/MacOS/AskFiles
```

Logs are in ~/Library/Logs/AskFiles/main.log, one line per event with the [main] prefix.

Things to look at and report back in the PR for task 1.7, because they could not be checked in the cloud:

- `ls /Applications/AskFiles.app/Contents/Resources/app.asar.unpacked/upstream/server/node_modules/.prisma/client` lists libquery_engine-darwin-arm64.dylib.node
- `ls /Applications/AskFiles.app/Contents/Resources/ollama/ollama` exists
- `du -sh /Applications/AskFiles.app` (expect roughly 2 GB before trimming)
- whether electron-builder copied upstream/server/node_modules and upstream/collector/node_modules at all (`npx @electron/asar list /Applications/AskFiles.app/Contents/Resources/app.asar | grep -c node_modules`)

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
