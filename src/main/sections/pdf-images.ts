import path from 'node:path';
import zlib from 'node:zlib';

/**
 * pdfjs-dist 6 decodes JBIG2 and JPEG 2000 with WebAssembly it loads from wasmUrl; without it those
 * images come back empty and a scan stored as JBIG2 (most black-and-white scans) gives no page
 * images. Resolved like the tesseract data (src/main/tesseract.ts), so it works from app.asar too.
 */
function pdfjsWasmUrl(): string | undefined {
  try {
    return path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'wasm') + path.sep;
  } catch {
    return undefined;
  }
}

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

/** Target resolution of ocrUpscale: tesseract reads best at about 300 dpi. */
export const OCR_DPI = 300;
/** Smallest page image width after ocrUpscale, in pixels (a Letter page at 280 dpi). */
export const OCR_MIN_WIDTH = 2400;
/** Largest scale factor, so a thumbnail-sized image is not blown up into a huge one. */
export const OCR_MAX_SCALE = 4;

/** One byte of gray per pixel, 0 black to 255 white. */
export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A pdf.js image as 8-bit gray: 1-bit rows unpacked, RGB and RGBA by luminance. Null for other kinds. */
export function toGray(img: RawImage): GrayImage | null {
  const { width, height, kind, data } = img;
  if (width <= 0 || height <= 0) return null;
  const out = new Uint8Array(width * height);
  if (kind === 1) {
    const rowBytes = Math.ceil(width / 8);
    if (data.length < rowBytes * height) return null;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        out[y * width + x] = (data[y * rowBytes + (x >> 3)]! >> (7 - (x & 7))) & 1 ? 255 : 0;
    return { width, height, data: out };
  }
  const step = kind === 2 ? 3 : kind === 3 ? 4 : 0;
  if (!step || data.length < width * height * step) return null;
  for (let p = 0, i = 0; p < width * height; p++, i += step) {
    out[p] = Math.round(0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!);
  }
  return { width, height, data: out };
}

/** Bilinear scaling of a gray image by factor (above 1). */
export function scaleGray(img: GrayImage, factor: number): GrayImage {
  const width = Math.max(1, Math.round(img.width * factor));
  const height = Math.max(1, Math.round(img.height * factor));
  const out = new Uint8Array(width * height);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.min(img.height - 1, Math.floor(fy));
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.min(img.width - 1, Math.floor(fx));
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = fx - x0;
      const a = img.data[y0 * img.width + x0]!;
      const b = img.data[y0 * img.width + x1]!;
      const c = img.data[y1 * img.width + x0]!;
      const d = img.data[y1 * img.width + x1]!;
      out[y * width + x] = Math.round((a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy);
    }
  }
  return { width, height, data: out };
}

/**
 * Scale factor that brings an image drawn across a page pageWidthPt points wide to OCR_DPI and at
 * least OCR_MIN_WIDTH pixels, at most OCR_MAX_SCALE; 1 when it is there already.
 */
export function upscaleFactor(imageWidth: number, pageWidthPt: number): number {
  if (imageWidth <= 0) return 1;
  const dpi = pageWidthPt > 0 ? imageWidth / (pageWidthPt / 72) : Infinity;
  const f = Math.min(OCR_MAX_SCALE, Math.max(OCR_MIN_WIDTH / imageWidth, OCR_DPI / dpi));
  return f > 1.05 ? f : 1;
}

/** PNG of an image scaled for OCR (ocrUpscale), or of the image as it is when it needs no scaling. */
export function encodeForOcr(img: RawImage, pageWidthPt: number): Buffer | null {
  const f = upscaleFactor(img.width, pageWidthPt);
  if (f === 1) return encodePng(img);
  const gray = toGray(img);
  if (!gray) return encodePng(img);
  const big = scaleGray(gray, f);
  return encodeRows(big.width, big.height, big.data, { colorType: 0, depth: 8, rowBytes: big.width });
}

interface PdfPage {
  view?: number[];
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
 * taken: their bits mean paint or skip rather than gray values. With upscale (ocrUpscale) an image
 * below OCR_DPI for the page width, or narrower than OCR_MIN_WIDTH, is scaled up first.
 */
export async function* pdfPageImages(
  buffer: Buffer,
  o: { timeoutMs?: number; pages?: number[]; upscale?: boolean } = {},
): AsyncGenerator<PageImages> {
  const only = o.pages ? new Set(o.pages) : null;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    wasmUrl: pdfjsWasmUrl(),
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    for (let n = 1; n <= doc.numPages; n++) {
      if (only && !only.has(n)) continue;
      try {
        const page = (await doc.getPage(n)) as unknown as PdfPage;
        const view = page.view ?? [];
        const pageWidth = view.length === 4 ? Math.abs(view[2]! - view[0]!) : 612;
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
          const png = img ? (o.upscale ? encodeForOcr(img, pageWidth) : encodePng(img)) : null;
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
