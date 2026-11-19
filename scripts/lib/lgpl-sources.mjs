// Where the source code of the LGPL libraries the app ships can be found, at the exact versions it
// ships: libvips and the libraries built into it (sharp's prebuilt binaries, server and collector,
// mac and Windows) and FFmpeg inside Electron. LGPL-3.0 section 4 and GPL-3.0 section 6(d), which it
// builds on, let object code point to a server that holds the Corresponding Source; LGPL-2.1
// section 6 likewise for FFmpeg. scripts/third-party-notices.mjs writes this into
// THIRD-PARTY-NOTICES and scripts/license-report.mjs into docs/licenses.md.
//
// Every file is a copy in the release lgpl-sources-1 of this repository (MIRROR), so the pointers do
// not depend on third-party servers, gists or moving branches. `from` is where the build got it; the
// release's manifest.json and SHA256SUMS record each file's sha256 and how it was verified
// (docs/licenses.md, Source code of the LGPL libraries). A new libvips or Electron needs its files
// added to a new release (lgpl-sources-2) before the entry here can point to it.
//
// The tables are keyed by the versions found in the trees, so a dependency update that brings
// another libvips or Electron fails the notices step until an entry is added here (--strict).
import fs from 'node:fs';
import path from 'node:path';

export const MIRROR_TAG = 'lgpl-sources-1';
export const MIRROR_PAGE = `https://github.com/yuan-phd/askfiles/releases/tag/${MIRROR_TAG}`;
export const MIRROR = `https://github.com/yuan-phd/askfiles/releases/download/${MIRROR_TAG}`;

const GH = 'https://github.com';
const GNOME = 'https://download.gnome.org/sources';

/** One source archive: key is its name in the build's versions.json. */
const lib = (key, name, version, license, file, from) => ({ key, name, version, license, file, from });

const SOURCES = {
  vips8145: lib(
    'vips',
    'libvips',
    '8.14.5',
    'LGPL-3.0',
    'vips-8.14.5.tar.xz',
    `${GH}/libvips/libvips/releases/download/v8.14.5/vips-8.14.5.tar.xz`,
  ),
  vips8153: lib(
    'vips',
    'libvips',
    '8.15.3',
    'LGPL-3.0',
    'vips-8.15.3.tar.xz',
    `${GH}/libvips/libvips/releases/download/v8.15.3/vips-8.15.3.tar.xz`,
  ),
  glib2780: lib('glib', 'GLib', '2.78.0', 'LGPL-3.0', 'glib-2.78.0.tar.xz', `${GNOME}/glib/2.78/glib-2.78.0.tar.xz`),
  glib2811: lib('glib', 'GLib', '2.81.1', 'LGPL-3.0', 'glib-2.81.1.tar.xz', `${GNOME}/glib/2.81/glib-2.81.1.tar.xz`),
  fribidi1013: lib(
    'fribidi',
    'FriBidi',
    '1.0.13',
    'LGPL-3.0',
    'fribidi-1.0.13.tar.xz',
    `${GH}/fribidi/fribidi/releases/download/v1.0.13/fribidi-1.0.13.tar.xz`,
  ),
  fribidi1015: lib(
    'fribidi',
    'FriBidi',
    '1.0.15',
    'LGPL-3.0',
    'fribidi-1.0.15.tar.xz',
    `${GH}/fribidi/fribidi/releases/download/v1.0.15/fribidi-1.0.15.tar.xz`,
  ),
  gdkpixbuf24210: lib(
    'gdkpixbuf',
    'GdkPixbuf',
    '2.42.10',
    'LGPL-3.0',
    'gdk-pixbuf-2.42.10.tar.xz',
    `${GNOME}/gdk-pixbuf/2.42/gdk-pixbuf-2.42.10.tar.xz`,
  ),
  exif0624: lib(
    'exif',
    'libexif',
    '0.6.24',
    'LGPL-3.0',
    'libexif-0.6.24.tar.bz2',
    `${GH}/libexif/libexif/releases/download/v0.6.24/libexif-0.6.24.tar.bz2`,
  ),
  heif1162: lib(
    'heif',
    'libheif',
    '1.16.2',
    'LGPL-3.0',
    'libheif-1.16.2.tar.gz',
    `${GH}/strukturag/libheif/releases/download/v1.16.2/libheif-1.16.2.tar.gz`,
  ),
  heif1182: lib(
    'heif',
    'libheif',
    '1.18.2',
    'LGPL-3.0',
    'libheif-1.18.2.tar.gz',
    `${GH}/strukturag/libheif/releases/download/v1.18.2/libheif-1.18.2.tar.gz`,
  ),
  rsvg2570: lib(
    'rsvg',
    'librsvg',
    '2.57.0',
    'LGPL-3.0',
    'librsvg-2.57.0.tar.xz',
    `${GNOME}/librsvg/2.57/librsvg-2.57.0.tar.xz`,
  ),
  rsvg25893: lib(
    'rsvg',
    'librsvg',
    '2.58.93',
    'LGPL-3.0',
    'librsvg-2.58.93.tar.xz',
    `${GNOME}/librsvg/2.58/librsvg-2.58.93.tar.xz`,
  ),
  pango1510: lib(
    'pango',
    'Pango',
    '1.51.0',
    'LGPL-3.0',
    'pango-1.51.0.tar.xz',
    `${GNOME}/pango/1.51/pango-1.51.0.tar.xz`,
  ),
  pango1540: lib(
    'pango',
    'Pango',
    '1.54.0',
    'LGPL-3.0',
    'pango-1.54.0.tar.xz',
    `${GNOME}/pango/1.54/pango-1.54.0.tar.xz`,
  ),
  intl04: lib(
    'proxy-libintl',
    'proxy-libintl',
    '0.4',
    'LGPL-3.0',
    'proxy-libintl-0.4.tar.gz',
    `${GH}/frida/proxy-libintl/archive/0.4.tar.gz`,
  ),
  // The mac and Windows builds of 1.17.8 download different archives of the same release.
  cairo1178posix: lib(
    'cairo',
    'cairo',
    '1.17.8',
    'MPL-2.0',
    'cairo-1.17.8.tar.bz2',
    'https://gitlab.freedesktop.org/cairo/cairo/-/archive/1.17.8/cairo-1.17.8.tar.bz2',
  ),
  cairo1178win: lib(
    'cairo',
    'cairo',
    '1.17.8',
    'MPL-2.0',
    'cairo-1.17.8.tar.xz',
    'https://cairographics.org/snapshots/cairo-1.17.8.tar.xz',
  ),
  cairo1180: lib(
    'cairo',
    'cairo',
    '1.18.0',
    'MPL-2.0',
    'cairo-1.18.0.tar.xz',
    'https://cairographics.org/releases/cairo-1.18.0.tar.xz',
  ),
};
const S = SOURCES;

const SHARP_LIBVIPS = 'https://github.com/lovell/sharp-libvips';
const recipe = (file, from, what) => ({ file, from, what });
const SHARP_LIBVIPS_8145 = recipe(
  'sharp-libvips-e3585e7e2de7c0a9f0fe81c2bd9a559bebc65f87.tar.gz',
  `${SHARP_LIBVIPS}/tree/e3585e7e2de7c0a9f0fe81c2bd9a559bebc65f87`,
  'lovell/sharp-libvips at commit e3585e7e2de7c0a9f0fe81c2bd9a559bebc65f87 (tag v8.14.5)',
);
const SHARP_LIBVIPS_8153 = recipe(
  'sharp-libvips-cb57c8e09460fa0b5c550806b667a2dfc3f7480b.tar.gz',
  `${SHARP_LIBVIPS}/tree/cb57c8e09460fa0b5c550806b667a2dfc3f7480b`,
  'lovell/sharp-libvips at commit cb57c8e09460fa0b5c550806b667a2dfc3f7480b (tag v8.15.3)',
);

/**
 * Builds of lovell/sharp-libvips for macOS and Linux, keyed by libvips version. build/lin.sh at the
 * commit downloads each library's source and applies the patches listed (mac.sh is a link to
 * lin.sh); its other changes (sed edits of build files) are in the script, inside the recipe
 * archive. @img/sharp-libvips-* 1.0.4 was published from commit cb57c8e (npm registry gitHead),
 * sharp 0.32.6 downloads the 8.14.5 release built at tag v8.14.5. Only the LGPL libraries, and cairo
 * (MPL-2.0, which asks for the same pointer), are listed. The license is the one sharp-libvips names
 * in the THIRD-PARTY-NOTICES.md it ships with each build: LGPLv3 for every one, "via the 'any later
 * version' clause of the LGPLv2 or LGPLv2.1" for those whose projects license them under an earlier
 * version.
 */
export const LIBVIPS_POSIX = {
  '8.15.3': {
    recipes: [SHARP_LIBVIPS_8153],
    patches: [
      { name: 'GLib', file: 'sharp-libvips-8.15.3-glib-without-gregex.patch' },
      { name: 'libexif', file: 'sharp-libvips-8.15.3-libexif-db84aefa.patch' },
      { name: 'libvips', file: 'sharp-libvips-8.15.3-vips-8-heifsave-disable-hbr-support.patch' },
    ],
    libraries: [
      S.vips8153,
      S.glib2811,
      S.fribidi1015,
      S.exif0624,
      S.heif1182,
      S.rsvg25893,
      S.pango1540,
      S.intl04,
      S.cairo1180,
    ],
  },
  '8.14.5': {
    recipes: [SHARP_LIBVIPS_8145],
    patches: [
      { name: 'GLib', file: 'sharp-libvips-8.14.5-glib-without-gregex.patch' },
      // lin.sh reads it from build-win64-mxe master; this is master as of the build (2023-09-18),
      // the same file as at build-win64-mxe tag v8.14.5.
      { name: 'libvips', file: 'sharp-libvips-8.14.5-vips-8-pr-3476.patch' },
    ],
    libraries: [
      S.vips8145,
      S.glib2780,
      S.fribidi1013,
      S.gdkpixbuf24210,
      S.exif0624,
      S.heif1162,
      S.rsvg2570,
      S.pango1510,
      S.intl04,
      S.cairo1178posix,
    ],
  },
};

const BUILD_WIN64_MXE = 'https://github.com/libvips/build-win64-mxe';
/**
 * Windows builds: sharp-libvips build/win.sh repackages the static "web" build of
 * libvips/build-win64-mxe at the same version tag. Its build/build.sh fetches MXE at a pinned
 * revision; the version overrides, the patches (build/patches, build/plugins) and MXE's own package
 * patches (src/*.patch) are in the recipe archives. Library versions are the build's versions.json;
 * each source archive matched the sha256 the recipes name.
 */
export const LIBVIPS_WIN32 = {
  '8.15.3': {
    recipes: [
      recipe(
        'build-win64-mxe-v8.15.3.tar.gz',
        `${BUILD_WIN64_MXE}/tree/v8.15.3`,
        'libvips/build-win64-mxe at tag v8.15.3',
      ),
      recipe(
        'mxe-e56eebec2a9f578c12a495851a76256d93b71ac0.tar.gz',
        'https://github.com/mxe/mxe/tree/e56eebec2a9f578c12a495851a76256d93b71ac0',
        'MXE at commit e56eebec2a9f578c12a495851a76256d93b71ac0',
      ),
      SHARP_LIBVIPS_8153,
    ],
    libraries: [
      S.vips8153,
      S.glib2811,
      S.fribidi1015,
      S.exif0624,
      S.heif1182,
      S.rsvg25893,
      S.pango1540,
      S.intl04,
      S.cairo1180,
    ],
  },
  '8.14.5': {
    recipes: [
      recipe(
        'build-win64-mxe-v8.14.5.tar.gz',
        `${BUILD_WIN64_MXE}/tree/v8.14.5`,
        'libvips/build-win64-mxe at tag v8.14.5',
      ),
      recipe(
        'mxe-b3101cc659170b08efef83dcbebfe4806c2feab3.tar.gz',
        'https://github.com/mxe/mxe/tree/b3101cc659170b08efef83dcbebfe4806c2feab3',
        'MXE at commit b3101cc659170b08efef83dcbebfe4806c2feab3',
      ),
      SHARP_LIBVIPS_8145,
    ],
    libraries: [
      S.vips8145,
      S.glib2780,
      S.fribidi1013,
      S.gdkpixbuf24210,
      S.exif0624,
      S.heif1162,
      S.rsvg2570,
      S.pango1510,
      S.intl04,
      S.cairo1178win,
    ],
  },
};

/**
 * FFmpeg as Electron ships it (libffmpeg in the Electron framework, ffmpeg.dll on Windows):
 * Chromium's fork at the revision the Chromium version's DEPS pins (ffmpeg_revision), with
 * Chromium's build configuration in its chromium/ folder. Chromium version from
 * process.versions.chrome of the installed Electron, which matches chromium_version in
 * electron/electron DEPS at the tag.
 */
export const FFMPEG = {
  '44.10.0': {
    chromium: '152.0.7977.169',
    revision: '2b68d2babae73714846961fb0ee47e3b3d2e39a9',
    file: 'chromium-ffmpeg-2b68d2babae73714846961fb0ee47e3b3d2e39a9.tar.gz',
  },
};

/** Every file the release must hold, for the tests and for whoever makes the next release. */
export function mirrorFiles() {
  const files = new Set();
  for (const table of [LIBVIPS_POSIX, LIBVIPS_WIN32]) {
    for (const b of Object.values(table)) {
      for (const r of b.recipes) files.add(r.file);
      for (const p of b.patches ?? []) files.add(p.file);
      for (const l of b.libraries) files.add(l.file);
    }
  }
  for (const f of Object.values(FFMPEG)) files.add(f.file);
  return [...files].sort();
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The libvips builds inside one package directory: the prebuilt @img/sharp-libvips-* and
 * @img/sharp-win32-* packages (versions.json at the root or in lib/), and the vendor/<version>/<platform>
 * folder sharp 0.32 and older download into. Plain data, so the frontend snapshot could carry it.
 */
export function libvipsBuildsIn(dir, name) {
  const found = [];
  const add = (file, platform) => {
    const versions = readJson(file);
    if (versions?.vips)
      found.push({ vips: versions.vips, family: /win32/.test(platform) ? 'win32' : 'posix', platform, versions });
  };
  const m = /^@img\/sharp-(?:libvips-)?([a-z0-9]+-[a-z0-9]+)$/.exec(name);
  if (m) {
    for (const f of ['versions.json', path.join('lib', 'versions.json')]) {
      if (fs.existsSync(path.join(dir, f))) {
        add(path.join(dir, f), m[1]);
        break;
      }
    }
  }
  if (name === 'sharp' && fs.existsSync(path.join(dir, 'vendor'))) {
    for (const v of fs.readdirSync(path.join(dir, 'vendor'))) {
      const vdir = path.join(dir, 'vendor', v);
      if (!fs.statSync(vdir).isDirectory()) continue;
      for (const platform of fs.readdirSync(vdir)) {
        const f = path.join(vdir, platform, 'versions.json');
        if (fs.existsSync(f)) add(f, platform);
      }
    }
  }
  return found;
}

const mirrored = (file) => `${MIRROR}/${file}`;

/**
 * Plain-text lines (they read as Markdown too) pointing to the source of each LGPL library.
 * builds: [{ vips, family, versions, carriers: [package@version (tree)] }]. errors names every
 * build or Electron version without an entry here, or a library whose version differs.
 */
export function lgplSourceLines(builds, electronVersion) {
  const errors = [];
  const lines = [
    'AskFiles uses the libraries below unchanged, as their projects build them, and links them dynamically:',
    '- libvips and the libraries built into it form one shared library in the lib folder of the package',
    '  named under "Shipped in" (libvips-cpp.42.dylib on macOS), which the package\'s native module loads',
    '  at run time. sharp-libvips uses each of them under the GNU LGPL version 3, through the "any later',
    '  version" clause where a project licenses it under LGPL 2 or 2.1; cairo is under the Mozilla Public',
    '  License 2.0.',
    '- FFmpeg is the separate shared library libffmpeg (libffmpeg.dylib in the Electron framework on',
    '  macOS, ffmpeg.dll on Windows), which Electron loads at run time; it is under the GNU LGPL',
    '  version 2.1.',
    'You may replace these shared libraries with your own builds, modified or not, for example from the',
    'source below. On macOS, changing a file inside the app invalidates its code signature; sign the app',
    'again (for example ad hoc: codesign --force --deep --sign - AskFiles.app).',
    'The license texts are under "License texts" below: LGPL-2.1, LGPL-3.0 (with the GPL-3.0 text it',
    'builds on) and MPL-2.0. The complete source code, at the versions shipped, with the build scripts',
    `and patches used, is kept by AskFiles in the release ${MIRROR_TAG} of its repository:`,
    MIRROR_PAGE,
    'Each file is an exact copy of what the build downloaded; manifest.json and SHA256SUMS in that',
    'release name where each file came from and its sha256.',
    '',
  ];
  const byKey = new Map();
  for (const b of builds) {
    const key = `${b.family} ${b.vips}`;
    const g = byKey.get(key) ?? { ...b, carriers: [] };
    g.carriers.push(...b.carriers);
    byKey.set(key, g);
  }
  for (const g of [...byKey.values()].sort((a, b) => `${a.family} ${a.vips}`.localeCompare(`${b.family} ${b.vips}`))) {
    const carriers = [...new Set(g.carriers)].sort().join(', ');
    const win = g.family === 'win32';
    const entry = (win ? LIBVIPS_WIN32 : LIBVIPS_POSIX)[g.vips];
    if (!entry) {
      errors.push(
        `libvips ${g.vips}${win ? ' for Windows' : ''} (${carriers}) has no source entry in scripts/lib/lgpl-sources.mjs`,
      );
      continue;
    }
    lines.push(
      `- libvips ${g.vips}${win ? ' for Windows' : ''} and the libraries built into it`,
      `  Shipped in: ${carriers}`,
    );
    if (win) {
      lines.push(
        `  Built by build-win64-mxe with MXE and repackaged by sharp-libvips build/win.sh; the patches applied`,
        '  are in build/patches and build/plugins of build-win64-mxe and in src of MXE:',
      );
    } else {
      lines.push(
        '  Built by sharp-libvips build/lin.sh, which downloads each source below and applies the patches named:',
      );
    }
    for (const r of entry.recipes) lines.push(`  - ${r.what}: ${mirrored(r.file)}`);
    for (const p of entry.patches ?? []) lines.push(`  - patch to ${p.name}: ${mirrored(p.file)}`);
    for (const l of entry.libraries) {
      const shipped = g.versions[l.key];
      if (shipped !== l.version) {
        errors.push(
          `libvips ${g.vips}${win ? ' for Windows' : ''}: ${l.name} is ${shipped ?? 'missing'} in the tree, ${l.version} in scripts/lib/lgpl-sources.mjs`,
        );
      }
      lines.push(`  - ${l.name} ${l.version} (${l.license}): ${mirrored(l.file)}`);
    }
  }
  const ff = FFMPEG[electronVersion];
  if (!ff) {
    errors.push(`Electron ${electronVersion} has no FFmpeg entry in scripts/lib/lgpl-sources.mjs`);
  } else {
    lines.push(
      `- FFmpeg in Electron ${electronVersion} (libffmpeg in the Electron framework)`,
      '  License: LGPL-2.1 (text below; also in LICENSES.chromium.html in the app resources).',
      `  Chromium ${ff.chromium}'s copy at revision ${ff.revision}, with Chromium's build configuration`,
      '  in its chromium/ folder:',
      `  ${mirrored(ff.file)}`,
    );
  }
  return { lines, errors };
}
