import type { IFD } from 'utif2';
import { RenderPDFError, throwIfAborted } from './diagnostics.js';
import { assertImageSize } from './image-geometry.js';
import { decodeCcitt } from './ccitt.js';

/** A single unrotated TIFF raster; the PDF writer applies its explicit orientation matrix. */
export interface TiffFrame {
  /** Original stored columns, before orientation. */
  width: number;
  /** Original stored rows, before orientation. */
  height: number;
  /** Straight-alpha eight-bit RGBA pixels owned by this decode. */
  rgba: Uint8Array;
  /** TIFF orientation in the inclusive range one through eight. */
  orientation: number;
}

/** Bounded metadata access without retaining decoded rasters for every page. */
export interface TiffDocument {
  /** Number of image-bearing main IFDs in their original linked order. */
  readonly pageCount: number;
  /** Decode one requested frame; no previous frame raster is retained. */
  decodeFrame(index: number): Promise<TiffFrame>;
}

/** Only numeric rendering tags reach the decoder; metadata never triggers nested IFD traversal. */
interface FrameMetadata {
  tags: Record<string, number[]>;
  width: number;
  height: number;
  orientation: number;
  bits: number;
  samples: number;
  compression: number;
  rowsPerStrip: number;
  offsets: number[];
  counts: number[];
  associatedAlpha: boolean;
}

/** Bound metadata enumeration before any raster allocations occur. */
const MAX_PAGES = 1_000;
/** TIFF field type byte sizes; unknown types cannot safely define an out-of-line value. */
const FIELD_SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];
/** Rendering tags are integers; all other metadata remains outside the pixel decoder. */
const INTEGER_TAGS = new Set([
  256, 257, 258, 259, 262, 266, 273, 274, 277, 278, 279, 284, 292, 293, 317, 320, 322, 323, 324,
  325, 330, 338, 339,
]);

/** Report a malformed container without allowing a partially generated image page. */
function malformed(message: string): never {
  throw new RenderPDFError('INVALID_SOURCE', `Invalid TIFF: ${message}`);
}

/** Reject a valid-looking image mode outside the explicitly supported scan profile. */
function unsupported(message: string): never {
  throw new RenderPDFError('UNSUPPORTED_IMAGE', `Unsupported TIFF: ${message}`);
}

/** Read and validate one scalar rendering tag, including its documented default. */
function scalar(tags: Record<string, number[]>, tag: number, fallback?: number): number {
  const values = tags[`t${tag}`];
  if (!values && fallback !== undefined) return fallback;
  if (!values || values.length !== 1 || !Number.isSafeInteger(values[0])) {
    malformed(`tag ${tag} requires one integer value.`);
  }
  return values[0]!;
}

/** Admit only pixel modes that the selected decoder converts without implicit color guessing. */
function frameMetadata(tags: Record<string, number[]>, length: number): FrameMetadata {
  const width = scalar(tags, 256);
  const height = scalar(tags, 257);
  assertImageSize(width, height);
  const orientation = scalar(tags, 274, 1);
  if (orientation < 1 || orientation > 8) malformed('orientation must be between 1 and 8.');
  const compression = scalar(tags, 259, 1);
  if (![1, 2, 3, 4, 5, 8, 32946, 32773].includes(compression)) {
    unsupported(
      `compression ${compression}; use uncompressed, CCITT, LZW, Deflate or PackBits strips.`,
    );
  }
  if ([322, 323, 324, 325, 330].some((tag) => tags[`t${tag}`])) {
    unsupported('tiled images and SubIFDs are not supported.');
  }
  if (scalar(tags, 284, 1) !== 1) unsupported('separate planar samples are not supported.');
  const samples = scalar(tags, 277, 1);
  const bitValues = tags.t258 ?? [1];
  const bits = bitValues[0]!;
  const sampleFormats = tags.t339 ?? [1];
  if (
    ![1, samples].includes(bitValues.length) ||
    bitValues.some((value) => value !== bits) ||
    ![1, samples].includes(sampleFormats.length) ||
    sampleFormats.some((format) => format !== 1)
  )
    unsupported('sample depths must match and samples must be unsigned integers.');
  const photometric = scalar(tags, 262);
  const gray =
    samples === 1 &&
    ((photometric === 0 && [1, 4, 8].includes(bits)) ||
      (photometric === 1 && [1, 2, 8].includes(bits)));
  const rgb = photometric === 2 && bits === 8 && [3, 4].includes(samples);
  const palette = photometric === 3 && samples === 1 && [1, 2, 4, 8].includes(bits);
  if (!gray && !rgb && !palette) unsupported('photometric interpretation, channels or bit depth.');
  const extras = tags.t338 ?? [];
  if (samples === 4 && (extras.length !== 1 || ![1, 2].includes(extras[0]!))) {
    unsupported('four-channel RGB requires an explicit associated or unassociated alpha sample.');
  }
  if (samples !== 4 && extras.length > 0)
    unsupported('extra samples are unsupported in this pixel mode.');
  if (palette && tags.t320?.length !== 3 * (1 << bits))
    malformed('the palette has an invalid size.');
  if (palette && tags.t320!.some((value) => value > 65535))
    malformed('palette entries must be sixteen-bit values.');
  const fillOrder = scalar(tags, 266, 1);
  const fax = [2, 3, 4].includes(compression);
  if (![1, 2].includes(fillOrder)) malformed('fill order must be 1 or 2.');
  if (fillOrder === 2 && !fax)
    unsupported('reversed fill order is supported only for CCITT scans.');
  if (fax && (!gray || bits !== 1 || samples !== 1))
    unsupported('CCITT compression requires bilevel grayscale.');
  if (compression === 3 && ![0, 1].includes(scalar(tags, 292, 0)))
    unsupported('unsupported Group 3 options.');
  if (compression === 4 && scalar(tags, 293, 0) !== 0)
    unsupported('uncompressed Group 4 extension mode.');
  const predictor = scalar(tags, 317, 1);
  if (
    predictor !== 1 &&
    !(predictor === 2 && bits === 8 && [1, 5, 8, 32946, 32773].includes(compression))
  ) {
    unsupported('only normal and eight-bit horizontal differencing predictors are supported.');
  }
  const rowsPerStrip = Math.min(scalar(tags, 278, height), height);
  if (rowsPerStrip <= 0) malformed('RowsPerStrip must be positive.');
  const offsets = tags.t273;
  const counts = tags.t279;
  if (
    !offsets ||
    !counts ||
    offsets.length !== counts.length ||
    offsets.length !== Math.ceil(height / rowsPerStrip)
  ) {
    malformed('strip offsets and byte counts must cover exactly the declared rows.');
  }
  for (let index = 0; index < offsets.length; index += 1) {
    const offset = offsets[index]!;
    const count = counts[index]!;
    if (offset < 8 || count <= 0 || offset > length - count)
      malformed('a strip extends outside the input.');
  }
  return {
    tags,
    width,
    height,
    orientation,
    bits,
    samples,
    compression,
    rowsPerStrip,
    offsets,
    counts,
    associatedAlpha: samples === 4 && extras[0] === 1,
  };
}

/** Enumerate classic main IFDs with checked offsets and no decoder-owned recursive metadata parsing. */
function parseFrames(bytes: Uint8Array): FrameMetadata[] {
  if (bytes.byteLength < 8) malformed('the header is truncated.');
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  if (!little && !(bytes[0] === 0x4d && bytes[1] === 0x4d))
    malformed('byte order must be II or MM.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint16(2, little);
  if (magic === 43) unsupported('BigTIFF is not supported.');
  if (magic !== 42) malformed('the classic TIFF signature is missing.');
  let offset = view.getUint32(4, little);
  const visited = new Set<number>();
  const frames: FrameMetadata[] = [];
  while (offset !== 0) {
    if (visited.has(offset)) malformed('the main IFD chain contains a cycle.');
    if (frames.length >= MAX_PAGES) unsupported('the file exceeds the 1000 frame limit.');
    visited.add(offset);
    if (offset < 8 || offset > bytes.length - 2) malformed('an IFD offset is outside the input.');
    const count = view.getUint16(offset, little);
    const end = offset + 2 + count * 12;
    if (end > bytes.length - 4) malformed('an IFD directory is truncated.');
    const tags: Record<string, number[]> = {};
    for (let index = 0; index < count; index += 1) {
      const entry = offset + 2 + index * 12;
      const tag = view.getUint16(entry, little);
      const type = view.getUint16(entry + 2, little);
      const values = view.getUint32(entry + 4, little);
      const size = FIELD_SIZES[type];
      if (!size || values === 0) malformed('an IFD field has an invalid type or count.');
      const byteLength = size * values;
      const position = byteLength <= 4 ? entry + 8 : view.getUint32(entry + 8, little);
      if (position > bytes.length - byteLength)
        malformed('an IFD value extends outside the input.');
      if (!INTEGER_TAGS.has(tag)) continue;
      if (![3, 4].includes(type))
        unsupported(`rendering tag ${tag} must use SHORT or LONG values.`);
      if (tags[`t${tag}`]) malformed(`rendering tag ${tag} occurs more than once.`);
      if (values > 1_000_000) unsupported('a rendering tag contains too many values.');
      const valuesRead: number[] = [];
      for (let value = 0; value < values; value += 1) {
        valuesRead.push(
          type === 3
            ? view.getUint16(position + value * 2, little)
            : view.getUint32(position + value * 4, little),
        );
      }
      tags[`t${tag}`] = valuesRead;
    }
    frames.push(frameMetadata(tags, bytes.length));
    offset = view.getUint32(end, little);
  }
  if (frames.length === 0) malformed('no main image IFD exists.');
  return frames;
}

/** Validate PackBits packet coverage instead of accepting the decoder's zero-filled tail. */
function validatePackBits(strip: Uint8Array, expected: number): void {
  let position = 0;
  let decoded = 0;
  while (position < strip.length) {
    const control = strip[position++]!;
    if (control <= 127) {
      const count = control + 1;
      if (position + count > strip.length) malformed('a PackBits literal is truncated.');
      position += count;
      decoded += count;
    } else if (control !== 128) {
      if (position >= strip.length) malformed('a PackBits repeat is truncated.');
      position += 1;
      decoded += 257 - control;
    }
    if (decoded > expected) malformed('PackBits output exceeds the declared strip size.');
  }
  if (decoded !== expected) malformed('PackBits output does not cover the declared strip.');
}

/** Check TIFF LZW dictionary transitions and exact output length without allocating another raster. */
function validateLzw(strip: Uint8Array, expected: number): void {
  const lengths = new Uint32Array(4096);
  for (let value = 0; value < 256; value += 1) lengths[value] = 1;
  let position = 0;
  let bits = 9;
  let next = 258;
  let previous = 0;
  let decoded = 0;
  let clear = false;
  while (position + bits <= strip.length * 8) {
    let code = 0;
    for (let bit = 0; bit < bits; bit += 1) {
      code = (code << 1) | ((strip[position >>> 3]! >>> (7 - (position & 7))) & 1);
      position += 1;
    }
    if (code === 256) {
      bits = 9;
      next = 258;
      previous = 0;
      clear = true;
      continue;
    }
    if (!clear) malformed('an LZW strip must start with its clear code.');
    if (code === 257) {
      if (decoded !== expected) malformed('LZW output does not cover the declared strip.');
      return;
    }
    const length = code < next ? lengths[code]! : code === next && previous > 0 ? previous + 1 : 0;
    if (!length) malformed('an LZW strip contains an invalid dictionary reference.');
    decoded += length;
    if (decoded > expected) malformed('LZW output exceeds the declared strip size.');
    if (previous > 0 && next < 4096) {
      lengths[next++] = previous + 1;
      if (bits < 12 && next === (1 << bits) - 1) bits += 1;
    }
    previous = length;
  }
  malformed('an LZW strip is missing its end code.');
}

/** Validate the zlib wrapper, checksum and exact byte count without buffering an entire decoded strip. */
async function validateDeflate(
  strip: Uint8Array,
  expected: number,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof DecompressionStream !== 'function')
    unsupported('Deflate requires DecompressionStream support.');
  const reader = new Blob([Uint8Array.from(strip)])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
    .getReader();
  let decoded = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      if (done) break;
      decoded += value.byteLength;
      if (decoded > expected) malformed('Deflate output exceeds the declared strip size.');
    }
    if (decoded !== expected) malformed('Deflate output does not cover the declared strip.');
  } catch (cause) {
    await reader.cancel().catch(() => undefined);
    throwIfAborted(signal);
    if (cause instanceof RenderPDFError) throw cause;
    throw new RenderPDFError(
      'INVALID_SOURCE',
      'Invalid TIFF: a Deflate strip is corrupt or truncated.',
      { cause },
    );
  } finally {
    reader.releaseLock();
  }
}

/** Open only metadata first; decode requested scan frames individually through public UTIF APIs.
 * @param input Complete caller-owned TIFF bytes; the adapter keeps an independent encoded copy.
 * @param signal Cooperative cancellation before metadata work and each synchronous frame decode.
 */
export async function openTiff(input: Uint8Array, signal?: AbortSignal): Promise<TiffDocument> {
  throwIfAborted(signal);
  const bytes = Uint8Array.from(input);
  const frames = parseFrames(bytes);
  throwIfAborted(signal);
  return {
    pageCount: frames.length,
    async decodeFrame(index: number): Promise<TiffFrame> {
      throwIfAborted(signal);
      if (!Number.isSafeInteger(index) || index < 0 || index >= frames.length)
        malformed('frame index is outside the document.');
      const frame = frames[index]!;
      const stride = Math.ceil((frame.width * frame.samples * frame.bits) / 8);
      // Fax runs decode into a fixed packed raster; UTIF's expanding temporary run arrays are bypassed.
      const faxPixels = [2, 3, 4].includes(frame.compression)
        ? new Uint8Array(stride * frame.height)
        : undefined;
      for (let strip = 0; strip < frame.offsets.length; strip += 1) {
        const rows = Math.min(frame.rowsPerStrip, frame.height - strip * frame.rowsPerStrip);
        const expected = rows * stride;
        const offset = frame.offsets[strip]!;
        const count = frame.counts[strip]!;
        if (faxPixels) {
          faxPixels.set(
            decodeCcitt(
              bytes.subarray(offset, offset + count),
              frame.width,
              rows,
              frame.compression,
              scalar(frame.tags, 266, 1),
              frame.compression === 3 && scalar(frame.tags, 292, 0) === 1,
              signal,
            ),
            strip * frame.rowsPerStrip * stride,
          );
        }
        if (frame.compression === 1 && count !== expected)
          malformed('an uncompressed strip has the wrong byte length.');
        if (frame.compression === 5) validateLzw(bytes.subarray(offset, offset + count), expected);
        if (frame.compression === 32773)
          validatePackBits(bytes.subarray(offset, offset + count), expected);
        if ([8, 32946].includes(frame.compression)) {
          await validateDeflate(bytes.subarray(offset, offset + count), expected, signal);
        }
      }
      // Fresh tags avoid retaining decoded pixel caches or allowing decoder mutations into metadata.
      const image = Object.fromEntries(
        Object.entries(frame.tags).map(([tag, values]) => [tag, [...values]]),
      ) as IFD;
      let rgba: Uint8Array;
      try {
        // Existing HTML and native PNG/JPEG exports never initialize the TIFF decoder.
        const UTIF = (await import('utif2')).default;
        throwIfAborted(signal);
        if (faxPixels) {
          // The public RGBA adapter needs the same metadata normally set by decodeImage.
          image.width = frame.width;
          image.height = frame.height;
          image.data = faxPixels;
        } else UTIF.decodeImage(bytes.buffer, image);
        if (!(image.data instanceof Uint8Array) || image.data.length !== stride * frame.height)
          malformed('the decoder returned an incomplete raster.');
        rgba = UTIF.toRGBA8(image);
      } catch (cause) {
        throwIfAborted(signal);
        if (cause instanceof RenderPDFError) throw cause;
        throw new RenderPDFError('RESOURCE_LOAD_FAILED', 'The TIFF frame could not be decoded.', {
          cause,
        });
      }
      if (rgba.length !== frame.width * frame.height * 4)
        malformed('the decoder returned an invalid RGBA raster.');
      if (frame.associatedAlpha) {
        for (let pixel = 0; pixel < rgba.length; pixel += 4) {
          const alpha = rgba[pixel + 3]!;
          for (let channel = 0; channel < 3; channel += 1) {
            rgba[pixel + channel] =
              alpha === 0 ? 0 : Math.min(255, Math.round((rgba[pixel + channel]! * 255) / alpha));
          }
        }
      }
      throwIfAborted(signal);
      return { width: frame.width, height: frame.height, rgba, orientation: frame.orientation };
    },
  };
}
