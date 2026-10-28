import { RenderPDFError, throwIfAborted } from './diagnostics.js';
import { assertImageSize } from './image-geometry.js';

/** Validated native bitmap geometry; orientation transforms are applied by the PDF adapter. */
export interface BitmapInfo {
  /** Actual compressed format, independent of the filename and MIME type. */
  format: 'png' | 'jpeg';
  /** Encoded pixel width before EXIF rotation. */
  width: number;
  /** Encoded pixel height before EXIF rotation. */
  height: number;
  /** Standard EXIF orientation, defaulting to one when absent. */
  orientation: number;
}

/** Fail structural parsing without exposing a low-level DataView range error. */
function invalid(message: string): never {
  throw new RenderPDFError('INVALID_SOURCE', message);
}

/** PNG CRC values use the standard reflected polynomial, calculated once per module. */
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});

/** Compute a PNG chunk checksum over its type and payload, without copying caller bytes. */
function chunkCrc(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffff_ffff;
  for (let offset = start; offset < end; offset += 1) {
    crc = crcTable[(crc ^ bytes[offset]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

/** Validate a static PNG's bounded chunks before its pixel decoder allocates memory. */
function inspectPng(bytes: Uint8Array): BitmapInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let color = -1;
  let depth = 0;
  let paletteEntries = 0;
  let transparencySeen = false;
  let exifSeen = false;
  let orientation = 1;
  let dataSeen = false;
  let dataEnded = false;
  let dataBytes = 0;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) invalid('PNG contains a truncated chunk header.');
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) invalid('PNG chunk data extends beyond the input.');
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    if (
      typeBytes.some((value) => !((value >= 65 && value <= 90) || (value >= 97 && value <= 122)))
    ) {
      invalid('PNG chunk names must contain four ASCII letters.');
    }
    const type = String.fromCharCode(...typeBytes);
    if (chunkCrc(bytes, offset + 4, end - 4) !== view.getUint32(end - 4)) {
      invalid(`PNG ${type} chunk checksum is invalid.`);
    }
    if (offset === 8 && type !== 'IHDR') invalid('PNG must begin with its IHDR chunk.');
    const payload = offset + 8;
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) invalid('PNG requires exactly one 13-byte IHDR chunk.');
      width = view.getUint32(payload);
      height = view.getUint32(payload + 4);
      assertImageSize(width, height);
      depth = bytes[payload + 8]!;
      color = bytes[payload + 9]!;
      const depths: Record<number, readonly number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (!depths[color]?.includes(depth))
        invalid('PNG bit depth and color type are incompatible.');
      if (bytes[payload + 10] !== 0 || bytes[payload + 11] !== 0 || bytes[payload + 12]! > 1) {
        invalid('PNG compression, filtering or interlace settings are invalid.');
      }
    } else if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') {
      throw new RenderPDFError(
        'UNSUPPORTED_IMAGE',
        'Animated PNG is unsupported; provide a static PNG or a multipage TIFF.',
      );
    } else if (type === 'PLTE') {
      if (
        paletteEntries ||
        dataSeen ||
        length === 0 ||
        length % 3 !== 0 ||
        length > 768 ||
        color === 0 ||
        color === 4
      ) {
        invalid('PNG palette is invalid or appears after image data.');
      }
      paletteEntries = length / 3;
      if (color === 3 && paletteEntries > 2 ** depth)
        invalid('PNG palette exceeds its indexed bit depth.');
    } else if (type === 'tRNS') {
      if (
        transparencySeen ||
        dataSeen ||
        !(
          (color === 0 && length === 2) ||
          (color === 2 && length === 6) ||
          (color === 3 && length > 0 && length <= paletteEntries)
        )
      ) {
        invalid('PNG transparency is incompatible with its color type or palette.');
      }
      transparencySeen = true;
    } else if (type === 'eXIf') {
      if (exifSeen) invalid('PNG requires at most one eXIf chunk.');
      // PNG stores the TIFF header directly, without JPEG's six-byte Exif prefix.
      orientation = exifOrientation(bytes, payload, end - 4);
      exifSeen = true;
    } else if (type === 'IDAT') {
      if (dataEnded || (color === 3 && paletteEntries === 0))
        invalid('PNG image data must be contiguous and follow its palette.');
      dataSeen = true;
      dataBytes += length;
    } else if (type === 'IEND') {
      if (length !== 0 || !dataSeen || dataBytes === 0 || end !== bytes.length) {
        invalid('PNG must end with IEND after nonempty image data.');
      }
      return { format: 'png', width, height, orientation };
    } else if (typeBytes[0]! < 97) {
      throw new RenderPDFError('UNSUPPORTED_IMAGE', `Unsupported critical PNG chunk: ${type}.`);
    }
    if (dataSeen && type !== 'IDAT') dataEnded = true;
    offset = end;
  }
  invalid('PNG is missing its final IEND chunk.');
}

/** Read one bounded EXIF IFD0, ignoring unrelated metadata and thumbnail orientation. */
function exifOrientation(bytes: Uint8Array, start: number, end: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
  if (view.byteLength < 8) invalid('Image EXIF TIFF header is truncated.');
  const byteOrder = view.getUint16(0);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) invalid('Image EXIF byte order is invalid.');
  const littleEndian = byteOrder === 0x4949;
  if (view.getUint16(2, littleEndian) !== 42) invalid('Image EXIF requires a classic TIFF header.');
  const directory = view.getUint32(4, littleEndian);
  if (directory < 8 || directory + 2 > view.byteLength)
    invalid('Image EXIF IFD0 offset is outside its metadata segment.');
  const count = view.getUint16(directory, littleEndian);
  const directoryEnd = directory + 2 + count * 12;
  if (directoryEnd + 4 > view.byteLength)
    invalid('Image EXIF directory extends beyond its metadata segment.');
  let orientation = 1;
  let seen = false;
  for (let index = 0; index < count; index += 1) {
    const entry = directory + 2 + index * 12;
    if (view.getUint16(entry, littleEndian) !== 0x0112) continue;
    const value = view.getUint16(entry + 8, littleEndian);
    if (
      seen ||
      view.getUint16(entry + 2, littleEndian) !== 3 ||
      view.getUint32(entry + 4, littleEndian) !== 1 ||
      value < 1 ||
      value > 8
    ) {
      invalid('Image EXIF orientation must be one unambiguous SHORT value from 1 to 8.');
    }
    orientation = value;
    seen = true;
  }
  const next = view.getUint32(directoryEnd, littleEndian);
  if (next !== 0 && (next < 8 || next + 2 > view.byteLength))
    invalid('Image EXIF thumbnail directory is outside its metadata segment.');
  return orientation;
}

/** Validate JPEG markers and preserve the raw encoded dimensions and EXIF transform. */
function inspectJpeg(bytes: Uint8Array): BitmapInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  let width = 0;
  let height = 0;
  let orientation = 1;
  let exifSeen = false;
  let frameMarker = 0;
  let scanSeen = false;
  const components = new Set<number>();
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) invalid('JPEG marker structure is invalid.');
    offset += 1;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0 || marker === 0xd8)
      invalid('JPEG contains an invalid or truncated marker.');
    if (marker === 0xd9) {
      if (!frameMarker || !scanSeen || offset !== bytes.length)
        invalid('JPEG must end after a complete frame and scan.');
      return { format: 'jpeg', width, height, orientation };
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7))
      invalid('JPEG standalone markers are only supported inside scan data.');
    if (offset + 2 > bytes.length) invalid('JPEG segment length is truncated.');
    const length = view.getUint16(offset);
    const end = offset + length;
    if (length < 2 || end > bytes.length) invalid('JPEG segment extends beyond the input.');
    const payload = offset + 2;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      if (![0xc0, 0xc1, 0xc2].includes(marker)) {
        throw new RenderPDFError(
          'UNSUPPORTED_IMAGE',
          'JPEG requires baseline, extended sequential or progressive Huffman encoding.',
        );
      }
      if (frameMarker || length < 8) invalid('JPEG contains an invalid or duplicate frame header.');
      const count = bytes[payload + 5]!;
      if (length !== 8 + count * 3) invalid('JPEG frame components are truncated.');
      if (bytes[payload] !== 8 || ![1, 3, 4].includes(count)) {
        throw new RenderPDFError(
          'UNSUPPORTED_IMAGE',
          'JPEG requires 8-bit grayscale, RGB or CMYK pixels.',
        );
      }
      height = view.getUint16(payload + 1);
      width = view.getUint16(payload + 3);
      assertImageSize(width, height);
      for (let index = 0; index < count; index += 1) {
        const entry = payload + 6 + index * 3;
        const identifier = bytes[entry]!;
        const sampling = bytes[entry + 1]!;
        if (
          components.has(identifier) ||
          sampling >> 4 === 0 ||
          sampling >> 4 > 4 ||
          (sampling & 15) === 0 ||
          (sampling & 15) > 4 ||
          bytes[entry + 2]! > 3
        ) {
          invalid('JPEG frame component identifiers or sampling settings are invalid.');
        }
        components.add(identifier);
      }
      frameMarker = marker;
    } else if (
      marker === 0xe1 &&
      length >= 6 &&
      bytes[payload] === 0x45 &&
      bytes[payload + 1] === 0x78 &&
      bytes[payload + 2] === 0x69 &&
      bytes[payload + 3] === 0x66
    ) {
      if (exifSeen || length < 8 || bytes[payload + 4] !== 0 || bytes[payload + 5] !== 0) {
        invalid('JPEG contains ambiguous or malformed EXIF APP1 metadata.');
      }
      orientation = exifOrientation(bytes, payload + 6, end);
      exifSeen = true;
    } else if (marker === 0xda) {
      const count = bytes[payload];
      if (
        !frameMarker ||
        count === undefined ||
        count < 1 ||
        count > components.size ||
        length !== 6 + count * 2
      ) {
        invalid('JPEG scan header must follow a complete frame and select its components.');
      }
      const scanComponents = new Set<number>();
      for (let index = 0; index < count; index += 1) {
        const identifier = bytes[payload + 1 + index * 2]!;
        const tables = bytes[payload + 2 + index * 2]!;
        if (
          !components.has(identifier) ||
          scanComponents.has(identifier) ||
          tables >> 4 > 3 ||
          (tables & 15) > 3
        ) {
          invalid('JPEG scan components or Huffman table selectors are invalid.');
        }
        scanComponents.add(identifier);
      }
      const spectral = payload + 1 + count * 2;
      if (
        bytes[spectral]! > bytes[spectral + 1]! ||
        bytes[spectral + 1]! > 63 ||
        bytes[spectral + 2]! >> 4 > 13 ||
        (bytes[spectral + 2]! & 15) > 13 ||
        (frameMarker !== 0xc2 &&
          (bytes[spectral] !== 0 || bytes[spectral + 1] !== 63 || bytes[spectral + 2] !== 0))
      ) {
        invalid('JPEG scan spectral settings are invalid.');
      }
      scanSeen = true;
      offset = end;
      let entropyBytes = 0;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          entropyBytes += 1;
          offset += 1;
          continue;
        }
        const start = offset;
        offset += 1;
        while (bytes[offset] === 0xff) offset += 1;
        const next = bytes[offset];
        if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) {
          if (next === 0) entropyBytes += 1;
          offset += 1;
          continue;
        }
        offset = start;
        break;
      }
      if (entropyBytes === 0) invalid('JPEG scan data is empty or truncated.');
      continue;
    } else if ([0xdc, 0xde, 0xdf].includes(marker)) {
      throw new RenderPDFError(
        'UNSUPPORTED_IMAGE',
        'JPEG deferred-height and hierarchical frames are unsupported.',
      );
    }
    offset = end;
  }
  invalid('JPEG is missing its final EOI marker.');
}

/** Inspect PNG/JPEG bytes without a DOM, mutation, implicit file-type guessing or pixel allocation. */
export function inspectBitmap(bytes: Uint8Array): BitmapInfo {
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)
  ) {
    return inspectPng(bytes);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return inspectJpeg(bytes);
  throw new RenderPDFError('UNSUPPORTED_IMAGE', 'Provide PNG, JPEG or classic TIFF image bytes.');
}

/** Validate PNG's complete zlib stream and row layout before pdf-lib's permissive raw inflater. */
export async function validatePngData(
  /** Owned PNG bytes; filenames and MIME types never establish their validity. */
  bytes: Uint8Array,
  /** Optional cancellation released together with the native reader. */
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  // Native streams require ArrayBuffer-backed views; only a shared backing store needs copying.
  const input =
    bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : Uint8Array.from(bytes);
  const info = inspectBitmap(input);
  if (info.format !== 'png') invalid('PNG data validation requires PNG bytes.');
  if (typeof DecompressionStream !== 'function') {
    throw new RenderPDFError(
      'UNSUPPORTED_IMAGE',
      'PNG validation requires DecompressionStream support.',
    );
  }
  // Empty Adam7 passes consume no filter bytes; packed pixels round independently in every row.
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bitsPerPixel = channels[input[25]!]! * input[24]!;
  const steps =
    input[28] === 0
      ? [[0, 0, 1, 1]]
      : [
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2],
        ];
  const passes = steps.flatMap(([x = 0, y = 0, dx = 1, dy = 1]) => {
    const width = Math.max(0, Math.ceil((info.width - x) / dx));
    const rows = Math.max(0, Math.ceil((info.height - y) / dy));
    return width && rows ? [{ rows, stride: Math.ceil((width * bitsPerPixel) / 8) + 1 }] : [];
  });
  const expected = passes.reduce((total, pass) => total + pass.rows * pass.stride, 0);
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  // Enqueue original chunk views on demand rather than allocating another complete compressed image.
  let chunkOffset = 8;
  let dataStart = 0;
  let dataEnd = 0;
  const compressed = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      while (dataStart === dataEnd && chunkOffset < input.length) {
        const length = view.getUint32(chunkOffset);
        const payload = chunkOffset + 8;
        const imageData =
          input[chunkOffset + 4] === 73 &&
          input[chunkOffset + 5] === 68 &&
          input[chunkOffset + 6] === 65 &&
          input[chunkOffset + 7] === 84;
        chunkOffset += length + 12;
        if (imageData && length > 0) {
          dataStart = payload;
          dataEnd = payload + length;
        }
      }
      if (dataStart === dataEnd) {
        controller.close();
        return;
      }
      // Bound each native inflate write so a large IDAT cannot queue an entire decompression bomb.
      const end = Math.min(dataStart + 8192, dataEnd);
      controller.enqueue(input.subarray(dataStart, end));
      dataStart = end;
    },
  });
  const reader = compressed.pipeThrough(new DecompressionStream('deflate')).getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', abort, { once: true });
  let completed = false;
  let decoded = 0;
  let passIndex = 0;
  let rowsLeft = passes[0]?.rows ?? 0;
  let rowOffset = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const result = await reader.read();
      throwIfAborted(signal);
      if (result.done) break;
      decoded += result.value.length;
      if (decoded > expected)
        invalid('PNG decompressed data exceeds its declared scanline dimensions.');
      let offset = 0;
      while (offset < result.value.length) {
        const pass = passes[passIndex];
        if (!pass) invalid('PNG decompressed data contains unexpected image rows.');
        if (rowOffset === 0) {
          if (result.value[offset]! > 4)
            invalid('PNG scanline filter must be between zero and four.');
          offset += 1;
          rowOffset = 1;
        }
        const count = Math.min(result.value.length - offset, pass.stride - rowOffset);
        offset += count;
        rowOffset += count;
        if (rowOffset === pass.stride) {
          rowOffset = 0;
          rowsLeft -= 1;
          if (rowsLeft === 0) {
            passIndex += 1;
            rowsLeft = passes[passIndex]?.rows ?? 0;
          }
        }
      }
    }
    if (decoded !== expected || passIndex !== passes.length || rowOffset !== 0) {
      invalid('PNG decompressed data is shorter than its declared scanline dimensions.');
    }
    completed = true;
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof RenderPDFError) throw error;
    throw new RenderPDFError('INVALID_SOURCE', 'PNG compressed data or zlib checksum is invalid.', {
      cause: error,
    });
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
