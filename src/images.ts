import { RenderPDFError } from './diagnostics.js';

/** Explain why unchanged JPEG pixels cannot match the browser's EXIF transformation. */
function unsupportedExif(): never {
  throw new RenderPDFError(
    'RESOURCE_LOAD_FAILED',
    'JPEG EXIF orientation must be 1 with valid metadata; normalize the image pixels and remove orientation metadata before exporting.',
  );
}

/** Validate orientation in a single bounded APP1 TIFF directory without following external data. */
function assertUnrotatedExif(
  /** Complete source JPEG, including the bounded metadata segment. */
  bytes: Uint8Array,
  /** First TIFF byte following the Exif signature. */
  start: number,
  /** Exclusive APP1 segment end; TIFF offsets must stay inside this interval. */
  end: number,
): void {
  // A segment-local view makes every metadata read independent of the image's remaining bytes.
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
  if (view.byteLength < 8) unsupportedExif();
  // TIFF permits either endian order, but its byte order and magic must agree.
  const byteOrder = view.getUint16(0);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) unsupportedExif();
  // Every numeric field after the byte-order marker follows this endian flag.
  const littleEndian = byteOrder === 0x4949;
  if (view.getUint16(2, littleEndian) !== 42) unsupportedExif();
  // Orientation belongs to IFD0; the thumbnail directory does not orient the main image.
  const directoryOffset = view.getUint32(4, littleEndian);
  if (directoryOffset < 8 || directoryOffset + 2 > view.byteLength) unsupportedExif();
  // Entry counts are accepted only when their complete fixed-width directory fits APP1.
  const count = view.getUint16(directoryOffset, littleEndian);
  // The four-byte next-directory pointer is part of every complete TIFF directory.
  const directoryEnd = directoryOffset + 2 + count * 12;
  if (directoryEnd + 4 > view.byteLength) unsupportedExif();
  // Duplicate orientation tags are ambiguous even when a browser tolerates them.
  let orientationSeen = false;
  for (let index = 0; index < count; index += 1) {
    // Each TIFF directory entry occupies exactly 12 bytes within the validated interval.
    const entry = directoryOffset + 2 + index * 12;
    if (view.getUint16(entry, littleEndian) !== 0x0112) continue;
    if (
      orientationSeen ||
      view.getUint16(entry + 2, littleEndian) !== 3 ||
      view.getUint32(entry + 4, littleEndian) !== 1 ||
      view.getUint16(entry + 8, littleEndian) !== 1
    ) {
      unsupportedExif();
    }
    orientationSeen = true;
  }
  // An optional thumbnail directory may exist, but its pointer must remain inside APP1.
  const nextDirectory = view.getUint32(directoryEnd, littleEndian);
  if (nextDirectory !== 0 && (nextDirectory < 8 || nextDirectory + 2 > view.byteLength)) {
    unsupportedExif();
  }
}

/** Identify native bitmap bytes and reject unsupported or ambiguous JPEG orientation. */
export function nativeImageFormat(
  /** Original browser-accessible compressed image; no filename or MIME type is trusted. */
  bytes: Uint8Array,
): 'png' | 'jpeg' {
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new RenderPDFError(
      'RESOURCE_LOAD_FAILED',
      'Native PDF images require PNG or JPEG bytes.',
    );
  }
  // JPEG metadata segments precede entropy-coded scan data; stop at SOS rather than parsing pixels.
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) unsupportedExif();
    while (bytes[offset] === 0xff) offset += 1;
    // Marker fill bytes are allowed, but a trailing or stuffed zero marker is malformed here.
    const marker = bytes[offset];
    if (marker === undefined || marker === 0) unsupportedExif();
    offset += 1;
    if (marker === 0xd9) return 'jpeg';
    // Standalone markers carry no two-byte segment length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) unsupportedExif();
    // Segment length includes its two-byte length field, but excludes the marker itself.
    const length = bytes[offset]! * 256 + bytes[offset + 1]!;
    // Bounds are validated before interpreting any metadata or scan header.
    const end = offset + length;
    if (length < 2 || end > bytes.length) unsupportedExif();
    if (marker === 0xda) return 'jpeg';
    // APP1 may contain XMP instead of Exif; only the explicit Exif signature is interpreted.
    const payload = offset + 2;
    if (
      marker === 0xe1 &&
      end - payload >= 4 &&
      bytes[payload] === 0x45 &&
      bytes[payload + 1] === 0x78 &&
      bytes[payload + 2] === 0x69 &&
      bytes[payload + 3] === 0x66
    ) {
      if (end - payload < 6 || bytes[payload + 4] !== 0 || bytes[payload + 5] !== 0) {
        unsupportedExif();
      }
      assertUnrotatedExif(bytes, payload + 6, end);
    }
    offset = end;
  }
  unsupportedExif();
}
