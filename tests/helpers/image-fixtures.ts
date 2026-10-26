/** One synthetic main TIFF frame, with a single strip and explicit unsigned samples. */
export interface TiffFixtureFrame {
  /** Stored image width before orientation metadata is applied. */
  width: number;
  /** Stored image height before orientation metadata is applied. */
  height: number;
  /** Complete independently specified strip bytes, compressed only when compression is set. */
  pixels: readonly number[];
  /** Photometric interpretation: zero is white, one is black, two is RGB. */
  photometric: 0 | 1 | 2;
  /** One bit depth per sample; defaults to one eight-bit sample. */
  bits?: readonly number[];
  /** TIFF compression identifier; fixtures use raw or known Group 4 bytes. */
  compression?: 1 | 4;
  /** Original TIFF orientation descriptor, from one through eight. */
  orientation?: number;
}

/** Classic TIFF field used only by the independent fixture writer. */
interface FixtureTag {
  /** Numeric TIFF field identifier. */
  tag: number;
  /** This bounded writer needs only SHORT and LONG values. */
  type: 3 | 4;
  /** Integer values serialized inline or through an explicit absolute offset. */
  values: number[];
  /** Allocated position of an out-of-line field value. */
  offset?: number;
}

/** Build main-IFD chains without using the runtime decoder, image library, or external files. */
export function tiffFrames(
  /** Ordered fictional frames whose pixel identity remains observable after conversion. */
  frames: readonly TiffFixtureFrame[],
  /** Exercise both classic TIFF byte orders with the same independently known pixels. */
  littleEndian: boolean,
): Uint8Array {
  // Every directory is planned before payload offsets are assigned, including inline SHORT padding.
  const directories = frames.map((frame) => {
    const bits = [...(frame.bits ?? [8])];
    const tags: FixtureTag[] = [
      { tag: 256, type: 4, values: [frame.width] },
      { tag: 257, type: 4, values: [frame.height] },
      { tag: 258, type: 3, values: bits },
      { tag: 259, type: 3, values: [frame.compression ?? 1] },
      { tag: 262, type: 3, values: [frame.photometric] },
      { tag: 273, type: 4, values: [0] },
      { tag: 274, type: 3, values: [frame.orientation ?? 1] },
      { tag: 277, type: 3, values: [bits.length] },
      { tag: 278, type: 4, values: [frame.height] },
      { tag: 279, type: 4, values: [frame.pixels.length] },
      { tag: 284, type: 3, values: [1] },
    ];
    return { frame, tags, offset: 0, stripOffset: 0 };
  });
  let cursor = 8;
  for (const directory of directories) {
    directory.offset = cursor;
    cursor += 2 + directory.tags.length * 12 + 4;
  }
  for (const directory of directories) {
    directory.stripOffset = cursor;
    directory.tags.find((entry) => entry.tag === 273)!.values[0] = cursor;
    cursor += directory.frame.pixels.length;
    if (cursor % 2 !== 0) cursor += 1;
    for (const entry of directory.tags) {
      if (entry.values.length * (entry.type === 3 ? 2 : 4) > 4) {
        entry.offset = cursor;
        cursor += entry.values.length * (entry.type === 3 ? 2 : 4);
      }
    }
  }
  const bytes = new Uint8Array(cursor);
  const view = new DataView(bytes.buffer);
  bytes.set(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d]);
  view.setUint16(2, 42, littleEndian);
  view.setUint32(4, directories[0]?.offset ?? 0, littleEndian);
  for (const [index, directory] of directories.entries()) {
    view.setUint16(directory.offset, directory.tags.length, littleEndian);
    for (const [tagIndex, entry] of directory.tags.entries()) {
      const position = directory.offset + 2 + tagIndex * 12;
      view.setUint16(position, entry.tag, littleEndian);
      view.setUint16(position + 2, entry.type, littleEndian);
      view.setUint32(position + 4, entry.values.length, littleEndian);
      if (entry.offset !== undefined) view.setUint32(position + 8, entry.offset, littleEndian);
      const target = entry.offset ?? position + 8;
      for (const [valueIndex, value] of entry.values.entries()) {
        if (entry.type === 3) view.setUint16(target + valueIndex * 2, value, littleEndian);
        else view.setUint32(target + valueIndex * 4, value, littleEndian);
      }
    }
    view.setUint32(
      directory.offset + 2 + directory.tags.length * 12,
      directories[index + 1]?.offset ?? 0,
      littleEndian,
    );
    bytes.set(directory.frame.pixels, directory.stripOffset);
  }
  return bytes;
}

/** Insert one bounded EXIF orientation without recompressing the canvas-generated JPEG stream. */
export function jpegOrientation(
  /** Original independently produced JPEG, including its SOI marker. */
  jpeg: Uint8Array,
  /** EXIF transform descriptor tested through the real public image export API. */
  orientation: number,
): Uint8Array {
  // APP1 includes its big-endian length, the Exif identifier and one classic TIFF directory.
  const segment = new Uint8Array(36);
  segment.set([0xff, 0xe1, 0, 34, 0x45, 0x78, 0x69, 0x66, 0, 0]);
  const view = new DataView(segment.buffer, 10, 26);
  view.setUint16(0, 0x4949);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, 1, true);
  view.setUint16(10, 274, true);
  view.setUint16(12, 3, true);
  view.setUint32(14, 1, true);
  view.setUint16(18, orientation, true);
  return Uint8Array.from([...jpeg.subarray(0, 2), ...segment, ...jpeg.subarray(2)]);
}

/** Insert a valid PNG chunk before IDAT to exercise unsupported APNG independently from CRC errors. */
export function pngChunk(
  /** Original valid browser-generated PNG. */
  png: Uint8Array,
  /** Four ASCII bytes identifying the additional metadata chunk. */
  type: string,
  /** Complete chunk payload, excluding its length, type and checksum. */
  data: Uint8Array,
): Uint8Array {
  // CRC32 covers the chunk type and data, using the PNG polynomial rather than runtime parser code.
  const chunk = new Uint8Array(data.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) chunk[4 + index] = type.charCodeAt(index);
  chunk.set(data, 8);
  let crc = 0xffff_ffff;
  for (const value of chunk.subarray(4, 8 + data.length)) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  view.setUint32(8 + data.length, (crc ^ 0xffff_ffff) >>> 0);
  // The fixed IHDR chunk ends at byte 33 in every valid PNG used by these fixtures.
  return Uint8Array.from([...png.subarray(0, 33), ...chunk, ...png.subarray(33)]);
}
