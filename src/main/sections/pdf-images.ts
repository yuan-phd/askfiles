import zlib from 'node:zlib';

/** A decoded image as pdfjs hands it over: kind 1 is 1-bit gray (packed rows), 2 RGB, 3 RGBA. */
export interface RawImage {
  width: number;
  height: number;
  kind: number;
  data: Uint8Array | Uint8ClampedArray;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGB data whose every pixel is gray, as one byte per pixel; null when any pixel has color. */
function grayOf(data: Uint8Array | Uint8ClampedArray, pixels: number): Uint8Array | null {
  const out = new Uint8Array(pixels);
  for (let p = 0, i = 0; p < pixels; p++, i += 3) {
    const v = data[i]!;
    if (data[i + 1] !== v || data[i + 2] !== v) return null;
    out[p] = v;
  }
  return out;
}

/**
 * PNG bytes of a pdfjs image, or null for a kind it does not produce. In both pdfjs's 1-bit gray
 * and PNG's, a set bit is white and rows are padded to whole bytes, so those rows copy as they are.
 * pdfjs hands a gray scan over as RGB; it is written as 8-bit gray, a third of the bytes to send.
 */
export function encodePng(img: RawImage): Buffer | null {
  if (img.kind === 2 && img.data.length >= img.width * img.height * 3) {
    const gray = grayOf(img.data, img.width * img.height);
    if (gray) return encodeRows(img.width, img.height, gray, { colorType: 0, depth: 8, rowBytes: img.width });
  }
  const formats: Record<number, { colorType: number; depth: number; rowBytes: number }> = {
    1: { colorType: 0, depth: 1, rowBytes: Math.ceil(img.width / 8) },
    2: { colorType: 2, depth: 8, rowBytes: img.width * 3 },
    3: { colorType: 6, depth: 8, rowBytes: img.width * 4 },
  };
  const f = formats[img.kind];
  if (!f || img.width <= 0 || img.height <= 0 || img.data.length < f.rowBytes * img.height) return null;
  return encodeRows(img.width, img.height, img.data, f);
}

function encodeRows(
  width: number,
  height: number,
  data: Uint8Array | Uint8ClampedArray,
  f: { colorType: number; depth: number; rowBytes: number },
): Buffer {
  const raw = Buffer.alloc((f.rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    // Filter byte 0 (none) in front of every row.
    Buffer.from(data.buffer, data.byteOffset + y * f.rowBytes, f.rowBytes).copy(raw, y * (f.rowBytes + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = f.depth;
  ihdr[9] = f.colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

interface PdfPage {
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  objs: { get(id: string, callback: (data: unknown) => void): unknown };
  commonObjs: { get(id: string, callback: (data: unknown) => void): unknown };
}

/** Waits for a decoded image; pdfjs never calls back for one it failed to decode, hence the limit. */
function objectOf(page: PdfPage, id: string, timeoutMs: number): Promise<RawImage | null> {
  const store = id.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    store.get(id, (data) => {
      clearTimeout(timer);
      resolve((data as RawImage | null) ?? null);
    });
  });
}

/** One PDF page's images as PNG, in painting order; error when the page could not be read. */
export interface PageImages {
  page: number;
  images: Buffer[];
  error?: string;
}

/**
 * The images a scanned PDF draws on each page, decoded by pdfjs (JPEG, JBIG2, CCITT and the rest
 * in JavaScript, no canvas) and encoded as PNG for the collector's image OCR. Image masks are not
 * taken: their bits mean paint or skip rather than gray values.
 */
export async function* pdfPageImages(buffer: Buffer, o: { timeoutMs?: number } = {}): AsyncGenerator<PageImages> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    for (let n = 1; n <= doc.numPages; n++) {
      try {
        const page = (await doc.getPage(n)) as unknown as PdfPage;
        const ops = await page.getOperatorList();
        const images: Buffer[] = [];
        for (let i = 0; i < ops.fnArray.length; i++) {
          const fn = ops.fnArray[i];
          let img: RawImage | null = null;
          if (fn === pdfjs.OPS.paintImageXObject) {
            img = await objectOf(page, String(ops.argsArray[i]![0]), o.timeoutMs ?? 30_000);
          } else if (fn === pdfjs.OPS.paintInlineImageXObject) {
            img = ops.argsArray[i]![0] as RawImage;
          }
          const png = img ? encodePng(img) : null;
          if (png) images.push(png);
        }
        yield { page: n, images };
      } catch (e) {
        yield { page: n, images: [], error: (e as Error).message };
      }
    }
  } finally {
    await task.destroy();
  }
}
