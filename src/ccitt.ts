import { RenderPDFError, throwIfAborted } from './diagnostics.js';
import { assertImageSize } from './image-geometry.js';

/** T.4 terminating white run codes, indexed by the represented zero-to-63 pixel length. */
const WHITE_TERMINATING =
  '00110101,000111,0111,1000,1011,1100,1110,1111,10011,10100,00111,01000,001000,000011,110100,110101,' +
  '101010,101011,0100111,0001100,0001000,0010111,0000011,0000100,0101000,0101011,0010011,0100100,0011000,00000010,00000011,00011010,' +
  '00011011,00010010,00010011,00010100,00010101,00010110,00010111,00101000,00101001,00101010,00101011,00101100,00101101,00000100,00000101,00001010,' +
  '00001011,01010010,01010011,01010100,01010101,00100100,00100101,01011000,01011001,01011010,01011011,01001010,01001011,00110010,00110011,00110100';

/** T.4 terminating black run codes, indexed by the represented zero-to-63 pixel length. */
const BLACK_TERMINATING =
  '0000110111,010,11,10,011,0011,0010,00011,000101,000100,0000100,0000101,0000111,00000100,00000111,000011000,' +
  '0000010111,0000011000,0000001000,00001100111,00001101000,00001101100,00000110111,00000101000,00000010111,00000011000,000011001010,000011001011,000011001100,000011001101,000001101000,000001101001,' +
  '000001101010,000001101011,000011010010,000011010011,000011010100,000011010101,000011010110,000011010111,000001101100,000001101101,000011011010,000011011011,000001010100,000001010101,000001010110,000001010111,' +
  '000001100100,000001100101,000001010010,000001010011,000000100100,000000110111,000000111000,000000100111,000000101000,000001011000,000001011001,000000101011,000000101100,000001011010,000001100110,000001100111';

/** T.4 white makeup codes, indexed by represented multiples of 64 from 64 through 1728. */
const WHITE_MAKEUP =
  '11011,10010,010111,0110111,00110110,00110111,01100100,01100101,01101000,01100111,011001100,011001101,011010010,011010011,011010100,011010101,011010110,' +
  '011010111,011011000,011011001,011011010,011011011,010011000,010011001,010011010,011000,010011011';

/** T.4 black makeup codes, indexed by represented multiples of 64 from 64 through 1728. */
const BLACK_MAKEUP =
  '0000001111,000011001000,000011001001,000001011011,000000110011,000000110100,000000110101,0000001101100,0000001101101,0000001001010,0000001001011,0000001001100,' +
  '0000001001101,0000001110010,0000001110011,0000001110100,0000001110101,0000001110110,0000001110111,0000001010010,0000001010011,0000001010100,0000001010101,0000001011010,' +
  '0000001011011,0000001100100,0000001100101';

/** Shared T.4 additional makeup codes for represented lengths 1792 through 2560 in steps of 64. */
const ADDITIONAL_MAKEUP =
  '00000001000,00000001100,00000001101,000000010010,000000010011,000000010100,000000010101,000000010110,000000010111,000000011100,000000011101,000000011110,000000011111';

/** Turn standard T.4 codewords into bounded numeric prefix lookups; no decoder-private tables are used.
 * Code values follow ITU-T T.4 tables 1/2, also reproduced in TIFF 6.0 sections 10/11:
 * https://www.itu.int/itudoc/itu-t/com16/tiff-fx/docs/tiff6.pdf .
 * @param terminating Run codes for lengths below 64 pixels.
 * @param makeup Run codes for lengths 64 through 1728 pixels.
 */
function runCodes(terminating: string, makeup: string): ReadonlyMap<number, number> {
  // A leading sentinel bit retains each codeword's significant zero prefix.
  const entries = new Map<number, number>();
  for (const [codes, start, step] of [
    [terminating, 0, 1],
    [makeup, 64, 64],
    [ADDITIONAL_MAKEUP, 1792, 64],
  ] as const) {
    for (const [index, code] of codes.split(',').entries()) {
      entries.set(Number.parseInt(`1${code}`, 2), start + index * step);
    }
  }
  return entries;
}

/** White and black standard Huffman lookups; each code consumes at most thirteen source bits. */
const RUN_CODES = [
  runCodes(WHITE_TERMINATING, WHITE_MAKEUP),
  runCodes(BLACK_TERMINATING, BLACK_MAKEUP),
];

/** T.4/T.6 vertical offsets and pass/horizontal modes, keyed by sentinel-prefixed codewords. */
const MODES: ReadonlyMap<number, number> = new Map([
  [0b11, 0],
  [0b1011, 1],
  [0b1010, -1],
  [0b1000011, 2],
  [0b1000010, -2],
  [0b10000011, 3],
  [0b10000010, -3],
  [0b10001, 4],
  [0b1001, 5],
]);

/** One strip's checked bit cursor, independent of TIFF metadata and raster storage. */
interface BitReader {
  /** Encoded strip bytes, never copied or expanded by the bit reader. */
  bytes: Uint8Array;
  /** TIFF bit order within each encoded byte. */
  fillOrder: number;
  /** Next bit's zero-based position relative to this strip. */
  position: number;
}

/** Reject malformed fax input before any run can grow an intermediate pixel array.
 * @param message Specific violated encoded-data invariant.
 */
function malformed(message: string): never {
  throw new RenderPDFError('INVALID_SOURCE', `Invalid TIFF CCITT: ${message}`);
}

/** Consume one checked bit without reading neighboring strips or synthesizing missing data.
 * @param reader Source bytes, fill order and current strip-relative position.
 */
function bit(reader: BitReader): number {
  if (reader.position >= reader.bytes.length * 8) malformed('the strip is truncated.');
  // FillOrder reverses encoded bits only; decoded pixels always use TIFF's packed MSB order.
  const position = reader.position++;
  const shift = reader.fillOrder === 1 ? 7 - (position & 7) : position & 7;
  return (reader.bytes[position >>> 3]! >>> shift) & 1;
}

/** Read a complete bounded run, including the mandatory terminating word after any makeup words.
 * @param reader Current encoded bit position.
 * @param color Zero means white and one means black, independent of photometric interpretation.
 * @param remaining Maximum pixels still available in the current scanline.
 */
function run(reader: BitReader, color: number, remaining: number): number {
  // Only a numeric total is accumulated; malformed makeup words never allocate represented pixels.
  let total = 0;
  for (;;) {
    let key = 1;
    let length: number | undefined;
    for (let count = 0; count < 13; count += 1) {
      key = key * 2 + bit(reader);
      length = RUN_CODES[color]!.get(key);
      if (length !== undefined) break;
    }
    if (length === undefined) malformed('a run has an invalid Huffman code.');
    total += length;
    if (total > remaining) malformed('a run exceeds its declared scanline width.');
    if (length < 64) return total;
  }
}

/** Set a validated black run directly inside its fixed-size packed scanline.
 * @param pixels Entire bounded strip raster, initially white.
 * @param offset Start byte of the current scanline.
 * @param start Inclusive scanline-relative pixel position.
 * @param end Exclusive scanline-relative pixel position.
 */
function blackRun(pixels: Uint8Array, offset: number, start: number, end: number): void {
  // At most fourteen edge bits need individual writes; aligned interior bytes use a bounded fill.
  while (start < end && (start & 7) !== 0) {
    pixels[offset + (start >>> 3)]! |= 1 << (7 - (start & 7));
    start += 1;
  }
  const alignedEnd = end - (end & 7);
  if (alignedEnd > start) {
    pixels.fill(255, offset + (start >>> 3), offset + (alignedEnd >>> 3));
    start = alignedEnd;
  }
  while (start < end) {
    pixels[offset + (start >>> 3)]! |= 1 << (7 - (start & 7));
    start += 1;
  }
}

/** Find a reference-line change without materializing an expanding array of run pixels.
 * @param pixels Already decoded packed rows, with zero bits representing white.
 * @param offset Reference row byte offset; a negative offset denotes the virtual all-white row.
 * @param width Declared pixels in one scanline.
 * @param start Inclusive first reference position to inspect.
 * @param color Color immediately after the desired reference change.
 */
function change(
  pixels: Uint8Array,
  offset: number,
  width: number,
  start: number,
  color: number,
): number {
  if (offset < 0 || start >= width) return width;
  // Reference scans move forward with the coding row; only the last few pixels may be revisited.
  let previous =
    start === 0 ? 0 : (pixels[offset + ((start - 1) >>> 3)]! >>> (7 - ((start - 1) & 7))) & 1;
  for (let position = start; position < width; position += 1) {
    const current = (pixels[offset + (position >>> 3)]! >>> (7 - (position & 7))) & 1;
    if (current !== previous && current === color) return position;
    previous = current;
  }
  return width;
}

/** Read one T.4 EOL, admitting only its bounded optional byte-alignment zeros.
 * @param reader Source bit cursor before an encoded Group 3 scanline.
 */
function endOfLine(reader: BitReader): void {
  let zeros = 0;
  while (bit(reader) === 0) {
    zeros += 1;
    if (zeros > 18) malformed('the end-of-line fill is invalid.');
  }
  if (zeros < 11) malformed('a Group 3 scanline is missing its end-of-line marker.');
}

/** Decode one checked 1D or 2D row into a fixed, caller-sized destination.
 * @param reader Checked source bit cursor.
 * @param pixels Fixed-size output strip whose preceding row is the reference.
 * @param row Zero-based output row within this independently encoded strip.
 * @param width Declared number of pixels in each row.
 * @param stride Byte count of one padded output scanline.
 * @param oneDimensional Whether this row uses alternating T.4 Huffman runs only.
 */
function decodeRow(
  reader: BitReader,
  pixels: Uint8Array,
  row: number,
  width: number,
  stride: number,
  oneDimensional: boolean,
): void {
  // Both destination and reference rows are views of one bounded packed raster.
  const offset = row * stride;
  const reference = offset - stride;
  // Each color's searches advance monotonically; cached transitions avoid rescanning long flat rows.
  const referenceChanges = [-1, -1];
  /** Find the next relevant reference change, visiting each reference pixel at most twice.
   * @param start Inclusive scanline-relative reference position.
   * @param target Desired color after the changing element.
   */
  function referenceChange(start: number, target: number): number {
    if (referenceChanges[target]! >= start) return referenceChanges[target]!;
    const destination = change(pixels, reference, width, start, target);
    referenceChanges[target] = destination;
    return destination;
  }
  let position = 0;
  let color = 0;
  let initial = true;
  while (position < width) {
    if (oneDimensional) {
      const length = run(reader, color, width - position);
      if (length === 0 && !initial) malformed('a scanline contains a redundant zero-length run.');
      if (color === 1) blackRun(pixels, offset, position, position + length);
      position += length;
      color = 1 - color;
    } else {
      // Vertical and pass destinations follow the prior line's next opposite-color transition.
      const b1 = referenceChange(position === 0 ? 0 : position + 1, 1 - color);
      let key = 1;
      let mode: number | undefined;
      for (let count = 0; count < 7; count += 1) {
        key = key * 2 + bit(reader);
        mode = MODES.get(key);
        if (mode !== undefined) break;
      }
      if (mode === undefined) malformed('the two-dimensional mode is invalid or unsupported.');
      if (mode === 5) {
        // Horizontal mode encodes exactly two runs; a final zero-length second run is permitted.
        const first = run(reader, color, width - position);
        const second = run(reader, 1 - color, width - position - first);
        if (first + second === 0) malformed('horizontal mode makes no scanline progress.');
        if (color === 1) blackRun(pixels, offset, position, position + first);
        else blackRun(pixels, offset, position + first, position + first + second);
        position += first + second;
      } else {
        const destination = mode === 4 ? referenceChange(b1 + 1, color) : b1 + mode;
        if (
          destination < position ||
          destination > width ||
          (destination === position && !initial)
        ) {
          malformed('a two-dimensional run exceeds or moves behind the scanline.');
        }
        if (color === 1) blackRun(pixels, offset, position, destination);
        position = destination;
        if (mode !== 4) color = 1 - color;
      }
    }
    initial = false;
  }
}

/** Decode CCITT strips with storage bounded solely by the already-validated image dimensions.
 * Only standard Huffman/2D codes are admitted; uncompressed extensions fail explicitly.
 * No upstream fax decoder receives the source, including trailing codes after the declared rows.
 * @param strip Exact encoded bytes of one independently coded TIFF strip.
 * @param width Original image columns, before orientation.
 * @param rows Actual rows in this strip, including a shorter final strip.
 * @param compression TIFF compression identifier 2, 3 or 4.
 * @param fillOrder Bit order inside encoded bytes, either one or two.
 * @param twoDimensional Group 3 T4Options bit zero; ignored for Group 2/4.
 * @param signal Cooperative cancellation checked before allocation and between rows.
 */
export function decodeCcitt(
  strip: Uint8Array,
  width: number,
  rows: number,
  compression: number,
  fillOrder: number,
  twoDimensional: boolean,
  signal?: AbortSignal,
): Uint8Array {
  throwIfAborted(signal);
  assertImageSize(width, rows);
  if (![2, 3, 4].includes(compression) || ![1, 2].includes(fillOrder))
    malformed('invalid codec or fill order.');
  // This is the only raster allocation; no run can allocate its represented length independently.
  const stride = Math.ceil(width / 8);
  const pixels = new Uint8Array(stride * rows);
  const reader: BitReader = { bytes: strip, fillOrder, position: 0 };
  for (let row = 0; row < rows; row += 1) {
    throwIfAborted(signal);
    let oneDimensional = compression === 2 || (compression === 3 && !twoDimensional);
    if (compression === 3) {
      endOfLine(reader);
      if (twoDimensional) oneDimensional = bit(reader) === 1;
      if (row === 0 && !oneDimensional)
        malformed('the first Group 3 row must use one-dimensional coding.');
    }
    decodeRow(reader, pixels, row, width, stride, oneDimensional);
    // TIFF compression 2 starts each row on a byte boundary; unused tail bits do not paint pixels.
    if (compression === 2) reader.position = Math.ceil(reader.position / 8) * 8;
  }
  // TIFF 6.0 permits stopping after the declared rows; no trailing data reaches a second decoder.
  return pixels;
}
