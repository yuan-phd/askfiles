import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FFMPEG, LIBVIPS_POSIX, LIBVIPS_WIN32, lgplSourceLines, libvipsBuildsIn } from './lgpl-sources.mjs';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'askfiles-lgpl-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function write(rel, json) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), JSON.stringify(json));
}

/** The versions.json of a build as the table names it, as sharp-libvips writes it. */
function versionsOf(vips, table = LIBVIPS_POSIX) {
  return { vips, ...Object.fromEntries(table[vips].libraries.map((l) => [l.key, l.version])) };
}

describe('libvipsBuildsIn', () => {
  it('reads the prebuilt @img packages, at the root or in lib/', () => {
    write('a/versions.json', versionsOf('8.15.3'));
    expect(libvipsBuildsIn(path.join(root, 'a'), '@img/sharp-libvips-darwin-arm64')).toMatchObject([
      { vips: '8.15.3', family: 'posix', platform: 'darwin-arm64' },
    ]);
    write('b/lib/versions.json', { vips: '8.15.3' });
    expect(libvipsBuildsIn(path.join(root, 'b'), '@img/sharp-win32-x64')).toMatchObject([
      { vips: '8.15.3', family: 'win32' },
    ]);
  });

  it("reads sharp 0.32's vendor folder and ignores other packages", () => {
    write('sharp/vendor/8.14.5/darwin-arm64v8/versions.json', versionsOf('8.14.5'));
    expect(libvipsBuildsIn(path.join(root, 'sharp'), 'sharp')).toMatchObject([
      { vips: '8.14.5', family: 'posix', platform: 'darwin-arm64v8' },
    ]);
    write('other/versions.json', { vips: '8.15.3' });
    expect(libvipsBuildsIn(path.join(root, 'other'), 'other')).toEqual([]);
  });
});

describe('lgplSourceLines', () => {
  const electron = Object.keys(FFMPEG)[0];

  it('points every shipped LGPL library, patch, build script and FFmpeg to its upstream source', () => {
    const { lines, errors } = lgplSourceLines(
      [
        { vips: '8.15.3', family: 'posix', versions: versionsOf('8.15.3'), carriers: ['x@1 (collector)'] },
        { vips: '8.15.3', family: 'posix', versions: versionsOf('8.15.3'), carriers: ['y@1 (server)'] },
      ],
      electron,
    );
    expect(errors).toEqual([]);
    const text = lines.join('\n');
    expect(text).toContain('Shipped in: x@1 (collector), y@1 (server)');
    const entry = LIBVIPS_POSIX['8.15.3'];
    for (const f of [...entry.recipes, ...entry.patches, ...entry.libraries]) expect(text).toContain(f.url);
    expect(text).toContain(
      `https://chromium.googlesource.com/chromium/third_party/ffmpeg/+/${FFMPEG[electron].revision}`,
    );
    expect(text).toContain('You may replace these shared libraries');
    // No pointer goes through a copy kept by AskFiles.
    expect(text).not.toMatch(/yuan-phd|lgpl-sources-1/);
  });

  it('lists the sources, build-win64-mxe and MXE trees of Windows builds', () => {
    for (const v of Object.keys(LIBVIPS_WIN32)) {
      const { lines, errors } = lgplSourceLines(
        [{ vips: v, family: 'win32', versions: versionsOf(v, LIBVIPS_WIN32), carriers: ['w@1'] }],
        electron,
      );
      expect(errors).toEqual([]);
      const text = lines.join('\n');
      expect(text).toContain(`- libvips ${v} for Windows and the libraries built into it`);
      expect(text).toContain(`https://github.com/libvips/build-win64-mxe/tree/v${v}`);
      expect(text).toMatch(/https:\/\/github\.com\/mxe\/mxe\/tree\/[0-9a-f]{40}/);
      for (const l of LIBVIPS_WIN32[v].libraries) expect(text).toContain(l.url);
    }
  });

  it('pins every pointer to a version, tag or commit, never a moving branch', () => {
    const urls = [];
    for (const table of [LIBVIPS_POSIX, LIBVIPS_WIN32])
      for (const b of Object.values(table))
        for (const f of [...b.recipes, ...(b.patches ?? []), ...b.libraries]) urls.push(f.url);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u, u).toMatch(/^https:\/\//);
      expect(u, u).not.toMatch(/\/(master|main|HEAD)\//);
      // Every URL names an exact version or a commit hash.
      expect(u, u).toMatch(/\d+\.\d+(\.\d+)?|[0-9a-f]{10,40}/);
    }
  });

  it('fails for an unknown libvips or Electron version and for a library at another version', () => {
    const changed = { ...versionsOf('8.15.3'), glib: '2.99.0' };
    const { errors } = lgplSourceLines(
      [
        { vips: '9.0.0', family: 'posix', versions: { vips: '9.0.0' }, carriers: ['a@1'] },
        { vips: '8.15.3', family: 'posix', versions: changed, carriers: ['b@1'] },
        { vips: '9.0.0', family: 'win32', versions: { vips: '9.0.0' }, carriers: ['c@1'] },
      ],
      '0.0.1',
    );
    expect(errors).toEqual([
      'libvips 8.15.3: GLib is 2.99.0 in the tree, 2.81.1 in scripts/lib/lgpl-sources.mjs',
      'libvips 9.0.0 (a@1) has no source entry in scripts/lib/lgpl-sources.mjs',
      'libvips 9.0.0 for Windows (c@1) has no source entry in scripts/lib/lgpl-sources.mjs',
      'Electron 0.0.1 has no FFmpeg entry in scripts/lib/lgpl-sources.mjs',
    ]);
  });
});
