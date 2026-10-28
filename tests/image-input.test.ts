import { describe, expect, it } from 'vite-plus/test';
import { deflateSync } from 'node:zlib';
import { inspectBitmap, validatePngData } from '../src/image-input';

/** Independently construct one checksummed PNG chunk for parser-boundary fixtures. */
function chunk(type: string, data: Uint8Array = new Uint8Array()): Uint8Array {
  const result = new Uint8Array(12 + data.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.length);
  result.set(
    Array.from(type, (letter) => letter.charCodeAt(0)),
    4,
  );
  result.set(data, 8);
  let crc = 0xffff_ffff;
  for (const value of result.subarray(4, result.length - 4)) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  view.setUint32(result.length - 4, (crc ^ 0xffff_ffff) >>> 0);
  return result;
}

/** Build a tiny real static PNG; malformed cases keep valid CRCs when testing header rules. */
function png(
  options: {
    width?: number;
    height?: number;
    color?: number;
    depth?: number;
    beforeData?: Uint8Array[];
    rawData?: Uint8Array;
    compressedData?: Uint8Array;
    interlace?: number;
  } = {},
): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, options.width ?? 1);
  view.setUint32(4, options.height ?? 2);
  header[8] = options.depth ?? 8;
  header[9] = options.color ?? 6;
  header[12] = options.interlace ?? 0;
  return Uint8Array.from([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...chunk('IHDR', header),
    ...(options.beforeData ?? []).flatMap((item) => Array.from(item)),
    ...chunk(
      'IDAT',
      options.compressedData ??
        deflateSync(options.rawData ?? Uint8Array.from([0, 255, 0, 0, 255, 0, 0, 0, 255, 255])),
    ),
    ...chunk('IEND'),
  ]);
}

/** Construct one bounded JPEG segment; this metadata fixture does not claim valid Huffman pixels. */
function segment(marker: number, payload: readonly number[] | Uint8Array): number[] {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

/** Build a classic EXIF directory with one orientation value in either byte order. */
function exif(orientation: number, littleEndian = true): Uint8Array {
  const data = new Uint8Array(26);
  const view = new DataView(data.buffer);
  view.setUint16(0, littleEndian ? 0x4949 : 0x4d4d);
  view.setUint16(2, 42, littleEndian);
  view.setUint32(4, 8, littleEndian);
  view.setUint16(8, 1, littleEndian);
  view.setUint16(10, 0x0112, littleEndian);
  view.setUint16(12, 3, littleEndian);
  view.setUint32(14, 1, littleEndian);
  view.setUint16(18, orientation, littleEndian);
  return data;
}

/** Build structurally complete baseline/progressive marker fixtures with explicit raw dimensions. */
function jpeg(
  options: { exif?: Uint8Array; components?: number; marker?: number; depth?: number } = {},
): Uint8Array {
  const count = options.components ?? 3;
  const frame = [options.depth ?? 8, 0, 2, 0, 3, count];
  const scan = [count];
  for (let index = 1; index <= count; index += 1) {
    frame.push(index, 0x11, 0);
    scan.push(index, 0);
  }
  scan.push(0, options.marker === 0xc2 ? 0 : 63, 0);
  return Uint8Array.from([
    0xff,
    0xd8,
    ...(options.exif ? segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, ...options.exif]) : []),
    ...segment(options.marker ?? 0xc0, frame),
    ...segment(0xda, scan),
    0,
    0xff,
    0x00,
    0xff,
    0xd0,
    0,
    0xff,
    0xd9,
  ]);
}

describe('direct bitmap input inspection', () => {
  it('recognizes real PNG dimensions, transparency and subarray offsets without changing bytes', () => {
    const original = png();
    const envelope = new Uint8Array(original.length + 11);
    envelope.set(original, 7);
    const source = envelope.subarray(7, 7 + original.length);
    expect(inspectBitmap(source)).toEqual({ format: 'png', width: 1, height: 2, orientation: 1 });
    expect(source).toEqual(original);
    expect(
      inspectBitmap(
        png({
          color: 3,
          depth: 1,
          beforeData: [
            chunk('PLTE', Uint8Array.from([255, 0, 0, 0, 0, 255])),
            chunk('tRNS', Uint8Array.from([255, 0])),
          ],
        }),
      ).format,
    ).toBe('png');
  });

  it('reads PNG eXIf orientation without a JPEG prefix and rejects ambiguous metadata', () => {
    for (const littleEndian of [true, false]) {
      expect(inspectBitmap(png({ beforeData: [chunk('eXIf', exif(6, littleEndian))] }))).toEqual({
        format: 'png',
        width: 1,
        height: 2,
        orientation: 6,
      });
    }
    for (const beforeData of [
      [chunk('eXIf', exif(0))],
      [chunk('eXIf', new Uint8Array(4))],
      [chunk('eXIf', exif(1)), chunk('eXIf', exif(6))],
    ]) {
      expect(() => inspectBitmap(png({ beforeData }))).toThrow(
        expect.objectContaining({ code: 'INVALID_SOURCE' }),
      );
    }
  });

  it('rejects PNG corruption, illegal palettes, unsupported animation and oversized dimensions', () => {
    const badCrc = png();
    badCrc[16] = badCrc[16]! ^ 1;
    const missingEnd = png().slice(0, -12);
    const trailing = Uint8Array.from([...png(), 0]);
    for (const source of [
      badCrc,
      missingEnd,
      trailing,
      png({ width: 0 }),
      png({ color: 6, depth: 4 }),
      png({ color: 3, beforeData: [] }),
    ]) {
      expect(() => inspectBitmap(source)).toThrow(
        expect.objectContaining({ code: 'INVALID_SOURCE' }),
      );
    }
    expect(() => inspectBitmap(png({ beforeData: [chunk('acTL', new Uint8Array(8))] }))).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_IMAGE' }),
    );
    expect(() => inspectBitmap(png({ width: 40_000_001, height: 1 }))).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_IMAGE' }),
    );
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'preserves EXIF orientation %s in both TIFF byte orders',
    (orientation) => {
      for (const littleEndian of [true, false]) {
        const source = jpeg({ exif: exif(orientation, littleEndian) });
        const original = source.slice();
        expect(inspectBitmap(source)).toEqual({ format: 'jpeg', width: 3, height: 2, orientation });
        expect(source).toEqual(original);
      }
    },
  );

  it('supports baseline/progressive grayscale, RGB and CMYK frame dimensions', () => {
    for (const marker of [0xc0, 0xc1, 0xc2]) {
      for (const components of [1, 3, 4]) {
        expect(inspectBitmap(jpeg({ marker, components }))).toEqual({
          format: 'jpeg',
          width: 3,
          height: 2,
          orientation: 1,
        });
      }
    }
  });

  it('rejects ambiguous EXIF orientation and directories escaping the bounded APP1 segment', () => {
    const outside = exif(1);
    new DataView(outside.buffer).setUint32(4, 0xffff_ffff, true);
    const badType = exif(1, false);
    new DataView(badType.buffer).setUint16(12, 4);
    const duplicate = new Uint8Array(38);
    duplicate.set(exif(1));
    const duplicateView = new DataView(duplicate.buffer);
    duplicateView.setUint16(8, 2, true);
    duplicate.set(duplicate.slice(10, 22), 22);
    const image = jpeg({ exif: exif(1) });
    const duplicateBlocks = Uint8Array.from([
      0xff,
      0xd8,
      ...segment(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, ...exif(1)]),
      ...image.subarray(2),
    ]);
    for (const source of [
      jpeg({ exif: exif(0) }),
      jpeg({ exif: exif(9) }),
      jpeg({ exif: outside }),
      jpeg({ exif: badType }),
      jpeg({ exif: duplicate }),
      duplicateBlocks,
    ]) {
      expect(() => inspectBitmap(source)).toThrow(
        expect.objectContaining({ code: 'INVALID_SOURCE' }),
      );
    }
  });

  it('rejects truncated JPEG frames/scans, unsupported coding modes and unrelated formats', () => {
    const missingEnd = jpeg().slice(0, -2);
    const noFrame = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const truncatedFrame = jpeg();
    truncatedFrame[5] = 0xff;
    for (const source of [missingEnd, noFrame, truncatedFrame]) {
      expect(() => inspectBitmap(source)).toThrow(
        expect.objectContaining({ code: 'INVALID_SOURCE' }),
      );
    }
    for (const source of [
      jpeg({ marker: 0xc3 }),
      jpeg({ depth: 12 }),
      jpeg({ components: 2 }),
      Uint8Array.from([0x47, 0x49, 0x46]),
    ]) {
      expect(() => inspectBitmap(source)).toThrow(
        expect.objectContaining({ code: 'UNSUPPORTED_IMAGE' }),
      );
    }
  });
});

describe('bounded PNG compressed scanlines', () => {
  it('accepts complete zlib data and tracks row filters across decoder chunk boundaries', async () => {
    await expect(validatePngData(png())).resolves.toBeUndefined();
    const raw = new Uint8Array((4096 * 4 + 1) * 2);
    raw[4096 * 4 + 1] = 4;
    await expect(
      validatePngData(png({ width: 4096, height: 2, rawData: raw })),
    ).resolves.toBeUndefined();
  });

  it('rejects valid zlib streams with empty, short or excess image rows', async () => {
    for (const length of [0, 4, 6]) {
      const source = png({ width: 1, height: 1, rawData: new Uint8Array(length) });
      expect(inspectBitmap(source).format).toBe('png');
      await expect(validatePngData(source)).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    }
  });

  it('rejects invalid zlib checksums despite a valid outer PNG chunk checksum', async () => {
    const compressed = Uint8Array.from(deflateSync(new Uint8Array(5)));
    compressed[compressed.length - 1] = compressed[compressed.length - 1]! ^ 1;
    const source = png({ width: 1, height: 1, compressedData: compressed });
    expect(inspectBitmap(source).format).toBe('png');
    await expect(validatePngData(source)).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
  });

  it('validates filter values and sums only nonempty Adam7 passes', async () => {
    const badFilter = png({ width: 1, height: 1, rawData: Uint8Array.from([5, 0, 0, 0, 0]) });
    await expect(validatePngData(badFilter)).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    // A 3x3 RGBA8 Adam7 image consumes 42 bytes across five nonempty passes, not 39 ordinary bytes.
    await expect(
      validatePngData(png({ width: 3, height: 3, interlace: 1, rawData: new Uint8Array(42) })),
    ).resolves.toBeUndefined();
    await expect(
      validatePngData(png({ width: 3, height: 3, interlace: 1, rawData: new Uint8Array(39) })),
    ).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    await expect(
      validatePngData(png({ width: 1, height: 1, interlace: 1, rawData: new Uint8Array(5) })),
    ).resolves.toBeUndefined();
  });

  it('preserves standard cancellation before allocating a decompression pipeline', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(validatePngData(png(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
