# patches

Unified diffs applied to upstream/ by scripts/build.sh, in file name order (001-..., 002-...).

Each patch starts with a comment block that says what it changes and why upstream cannot be used as is. Keep patches minimal; re-check them with git apply --check after every upstream upgrade.

Paths inside a patch are relative to upstream/. Apply from the repository root:

    git apply --check --directory=upstream patches/NNN-name.patch
    git apply --directory=upstream patches/NNN-name.patch

Running git apply from inside upstream/ silently skips every file ("Skipped patch"), because git resolves patch paths from the repository top level.

| Patch | Why |
| --- | --- |
| 001-bind-localhost.patch | Server (HTTP and HTTPS) and collector listen on 127.0.0.1 by default, overridable with ANYTHING_LLM_BIND_HOST |
