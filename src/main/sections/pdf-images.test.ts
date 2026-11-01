import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { encodeForOcr, OCR_MAX_SCALE, scaleGray, toGray, upscaleFactor } from './pdf-images.js';

/** Width and height from a PNG's IHDR chunk. */
const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20), colorType: png[25] });

describe('ocrUpscale helpers', () => {
  it('scales a page image to about 300 dpi and at least 2400 px wide, at most four times', () => {
    // A Letter page (612 pt) scanned at 100 dpi is 850 px wide.
    expect(upscaleFactor(850, 612)).toBeCloseTo(3, 1);
    // At 300 dpi it is 2550 px: nothing to do.
    expect(upscaleFactor(2550, 612)).toBe(1);
    // An A4 page (595 pt) at 200 dpi, 1653 px: to 2480 px.
    expect(upscaleFactor(1653, 595)).toBeCloseTo(2480 / 1653, 2);
    expect(upscaleFactor(100, 612)).toBe(OCR_MAX_SCALE);
  });

  it('turns 1-bit, RGB and RGBA images into gray', () => {
    // 1-bit: a set bit is white. Row of 10 pixels, two bytes.
    const bits = toGray({ width: 10, height: 1, kind: 1, data: new Uint8Array([0b10100000, 0b01000000]) });
    expect([...bits!.data]).toEqual([255, 0, 255, 0, 0, 0, 0, 0, 0, 255]);
    const rgb = toGray({ width: 2, height: 1, kind: 2, data: new Uint8Array([255, 255, 255, 255, 0, 0]) });
    expect([...rgb!.data]).toEqual([255, 76]);
    expect(toGray({ width: 1, height: 1, kind: 3, data: new Uint8Array([0, 0, 0, 255]) })!.data[0]).toBe(0);
    expect(toGray({ width: 1, height: 1, kind: 9, data: new Uint8Array([0]) })).toBeNull();
  });

  it('interpolates between pixels when scaling', () => {
    const big = scaleGray({ width: 2, height: 1, data: new Uint8Array([0, 255]) }, 2);
    expect(big.width).toBe(4);
    expect(big.height).toBe(2);
    expect([...big.data.slice(0, 4)]).toEqual([0, 64, 191, 255]);
  });

  it('writes the scaled image as an 8-bit gray PNG that decodes to the new size', () => {
    const img = { width: 850, height: 1100, kind: 1, data: new Uint8Array(Math.ceil(850 / 8) * 1100).fill(0xff) };
    const png = encodeForOcr(img, 612)!;
    const size = pngSize(png);
    expect(size.colorType).toBe(0);
    expect(size.width).toBeGreaterThanOrEqual(2400);
    expect(size.height).toBe(Math.round(1100 * (size.width / 850)));
    // Image data inflates to one filter byte plus one byte per pixel per row.
    const idat = png.subarray(33 + 8, png.length - 12 - 4);
    expect(zlib.inflateSync(idat).length).toBe((size.width + 1) * size.height);
  });
});
