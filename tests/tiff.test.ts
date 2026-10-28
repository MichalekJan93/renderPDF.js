import { describe, expect, it } from 'vite-plus/test';
import { deflateSync } from 'node:zlib';
import { openTiff } from '../src/tiff';

/** Synthetic page bytes and numeric TIFF tags; every fixture is generated without private documents. */
interface FixturePage {
  data: readonly number[];
  tags?: Record<number, number[]>;
}

/** Build classic TIFF main directories independently of the production metadata reader. */
function fixture(pages: FixturePage[], little = true): Uint8Array {
  const directories = pages.map((page) =>
    Object.entries({
      256: [2],
      257: [1],
      258: [8],
      259: [1],
      262: [1],
      273: [0],
      274: [1],
      277: [1],
      278: [1],
      279: [page.data.length],
      284: [1],
      ...page.tags,
    }).map(([name, values]) => ({
      tag: Number(name),
      values,
      type: [256, 257, 273, 278, 279].includes(Number(name)) ? 4 : 3,
      offset: 0,
    })),
  );
  const offsets: number[] = [];
  let position = 8;
  for (const entries of directories) {
    offsets.push(position);
    position += 2 + entries.length * 12 + 4;
  }
  for (const entries of directories)
    for (const entry of entries) {
      if (entry.values.length * (entry.type === 3 ? 2 : 4) > 4) {
        entry.offset = position;
        position += entry.values.length * (entry.type === 3 ? 2 : 4);
      }
    }
  const dataOffsets: number[] = [];
  for (const page of pages) {
    dataOffsets.push(position);
    position += page.data.length;
  }
  const bytes = new Uint8Array(position);
  const view = new DataView(bytes.buffer);
  bytes[0] = bytes[1] = little ? 0x49 : 0x4d;
  view.setUint16(2, 42, little);
  view.setUint32(4, offsets[0] ?? 0, little);
  directories.forEach((entries, page) => {
    const directory = offsets[page]!;
    view.setUint16(directory, entries.length, little);
    entries.forEach((entry, index) => {
      const address = directory + 2 + index * 12;
      view.setUint16(address, entry.tag, little);
      view.setUint16(address + 2, entry.type, little);
      view.setUint32(address + 4, entry.values.length, little);
      if (entry.offset) view.setUint32(address + 8, entry.offset, little);
      entry.values.forEach((value, item) => {
        const target = (entry.offset || address + 8) + item * (entry.type === 3 ? 2 : 4);
        const stored = entry.tag === 273 ? dataOffsets[page]! : value;
        if (entry.type === 3) view.setUint16(target, stored, little);
        else view.setUint32(target, stored, little);
      });
    });
    view.setUint32(directory + 2 + entries.length * 12, offsets[page + 1] ?? 0, little);
    bytes.set(pages[page]!.data, dataOffsets[page]!);
  });
  return bytes;
}

/** Mutate a little-endian fixture's scalar tag for deliberate structural corruption tests. */
function setScalar(bytes: Uint8Array, tag: number, value: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = view.getUint32(4, true);
  for (let index = 0; index < view.getUint16(offset, true); index += 1) {
    const entry = offset + 2 + index * 12;
    if (view.getUint16(entry, true) !== tag) continue;
    if (view.getUint16(entry + 2, true) === 3) view.setUint16(entry + 8, value, true);
    else view.setUint32(entry + 8, value, true);
    return;
  }
  throw new Error(`Fixture tag ${tag} was not found.`);
}

describe('bounded classic TIFF scan decoding', () => {
  it.each([true, false])(
    'decodes unsigned grayscale in either byte order (little=%s)',
    async (little) => {
      const document = await openTiff(fixture([{ data: [0, 255], tags: { 274: [6] } }], little));
      expect(document.pageCount).toBe(1);
      expect(await document.decodeFrame(0)).toEqual({
        width: 2,
        height: 1,
        orientation: 6,
        rgba: Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 255]),
      });
    },
  );

  it('keeps main IFD page order, mixed pixel modes and caller bytes independent', async () => {
    const bytes = fixture([
      { data: [0, 255] },
      { data: [255, 0, 0, 0, 255, 0], tags: { 262: [2], 277: [3], 258: [8, 8, 8] } },
    ]);
    const document = await openTiff(bytes);
    bytes.fill(0);
    expect(document.pageCount).toBe(2);
    expect(Array.from((await document.decodeFrame(0)).rgba)).toEqual([
      0, 0, 0, 255, 255, 255, 255, 255,
    ]);
    expect(Array.from((await document.decodeFrame(1)).rgba)).toEqual([
      255, 0, 0, 255, 0, 255, 0, 255,
    ]);
    expect(await document.decodeFrame(0)).toEqual(await document.decodeFrame(0));
  });

  it('converts palette indexes and unassociates premultiplied RGB alpha', async () => {
    const palette = await openTiff(
      fixture([
        {
          data: [0x40],
          tags: {
            258: [1],
            262: [3],
            320: [65535, 0, 0, 65535, 0, 0],
          },
        },
      ]),
    );
    expect(Array.from((await palette.decodeFrame(0)).rgba)).toEqual([
      255, 0, 0, 255, 0, 255, 0, 255,
    ]);
    const alpha = await openTiff(
      fixture([
        {
          data: [64, 0, 0, 128, 0, 255, 0, 255],
          tags: {
            262: [2],
            277: [4],
            258: [8, 8, 8, 8],
            338: [1],
          },
        },
      ]),
    );
    expect(Array.from((await alpha.decodeFrame(0)).rgba)).toEqual([128, 0, 0, 128, 0, 255, 0, 255]);
  });

  it('decodes a genuine CCITT Group 4 scan with independently known black and white pixels', async () => {
    // Pillow/libtiff encoded this synthetic 8x4 bitmap; an independent Pillow decode verified it.
    const data = [38, 185, 126, 35, 38, 168, 142, 136, 232, 37, 136, 139, 0, 16, 1];
    const document = await openTiff(
      fixture([
        {
          data,
          tags: {
            256: [8],
            257: [4],
            258: [1],
            259: [4],
            262: [0],
            278: [4],
          },
        },
      ]),
    );
    const pixels = [
      0, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 255, 0, 255, 0,
      255, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0,
    ];
    expect(Array.from((await document.decodeFrame(0)).rgba)).toEqual(
      pixels.flatMap((pixel) => [pixel, pixel, pixel, 255]),
    );
  });

  it.each([
    { compression: 5, data: [128, 0, 31, 240, 16] },
    { compression: 32773, data: [1, 0, 255] },
  ])('validates and decodes compressed grayscale ($compression)', async ({ compression, data }) => {
    const document = await openTiff(fixture([{ data, tags: { 259: [compression] } }]));
    expect(Array.from((await document.decodeFrame(0)).rgba)).toEqual([
      0, 0, 0, 255, 255, 255, 255, 255,
    ]);
  });

  it.each([8, 32946])(
    'validates zlib checksum and byte count for Deflate compression %s',
    async (compression) => {
      const data = Array.from(deflateSync(Uint8Array.from([20, 10])));
      const document = await openTiff(fixture([{ data, tags: { 259: [compression], 317: [2] } }]));
      expect(Array.from((await document.decodeFrame(0)).rgba)).toEqual([
        20, 20, 20, 255, 30, 30, 30, 255,
      ]);
      data[data.length - 1]! ^= 0xff;
      const corrupt = await openTiff(fixture([{ data, tags: { 259: [compression] } }]));
      await expect(corrupt.decodeFrame(0)).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    },
  );

  it.each([
    { data: [0], compression: 1 },
    { data: [2, 0, 255], compression: 32773 },
    { data: [128, 0, 31], compression: 5 },
  ])(
    'rejects incomplete raster streams instead of zero-filling ($compression)',
    async ({ data, compression }) => {
      const document = await openTiff(fixture([{ data, tags: { 259: [compression] } }]));
      await expect(document.decodeFrame(0)).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    },
  );

  it('rejects cycles, truncated directories and strip offsets outside the file', async () => {
    const cycle = fixture([{ data: [0, 255] }]);
    const view = new DataView(cycle.buffer);
    const count = view.getUint16(8, true);
    view.setUint32(8 + 2 + count * 12, 8, true);
    await expect(openTiff(cycle)).rejects.toThrow('cycle');
    await expect(openTiff(cycle.subarray(0, 20))).rejects.toThrow('truncated');
    const strip = fixture([{ data: [0, 255] }]);
    setScalar(strip, 273, strip.length + 1);
    await expect(openTiff(strip)).rejects.toThrow('outside');
  });

  it.each([
    { 259: [65000] },
    { 284: [2] },
    { 322: [16] },
    { 339: [3] },
    { 258: [16] },
    { 256: [40_000_001] },
  ])('fails explicitly for unsupported codecs, modes and oversized frames (%j)', async (tags) => {
    await expect(openTiff(fixture([{ data: [0, 255], tags }]))).rejects.toMatchObject({
      code: 'UNSUPPORTED_IMAGE',
    });
  });

  it('rejects BigTIFF and supports cancellation before metadata or a later frame decode', async () => {
    const bytes = fixture([{ data: [0, 255] }]);
    const big = Uint8Array.from(bytes);
    new DataView(big.buffer).setUint16(2, 43, true);
    await expect(openTiff(big)).rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE' });
    const controller = new AbortController();
    const document = await openTiff(bytes, controller.signal);
    controller.abort();
    await expect(document.decodeFrame(0)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(openTiff(bytes, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
