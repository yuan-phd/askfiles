import zlib from 'node:zlib';

/**
 * Reads one entry of a zip archive (a .docx is one) from the central directory, so the Word parser
 * can look at styles.xml and document.xml without a zip dependency. Stored and deflated entries
 * only, which is all Office writes; returns null when the entry is missing.
 */
export function readZipEntry(zip: Buffer, name: string): Buffer | null {
  // End of central directory: signature 0x06054b50 within the last 64 KiB plus its 22 bytes.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('damaged zip central directory');
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const entry = zip.toString('utf8', at + 46, at + 46 + nameLen);
    if (entry === name) {
      if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`damaged zip entry ${name}`);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + compressed);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`zip entry ${name} uses compression method ${method}`);
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
