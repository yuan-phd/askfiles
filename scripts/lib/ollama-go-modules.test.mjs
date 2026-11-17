import { describe, expect, it } from 'vitest';
import { checkAgainstRecord, classify, goModuleLines, modulesOf, readGoBuildInfo } from './ollama-go-modules.mjs';

/** Invented build information in the Go 1.18+ layout: magic, flags with inline strings, two strings. */
function buildInfo(goVersion, lines) {
  const varint = (n) => {
    const out = [];
    do {
      out.push((n & 0x7f) | (n > 0x7f ? 0x80 : 0));
      n >>>= 7;
    } while (n);
    return Buffer.from(out);
  };
  const str = (s) => Buffer.concat([varint(Buffer.byteLength(s)), Buffer.from(s)]);
  const header = Buffer.alloc(32);
  Buffer.from('\xff Go buildinf:', 'latin1').copy(header);
  header[14] = 8;
  header[15] = 2;
  const sentinel = Buffer.alloc(16, 0xaa);
  const mod = Buffer.concat([sentinel, Buffer.from(lines.join('\n') + '\n'), sentinel]);
  return Buffer.concat([header, str(goVersion), varint(mod.length), mod]);
}

const ARM = buildInfo('go1.26.0', [
  'path\texample.com/app',
  'mod\texample.com/app\tv1.2.3\t',
  'dep\texample.com/a\tv1.0.0\th1:x',
  'dep\texample.com/b\tv0.1.0\th1:y',
  '=>\texample.com/b-fork\tv0.1.1\th1:z',
  'build\tGOOS=darwin',
  'build\tvcs.revision=abc123',
]);
const AMD = buildInfo('go1.26.0', ['mod\texample.com/app\tv1.2.3\t', 'dep\texample.com/a\tv1.0.0\th1:x']);

describe('readGoBuildInfo', () => {
  it('reads every record of a binary, as a universal binary holds one per architecture', () => {
    const infos = readGoBuildInfo(Buffer.concat([Buffer.alloc(100), ARM, Buffer.alloc(50), AMD]));
    expect(infos).toHaveLength(2);
    expect(infos[0]).toMatchObject({
      goVersion: 'go1.26.0',
      main: { path: 'example.com/app', version: 'v1.2.3' },
      settings: { GOOS: 'darwin', 'vcs.revision': 'abc123' },
    });
    // A replaced module is listed as its replacement, once across the records.
    expect(modulesOf(infos)).toEqual([
      { path: 'example.com/a', version: 'v1.0.0' },
      { path: 'example.com/b-fork', version: 'v0.1.1' },
    ]);
  });

  it('finds nothing in a file without build information', () => {
    expect(readGoBuildInfo(Buffer.from('not a Go binary'))).toEqual([]);
  });
});

describe('checkAgainstRecord', () => {
  const record = {
    std: [{ version: 'go1.26.0', license: 'BSD-3-Clause', files: [{ name: 'LICENSE', text: 'GO TEXT' }] }],
    modules: [
      { path: 'example.com/a', version: 'v1.0.0', license: 'MIT', files: [{ name: 'LICENSE', text: 'A TEXT' }] },
    ],
  };

  it('names every module, version and Go release the record lacks', () => {
    const { modules, std, errors } = checkAgainstRecord(
      [
        { path: 'example.com/a', version: 'v1.0.0' },
        { path: 'example.com/a', version: 'v1.0.1' },
      ],
      record,
      ['go1.26.0', 'go1.27.0'],
    );
    expect(modules.map((m) => m.version)).toEqual(['v1.0.0']);
    expect(std.map((g) => g.version)).toEqual(['go1.26.0']);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/^example\.com\/a@v1\.0\.1 is compiled into the Ollama binary but not in/);
    expect(errors[1]).toMatch(/Go standard library of go1\.27\.0/);
  });

  it('lists the modules with versions and licenses, and each distinct text once', () => {
    const infos = readGoBuildInfo(ARM);
    const twin = {
      path: 'example.com/c',
      version: 'v2.0.0',
      license: 'MIT',
      files: [{ name: 'LICENSE', text: 'A  TEXT' }],
    };
    const { lines, texts } = goModuleLines('ollama', infos, [...record.modules, twin], record.std);
    expect(lines[0]).toBe(
      'The Ollama binary (ollama) is example.com/app v1.2.3, built from commit abc123 with go1.26.0.',
    );
    expect(lines).toContain('- Go standard library go1.26.0: BSD-3-Clause');
    expect(lines).toContain('- example.com/a v1.0.0: MIT');
    expect(texts).toEqual([
      { heading: '=== Go module in Ollama: Go standard library go1.26.0 (LICENSE) ===', text: 'GO TEXT' },
      {
        heading: '=== Go module in Ollama: example.com/a@v1.0.0 (LICENSE), example.com/c@v2.0.0 (LICENSE) ===',
        text: 'A TEXT',
      },
    ]);
  });
});

describe('classify', () => {
  it('names every license a file holds', () => {
    const mit = 'Permission is hereby granted, free of charge, to any person';
    const apache = 'Apache License\nVersion 2.0, January 2004';
    const bsd3 = 'Redistribution and use in source and binary forms ... Neither the name of';
    const bsd2 = 'Redistribution and use in source and binary forms, with or without modification';
    const isc = 'Permission to use, copy, modify, and/or distribute this software for any purpose';
    expect(classify(mit)).toBe('MIT');
    expect(classify(apache)).toBe('Apache-2.0');
    expect(classify(bsd3)).toBe('BSD-3-Clause');
    expect(classify(`${bsd2}\n${isc}`)).toBe('BSD-2-Clause AND ISC');
    expect(classify(`two licenses: ${mit}\n${apache}`)).toBe('MIT AND Apache-2.0');
    expect(classify('All rights reserved.')).toBeNull();
  });
});
