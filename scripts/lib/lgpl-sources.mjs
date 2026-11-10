// Where the source code of the LGPL libraries the app ships can be found, at the exact versions it
// ships: libvips and the libraries built into it (sharp's prebuilt binaries, server and collector)
// and FFmpeg inside Electron. LGPL-3.0 section 4 and GPL-3.0 section 6(d), which it builds on, let
// object code point to a server that holds the Corresponding Source; LGPL-2.1 section 6 likewise
// for FFmpeg. scripts/third-party-notices.mjs writes this into THIRD-PARTY-NOTICES and
// scripts/license-report.mjs into docs/licenses.md.
//
// The tables are keyed by the versions found in the trees, so a dependency update that brings
// another libvips or Electron fails the notices step until an entry is added here (--strict).
// Every URL was checked to answer 200 on 2026-11-10.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Builds of lovell/sharp-libvips for macOS and Linux, keyed by libvips version. build/lin.sh at the
 * commit downloads each library's source from the URL listed and applies the patches it names
 * (mac.sh is a link to lin.sh). @img/sharp-libvips-* 1.0.4 was published from commit cb57c8e
 * (npm registry gitHead), sharp 0.32.6 downloads the 8.14.5 release built at tag v8.14.5.
 * Only the LGPL libraries, and cairo (MPL-2.0, which asks for the same pointer), are listed.
 */
export const LIBVIPS_POSIX = {
  '8.15.3': {
    repo: 'https://github.com/lovell/sharp-libvips',
    commit: 'cb57c8e09460fa0b5c550806b667a2dfc3f7480b',
    tag: 'v8.15.3',
    libraries: [
      {
        key: 'vips',
        name: 'libvips',
        version: '8.15.3',
        license: 'LGPL',
        url: 'https://github.com/libvips/libvips/releases/download/v8.15.3/vips-8.15.3.tar.xz',
      },
      {
        key: 'glib',
        name: 'GLib',
        version: '2.81.1',
        license: 'LGPL',
        url: 'https://download.gnome.org/sources/glib/2.81/glib-2.81.1.tar.xz',
      },
      {
        key: 'fribidi',
        name: 'FriBidi',
        version: '1.0.15',
        license: 'LGPL',
        url: 'https://github.com/fribidi/fribidi/releases/download/v1.0.15/fribidi-1.0.15.tar.xz',
      },
      {
        key: 'exif',
        name: 'libexif',
        version: '0.6.24',
        license: 'LGPL',
        url: 'https://github.com/libexif/libexif/releases/download/v0.6.24/libexif-0.6.24.tar.bz2',
      },
      {
        key: 'heif',
        name: 'libheif',
        version: '1.18.2',
        license: 'LGPL',
        url: 'https://github.com/strukturag/libheif/releases/download/v1.18.2/libheif-1.18.2.tar.gz',
      },
      {
        key: 'rsvg',
        name: 'librsvg',
        version: '2.58.93',
        license: 'LGPL',
        url: 'https://download.gnome.org/sources/librsvg/2.58/librsvg-2.58.93.tar.xz',
      },
      {
        key: 'pango',
        name: 'Pango',
        version: '1.54.0',
        license: 'LGPL',
        url: 'https://download.gnome.org/sources/pango/1.54/pango-1.54.0.tar.xz',
      },
      {
        key: 'proxy-libintl',
        name: 'proxy-libintl',
        version: '0.4',
        license: 'LGPL',
        url: 'https://github.com/frida/proxy-libintl/archive/0.4.tar.gz',
      },
      {
        key: 'cairo',
        name: 'cairo',
        version: '1.18.0',
        license: 'MPL-2.0',
        url: 'https://cairographics.org/releases/cairo-1.18.0.tar.xz',
      },
    ],
  },
  '8.14.5': {
    repo: 'https://github.com/lovell/sharp-libvips',
    commit: 'e3585e7e2de7c0a9f0fe81c2bd9a559bebc65f87',
    tag: 'v8.14.5',
    libraries: [
      {
        key: 'vips',
        name: 'libvips',
        version: '8.14.5',
        license: 'LGPL',
        url: 'https://github.com/libvips/libvips/releases/download/v8.14.5/vips-8.14.5.tar.xz',
      },
      {
        key: 'glib',
        name: 'GLib',
        version: '2.78.0',
        license: 'LGPL',
        url: 'https://download.gnome.org/sources/glib/2.78/glib-2.78.0.tar.xz',
      },
      {
        key: 'fribidi',
        name: 'FriBidi',
        version: '1.0.13',
        license: 'LGPL',
        url: 'https://github.com/fribidi/fribidi/releases/download/v1.0.13/fribidi-1.0.13.tar.xz',
      },
      {
        key: 'gdkpixbuf',
        name: 'GdkPixbuf',
        version: '2.42.10',
        license: 'LGPL',
        url: 'https://download.gnome.org/sources/gdk-pixbuf/2.42/gdk-pixbuf-2.42.10.tar.xz',
      },
      {
        key: 'exif',
        name: 'libexif',
        version: '0.6.24',
        license: 'LGPL',
        url: 'https://github.com/libexif/libexif/releases/download/v0.6.24/libexif-0.6.24.tar.bz2',
      },
      {
        key: 'heif',
        name: 'libheif',
        version: '1.16.2',
        license: 'LGPL',
        url: 'https://github.com/strukturag/libheif/releases/download/v1.16.2/libheif-1.16.2.tar.gz',
      },
      {
        key: 'rsvg',
        name: 'librsvg',
        version: '2.57.0',
        license: 'LGPL',
        url: 'https://download.gnome.org/sources/librsvg/2.57/librsvg-2.57.0.tar.xz',
      },
      {
        key: 'pango',
        name: 'Pango',
        version: '1.51.0',
        license: 'LGPL',
        url: 'https://download.gnome.org/sources/pango/1.51/pango-1.51.0.tar.xz',
      },
      {
        key: 'proxy-libintl',
        name: 'proxy-libintl',
        version: '0.4',
        license: 'LGPL',
        url: 'https://github.com/frida/proxy-libintl/archive/0.4.tar.gz',
      },
      {
        key: 'cairo',
        name: 'cairo',
        version: '1.17.8',
        license: 'MPL-2.0',
        url: 'https://gitlab.freedesktop.org/cairo/cairo/-/archive/1.17.8/cairo-1.17.8.tar.bz2',
      },
    ],
  },
};

/**
 * Windows builds: sharp-libvips build/win.sh repackages the static "web" build of
 * libvips/build-win64-mxe at the same version tag, which holds the build recipes and source URLs
 * of every library in it.
 */
export const LIBVIPS_WIN32_REPO = 'https://github.com/libvips/build-win64-mxe';

/**
 * FFmpeg as Electron ships it (libffmpeg in the Electron framework): Chromium's fork at the
 * revision the Chromium version's DEPS pins (ffmpeg_revision), with Chromium's build
 * configuration in its chromium/ folder. Chromium version from process.versions.chrome of the
 * installed Electron, which matches chromium_version in electron/electron DEPS at the tag.
 */
export const FFMPEG = {
  '44.10.0': {
    chromium: '152.0.7977.169',
    revision: '2b68d2babae73714846961fb0ee47e3b3d2e39a9',
  },
};

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

/**
 * Plain-text lines (they read as Markdown too) pointing to the source of each LGPL library.
 * builds: [{ vips, family, versions, carriers: [package@version (tree)] }]. errors names every
 * build or Electron version without an entry here, or a library whose version differs.
 */
export function lgplSourceLines(builds, electronVersion) {
  const errors = [];
  const lines = [
    'AskFiles ships the libraries below as separate shared libraries, as their projects build them, without',
    'changes by AskFiles. They are covered by the GNU Lesser General Public License (cairo by the Mozilla Public',
    'License 2.0); you may replace them with your own builds. Their complete source code, at the versions',
    'shipped, is available at these locations:',
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
    if (g.family === 'win32') {
      lines.push(
        `- libvips ${g.vips} for Windows and the libraries built into it`,
        `  Shipped in: ${carriers}`,
        `  Built by ${LIBVIPS_WIN32_REPO} at tag v${g.vips}, whose recipes name the source of every library:`,
        `  ${LIBVIPS_WIN32_REPO}/tree/v${g.vips}`,
        `  Versions shipped: ${Object.entries(g.versions)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')}`,
      );
      continue;
    }
    const entry = LIBVIPS_POSIX[g.vips];
    if (!entry) {
      errors.push(`libvips ${g.vips} (${carriers}) has no source entry in scripts/lib/lgpl-sources.mjs`);
      continue;
    }
    lines.push(
      `- libvips ${g.vips} and the libraries built into it`,
      `  Shipped in: ${carriers}`,
      `  Built by ${entry.repo} at commit ${entry.commit} (tag ${entry.tag}):`,
      `  ${entry.repo}/tree/${entry.commit}`,
      '  Its build/lin.sh downloads each source below and applies the patches it names.',
    );
    for (const lib of entry.libraries) {
      const shipped = g.versions[lib.key];
      if (shipped !== lib.version) {
        errors.push(
          `libvips ${g.vips}: ${lib.name} is ${shipped ?? 'missing'} in the tree, ${lib.version} in scripts/lib/lgpl-sources.mjs`,
        );
      }
      lines.push(`  - ${lib.name} ${lib.version} (${lib.license}): ${lib.url}`);
    }
  }
  const ff = FFMPEG[electronVersion];
  if (!ff) {
    errors.push(`Electron ${electronVersion} has no FFmpeg entry in scripts/lib/lgpl-sources.mjs`);
  } else {
    lines.push(
      `- FFmpeg in Electron ${electronVersion} (libffmpeg in the Electron framework)`,
      '  License: LGPL-2.1; its text is in LICENSES.chromium.html in the app resources.',
      `  Chromium ${ff.chromium}'s copy at revision ${ff.revision}, with Chromium's build configuration`,
      '  in its chromium/ folder:',
      `  https://chromium.googlesource.com/chromium/third_party/ffmpeg/+/${ff.revision}`,
    );
  }
  return { lines, errors };
}
