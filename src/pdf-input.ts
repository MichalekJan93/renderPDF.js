import { RenderPDFError, throwIfAborted } from './diagnostics.js';

/** Share limits across every donor loaded by one composition. */
export interface PDFInputBudget {
  /** Bytes expanded from object/xref streams, including unused streams. */
  decodedStructuralBytes: number;
  /** Explicit, compressed and cross-reference entries visited before backend parsing. */
  objectCount: number;
  /** Container tokens inspected across the complete operation. */
  tokenCount: number;
}

/** Fixed structural limits apply before pdf-lib can allocate its eager decoded buffers. */
const MAX_STRUCTURAL_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_STRUCTURAL_BYTES = 16 * 1024 * 1024;
const MAX_OBJECTS = 100_000;
const MAX_TOKENS = 2_000_000;
const MAX_DEPTH = 64;

/** Only names and containers need retained values; strings/references remain inert markers. */
type PDFInputValue =
  | number
  | boolean
  | null
  | { kind: 'name'; text: string }
  | { kind: 'string' | 'reference' }
  | PDFInputValue[]
  | Map<string, PDFInputValue>;

/** Fail closed on unsupported ambiguous syntax instead of entering backend recovery parsing. */
function invalid(message: string): never {
  throw new RenderPDFError('INVALID_SOURCE', `Unsupported or invalid PDF input: ${message}`);
}

/** PDF whitespace is byte-defined and includes NUL, unlike JavaScript whitespace. */
function whitespace(byte: number | undefined): boolean {
  return byte !== undefined && [0, 9, 10, 12, 13, 32].includes(byte);
}

/** Token boundaries match the PDF lexical separators, including comments and string delimiters. */
function delimiter(byte: number | undefined): boolean {
  return byte === undefined || whitespace(byte) || '()<>[]{}/%'.includes(String.fromCharCode(byte));
}

/** Read container syntax without decoding paint/image/font streams or interpreting PDF actions. */
class PDFInputReader {
  /** Current byte index within the complete file or one already-bounded object stream. */
  offset = 0;

  /** Retain the owned byte slice and shared operation counters only during preflight. */
  constructor(
    readonly bytes: Uint8Array,
    readonly budget: PDFInputBudget,
    readonly signal?: AbortSignal,
  ) {}

  /** Skip exactly PDF whitespace/comments, stopping before each meaningful token. */
  skip(): void {
    while (this.offset < this.bytes.length) {
      if (whitespace(this.bytes[this.offset])) this.offset += 1;
      else if (this.bytes[this.offset] === 37) {
        while (
          this.offset < this.bytes.length &&
          this.bytes[this.offset] !== 10 &&
          this.bytes[this.offset] !== 13
        )
          this.offset += 1;
      } else break;
    }
  }

  /** Count parsing work before allocating containers or following declared entry counts. */
  token(): void {
    this.budget.tokenCount += 1;
    if (this.budget.tokenCount > MAX_TOKENS) invalid('container token budget exceeded.');
    if (this.budget.tokenCount % 1024 === 0) throwIfAborted(this.signal);
  }

  /** Bound aggregate object work, including entries in ignored or unused structures. */
  objects(count: number): void {
    this.budget.objectCount += count;
    if (this.budget.objectCount > MAX_OBJECTS)
      invalid('100,000 structural object entries exceeded.');
  }

  /** Consume one complete keyword; prefixes cannot hide extra object/stream syntax. */
  match(word: string): boolean {
    this.skip();
    for (let index = 0; index < word.length; index += 1) {
      if (this.bytes[this.offset + index] !== word.charCodeAt(index)) return false;
    }
    if (!['>>', ']'].includes(word) && !delimiter(this.bytes[this.offset + word.length]))
      return false;
    this.offset += word.length;
    return true;
  }

  /** Require a structural keyword rather than letting the backend recover past mismatches. */
  expect(word: string): void {
    if (!this.match(word)) invalid(`expected ${word}.`);
  }

  /** Read a finite PDF number without accepting JavaScript exponent or numeric-prefix syntax. */
  number(): number {
    this.skip();
    this.token();
    const start = this.offset;
    while (!delimiter(this.bytes[this.offset])) this.offset += 1;
    // Numeric tokens have no reason to allocate an attacker-sized temporary string.
    if (this.offset - start > 32) invalid('numeric token is too long.');
    const text = String.fromCharCode(...this.bytes.subarray(start, this.offset));
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) invalid('invalid numeric token.');
    const value = Number(text);
    if (!Number.isFinite(value)) invalid('nonfinite numeric value.');
    return value;
  }

  /** Structural indexes/counts must be bounded, nonnegative integers before any loop starts. */
  integer(maximum = MAX_OBJECTS): number {
    this.skip();
    // Backend raw indexes consume decimal digits only, unlike ordinary signed PDF numbers.
    const start = this.offset;
    const value = this.number();
    if (this.bytes.subarray(start, this.offset).some((byte) => byte < 48 || byte > 57))
      invalid('structural indexes require unsigned decimal integer tokens.');
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
      invalid('structural integer is outside its supported range.');
    return value;
  }

  /** Decode escaped names once so obfuscated control keys receive the same checks. */
  name(): string {
    this.skip();
    if (this.bytes[this.offset++] !== 47) invalid('dictionary key must be a name.');
    const start = this.offset;
    while (!delimiter(this.bytes[this.offset])) this.offset += 1;
    if (this.offset - start > 1024) invalid('name is too long.');
    const raw = String.fromCharCode(...this.bytes.subarray(start, this.offset));
    if (/#(?![\da-f]{2})/i.test(raw)) invalid('invalid escaped name.');
    // Installed backend name decoding accepts uppercase escapes only; never validate different keys.
    for (const [, hex] of raw.matchAll(/#([\da-f]{2})/gi)) {
      if (hex !== hex!.toUpperCase())
        invalid('lowercase hexadecimal name escapes are unsupported.');
    }
    return raw.replace(/#([\dA-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  }

  /** Skip literal strings without confusing their parentheses, comments or object-like text. */
  literal(): void {
    this.offset += 1;
    let depth = 1;
    while (this.offset < this.bytes.length && depth) {
      const byte = this.bytes[this.offset++]!;
      if (byte === 92) {
        if (this.offset >= this.bytes.length) invalid('truncated string escape.');
        this.offset += 1;
      } else if (byte === 40) {
        depth += 1;
        if (depth > MAX_DEPTH) invalid('string nesting exceeds 64.');
      } else if (byte === 41) depth -= 1;
    }
    if (depth) invalid('unterminated literal string.');
  }

  /** Parse one bounded object value; stream payloads are handled only at indirect-object boundaries. */
  value(depth = 0): PDFInputValue {
    if (depth > MAX_DEPTH) invalid('container nesting exceeds 64.');
    this.skip();
    this.token();
    const byte = this.bytes[this.offset];
    if (byte === 47) return { kind: 'name', text: this.name() };
    if (byte === 40) {
      this.literal();
      return { kind: 'string' };
    }
    if (byte === 60 && this.bytes[this.offset + 1] !== 60) {
      this.offset += 1;
      while (this.offset < this.bytes.length && this.bytes[this.offset] !== 62) {
        const current = this.bytes[this.offset++]!;
        if (!whitespace(current) && !/[\da-f]/i.test(String.fromCharCode(current)))
          invalid('invalid hex string.');
      }
      if (this.bytes[this.offset++] !== 62) invalid('unterminated hex string.');
      return { kind: 'string' };
    }
    if (byte === 91) {
      this.offset += 1;
      const array: PDFInputValue[] = [];
      while (!this.match(']')) array.push(this.value(depth + 1));
      return array;
    }
    if (byte === 60 && this.bytes[this.offset + 1] === 60) {
      this.offset += 2;
      const dictionary = new Map<string, PDFInputValue>();
      while (!this.match('>>')) {
        const key = this.name();
        if (dictionary.has(key)) invalid('duplicate dictionary keys are unsupported.');
        dictionary.set(key, this.value(depth + 1));
      }
      return dictionary;
    }
    if (this.match('true')) return true;
    if (this.match('false')) return false;
    if (this.match('null')) return null;
    const first = this.number();
    const position = this.offset;
    this.skip();
    if (
      this.bytes[this.offset] !== undefined &&
      /\d/.test(String.fromCharCode(this.bytes[this.offset]!))
    ) {
      const second = this.number();
      if (
        Number.isSafeInteger(first) &&
        first >= 0 &&
        Number.isSafeInteger(second) &&
        second >= 0 &&
        this.match('R')
      )
        return { kind: 'reference' };
    }
    this.offset = position;
    return first;
  }
}

/** Read a parser-control count directly; indirect values could depend on parse order or later revisions. */
function count(dictionary: Map<string, PDFInputValue>, key: string, maximum: number): number {
  const value = dictionary.get(key);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum)
    invalid(`${key} must be a direct bounded nonnegative integer.`);
  return value;
}

/** Expand structural Flate streams incrementally and stop before retaining more than their budget. */
async function structuralBytes(
  bytes: Uint8Array,
  dictionary: Map<string, PDFInputValue>,
  budget: PDFInputBudget,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const filter = dictionary.get('Filter');
  const selected = Array.isArray(filter) && filter.length === 1 ? filter[0] : filter;
  const params = dictionary.get('DecodeParms');
  if (
    params !== undefined &&
    params !== null &&
    !(Array.isArray(params) && params.length === 1 && params[0] === null)
  )
    invalid('structural DecodeParms are unsupported.');
  const account = (length: number): void => {
    budget.decodedStructuralBytes += length;
    if (budget.decodedStructuralBytes > MAX_STRUCTURAL_BYTES)
      invalid('16 MiB total decoded structural stream budget exceeded.');
  };
  if (filter === undefined || filter === null) {
    if (bytes.length > MAX_STRUCTURAL_STREAM_BYTES)
      invalid('2 MiB decoded structural stream budget exceeded.');
    account(bytes.length);
    return bytes;
  }
  if (
    !selected ||
    typeof selected !== 'object' ||
    Array.isArray(selected) ||
    selected instanceof Map ||
    selected.kind !== 'name' ||
    selected.text !== 'FlateDecode'
  )
    invalid('structural streams support only direct single FlateDecode filters.');
  if (typeof DecompressionStream !== 'function')
    invalid('structural Flate streams require DecompressionStream.');
  // Small encoded writes bound how much the native decoder can queue before each size check.
  let compressedOffset = 0;
  const compressed = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (compressedOffset === bytes.length) controller.close();
      else {
        const end = Math.min(compressedOffset + 1024, bytes.length);
        controller.enqueue(Uint8Array.from(bytes.subarray(compressedOffset, end)));
        compressedOffset = end;
      }
    },
  });
  const reader = compressed.pipeThrough(new DecompressionStream('deflate')).getReader();
  /** Stop pending native reads when cancellation arrives between decoded chunks. */
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const next = await reader.read();
      throwIfAborted(signal);
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_STRUCTURAL_STREAM_BYTES)
        invalid('2 MiB decoded structural stream budget exceeded.');
      account(next.value.byteLength);
      chunks.push(next.value);
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Validate compressed object indexes and their complete values before the backend re-parses them. */
function objectStream(
  bytes: Uint8Array,
  dictionary: Map<string, PDFInputValue>,
  budget: PDFInputBudget,
  signal?: AbortSignal,
): void {
  const reader = new PDFInputReader(bytes, budget, signal);
  const size = count(dictionary, 'N', MAX_OBJECTS);
  const first = count(dictionary, 'First', bytes.length);
  reader.objects(size);
  const offsets: number[] = [];
  const identifiers = new Set<number>();
  for (let index = 0; index < size; index += 1) {
    const identifier = reader.integer();
    if (identifier === 0 || identifiers.has(identifier))
      invalid('compressed object identifiers must be unique and positive.');
    identifiers.add(identifier);
    const offset = reader.integer(bytes.length);
    if (offsets.length && offset <= offsets[offsets.length - 1]!)
      invalid('compressed object offsets must increase.');
    offsets.push(offset);
  }
  reader.skip();
  if (reader.offset !== first) invalid('object stream First disagrees with its index.');
  for (let index = 0; index < size; index += 1) {
    if (first + offsets[index]! >= bytes.length)
      invalid('compressed object offset is outside the stream.');
    reader.offset = first + offsets[index]!;
    reader.value();
    reader.skip();
    const end = index + 1 < size ? first + offsets[index + 1]! : bytes.length;
    if (reader.offset !== end)
      invalid('compressed objects contain overlapping or unsupported syntax.');
  }
}

/** Bound xref loop counts and widths; parser-declared counts must fit the actual decoded bytes. */
function xrefStream(
  bytes: Uint8Array,
  dictionary: Map<string, PDFInputValue>,
  budget: PDFInputBudget,
): void {
  const size = count(dictionary, 'Size', MAX_OBJECTS);
  const widths = dictionary.get('W');
  if (
    !Array.isArray(widths) ||
    widths.length !== 3 ||
    widths.some(
      (width) => typeof width !== 'number' || !Number.isInteger(width) || width < 0 || width > 8,
    )
  )
    invalid('xref widths must contain three direct integers from 0 through 8.');
  const index = dictionary.get('Index') ?? [0, size];
  if (
    !Array.isArray(index) ||
    index.length % 2 ||
    index.some(
      (value) =>
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > MAX_OBJECTS,
    )
  )
    invalid('xref Index requires direct bounded integer pairs.');
  let entries = 0;
  for (let position = 0; position < index.length; position += 2) {
    if ((index[position] as number) + (index[position + 1] as number) > MAX_OBJECTS)
      invalid('xref subsection exceeds the object limit.');
    entries += index[position + 1] as number;
  }
  budget.objectCount += entries;
  if (budget.objectCount > MAX_OBJECTS) invalid('100,000 structural object entries exceeded.');
  const stride = (widths as number[]).reduce((total, width) => total + width, 0);
  if (stride === 0 || entries * stride !== bytes.length)
    invalid('xref entry counts disagree with decoded bytes.');
}

/** Validate a deliberately strict PDF container profile before public pdf-lib loading can inflate it. */
export async function validatePDFInput(
  bytes: Uint8Array,
  signal?: AbortSignal,
  budget: PDFInputBudget = { decodedStructuralBytes: 0, objectCount: 0, tokenCount: 0 },
): Promise<void> {
  throwIfAborted(signal);
  const header = String.fromCharCode(...bytes.subarray(0, 8));
  if (!/^%PDF-(?:1\.[0-7]|2\.0)$/.test(header))
    invalid('a supported PDF header must start at byte zero.');
  // Otherwise the backend can absorb an object number as more version digits and enter recovery parsing.
  if (bytes[8] !== 10 && bytes[8] !== 13) invalid('the PDF header must end with a line break.');
  const reader = new PDFInputReader(bytes, budget, signal);
  reader.offset = 8;
  reader.skip();
  while (reader.offset < bytes.length) {
    if (reader.match('xref')) {
      reader.skip();
      while (/\d/.test(String.fromCharCode(bytes[reader.offset] ?? 0))) {
        const first = reader.integer();
        const size = reader.integer();
        if (first + size > MAX_OBJECTS) invalid('xref subsection exceeds the object limit.');
        reader.objects(size);
        for (let index = 0; index < size; index += 1) {
          reader.integer(bytes.length);
          reader.integer(65_535);
          if (!reader.match('n') && !reader.match('f')) invalid('invalid xref entry.');
        }
        reader.skip();
      }
    } else if (reader.match('trailer')) {
      const trailer = reader.value();
      if (!(trailer instanceof Map)) invalid('trailer must be a dictionary.');
      if (trailer.has('Encrypt')) invalid('encrypted PDFs are unsupported.');
    } else if (reader.match('startxref')) reader.integer(bytes.length);
    else {
      if (reader.integer() === 0) invalid('indirect object number zero is unsupported.');
      reader.integer(65_535);
      reader.expect('obj');
      reader.objects(1);
      const value = reader.value();
      if (reader.match('stream')) {
        if (!(value instanceof Map)) invalid('stream must follow a dictionary.');
        // Align with the supported backend stream line endings; no fallback marker scanning occurs.
        if (
          bytes[reader.offset] === 32 &&
          bytes[reader.offset + 1] === 13 &&
          bytes[reader.offset + 2] === 10
        )
          reader.offset += 1;
        if (bytes[reader.offset] === 13) reader.offset += 1;
        else if (bytes[reader.offset] !== 10) invalid('stream keyword requires a line ending.');
        if (bytes[reader.offset] === 10) reader.offset += 1;
        const length = count(value, 'Length', bytes.length - reader.offset);
        const encoded = bytes.subarray(reader.offset, reader.offset + length);
        reader.offset += length;
        reader.expect('endstream');
        const type = value.get('Type');
        if (
          type !== undefined &&
          (!type ||
            typeof type !== 'object' ||
            Array.isArray(type) ||
            type instanceof Map ||
            type.kind !== 'name')
        )
          invalid('stream Type must be a direct name.');
        if (
          type &&
          typeof type === 'object' &&
          !Array.isArray(type) &&
          !(type instanceof Map) &&
          type.kind === 'name' &&
          ['ObjStm', 'XRef'].includes(type.text)
        ) {
          const decoded = await structuralBytes(encoded, value, budget, signal);
          if (type.text === 'ObjStm') objectStream(decoded, value, budget, signal);
          else {
            if (value.has('Encrypt')) invalid('encrypted PDFs are unsupported.');
            xrefStream(decoded, value, budget);
          }
        }
      }
      reader.expect('endobj');
    }
    reader.skip();
  }
  throwIfAborted(signal);
}
