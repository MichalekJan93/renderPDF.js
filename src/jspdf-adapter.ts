import { createDocument, type PDFBuilder } from './document.js';
import type { PDFPageBuilder } from './document-page.js';
import type {
  DocumentFontOptions,
  DocumentImageSource,
  DocumentPageOptions,
  PDFDocumentOptions,
} from './document-types.js';
import type { RenderPDFResult } from './api-types.js';
import { RenderPDFError } from './diagnostics.js';

/** Prepared font descriptor consumed by DevExtreme's synchronous PDF exporter. */
export interface JsPDFAdapterFont {
  readonly fontName: string;
  readonly fontStyle: 'normal' | 'bold' | 'italic' | 'bolditalic';
  readonly fontWeight: number;
}

/** Supported text placement; complex scripts and advanced jsPDF transforms are outside this adapter. */
export interface JsPDFAdapterTextOptions {
  align?: 'left' | 'center' | 'right';
  baseline?: 'alphabetic' | 'top' | 'middle' | 'bottom' | 'hanging' | 'ideographic';
  angle?: number;
  /** jsPDF uses counterclockwise angles by default; zero selects clockwise rotation. */
  rotationDirection?: 0 | 1;
  lineHeightFactor?: number;
  maxWidth?: number;
  isInputVisual?: boolean;
  isOutputVisual?: boolean;
  isInputRtl?: boolean;
  isOutputRtl?: boolean;
}

/** Explicit font overrides used by the exporter's text measurement calls. */
export interface JsPDFAdapterMeasureOptions {
  font?: JsPDFAdapterFont;
  fontName?: string;
  fontStyle?: string;
  fontSize?: number;
  maxWidth?: number;
}

type ColorChannel = number | string;

/** Narrow color-normalization contract used by DevExtreme 25.1. */
export interface JsPDFAdapterColorOptions {
  ch1: ColorChannel;
  ch2?: ColorChannel;
  ch3?: ColorChannel;
  ch4?: ColorChannel;
  precision?: number;
  pdfColorType?: string;
}

interface DrawingState {
  font: JsPDFAdapterFont;
  fontSize: number;
  lineHeight: number;
  lineWidth: number;
  textColor: string;
  drawColor: string;
  fillColor: string;
}

/** Reject invalid state before it can enter an asynchronously written command list. */
function positive(value: number, name: string, allowZero = false): number {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      `${name} must be a finite ${allowZero ? 'nonnegative' : 'positive'} number.`,
    );
  }
  return value;
}

/** Keep explicit line breaks while rejecting unsupported advanced jsPDF text arrays. */
function linesOf(value: string | number | readonly string[]): string[] {
  if (typeof value === 'string') return value.split(/\r?\n/);
  if (typeof value === 'number' && Number.isFinite(value)) return [String(value)];
  if (Array.isArray(value) && value.every((line) => typeof line === 'string')) {
    return value.flatMap((line: string) => line.split(/\r?\n/));
  }
  throw new RenderPDFError(
    'INVALID_OPTIONS',
    'Text must be a string, finite number or array of strings.',
  );
}

/** Own loaded browser pixels now; queued painting must not observe a later src or canvas edit. */
function ownImage(source: DocumentImageSource): DocumentImageSource {
  if (source instanceof Uint8Array) return Uint8Array.from(source);
  if (source instanceof ArrayBuffer) return source.slice(0);
  if (typeof source !== 'object' || source === null || !('tagName' in source)) return source;
  const width = 'naturalWidth' in source ? source.naturalWidth : source.width;
  const height = 'naturalHeight' in source ? source.naturalHeight : source.height;
  if ('complete' in source && (!source.complete || width === 0 || height === 0)) {
    throw new RenderPDFError(
      'RESOURCE_LOAD_FAILED',
      'Await image.decode() before adding a browser image.',
    );
  }
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > 40_000_000
  ) {
    throw new RenderPDFError(
      'UNSUPPORTED_IMAGE',
      'Browser images must contain 1 to 40 million pixels.',
    );
  }
  try {
    if ('toDataURL' in source) return source.toDataURL('image/png');
    const canvas = source.ownerDocument.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const drawing = canvas.getContext('2d');
    if (!drawing)
      throw new RenderPDFError(
        'RESOURCE_LOAD_FAILED',
        'A canvas context is required to snapshot browser image pixels.',
      );
    drawing.drawImage(source, 0, 0);
    return canvas.toDataURL('image/png');
  } catch (cause) {
    if (cause instanceof RenderPDFError) throw cause;
    throw new RenderPDFError(
      'RESOURCE_LOAD_FAILED',
      'Browser image pixels could not be read. Use a same-origin or CORS-readable image.',
      { cause },
    );
  }
}

/** Resolve the adapter's four documented styles without browser font synthesis. */
function fontDescriptor(name: string, style: string, weight?: number): JsPDFAdapterFont {
  if (typeof name !== 'string' || !name.trim() || typeof style !== 'string') {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'Provide a nonempty font family and a supported style.',
    );
  }
  const normalized = style.replace(/[- ]/g, '').toLowerCase();
  if (!['normal', 'bold', 'italic', 'bolditalic'].includes(normalized)) {
    throw new RenderPDFError('INVALID_OPTIONS', `Unsupported adapter font style: ${style}`);
  }
  const fontWeight = weight ?? (normalized.includes('bold') ? 700 : 400);
  positive(fontWeight, 'Font weight');
  return Object.freeze({
    fontName: name,
    fontStyle: normalized as JsPDFAdapterFont['fontStyle'],
    fontWeight,
  });
}

/** Translate jsPDF-style descriptors into the core's exact face selection. */
function coreFont(font: JsPDFAdapterFont): DocumentFontOptions {
  return {
    font: font.fontName,
    fontWeight: font.fontWeight,
    fontStyle: font.fontStyle.includes('italic') ? 'italic' : 'normal',
  };
}

/** Parse a PDF color token, or an already canonical CSS color, into RGB hex. */
function decodeColor(token: string): string {
  if (/^#[\da-f]{6}$/i.test(token)) return token.toLowerCase();
  const parts = token.trim().split(/\s+/);
  const operator = parts.pop()?.toLowerCase();
  const values = parts.map(Number);
  let rgb: number[];
  if (operator === 'g' && values.length === 1) rgb = [values[0]!, values[0]!, values[0]!];
  else if (operator === 'rg' && values.length === 3) rgb = values;
  else if (operator === 'k' && values.length === 4)
    rgb = values.slice(0, 3).map((value) => (1 - value) * (1 - values[3]!));
  else throw new RenderPDFError('INVALID_OPTIONS', 'Unsupported adapter color token.');
  if (rgb.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new RenderPDFError('INVALID_OPTIONS', 'Color channels must be between zero and one.');
  }
  return `#${rgb
    .map((value) =>
      Math.floor(value * 255 + 1e-8)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** Normalize supported jsPDF grayscale, RGB and CMYK channels without vendor code. */
function encodeColor(options: JsPDFAdapterColorOptions | string): string {
  const input = typeof options === 'string' ? { ch1: options } : options;
  if (!input || (typeof input.ch1 !== 'number' && typeof input.ch1 !== 'string')) {
    throw new RenderPDFError('INVALID_OPTIONS', 'A color needs at least one channel.');
  }
  const named: Readonly<Record<string, string>> = {
    black: '#000000',
    white: '#ffffff',
    red: '#ff0000',
    green: '#008000',
    blue: '#0000ff',
    yellow: '#ffff00',
    gray: '#808080',
    grey: '#808080',
    silver: '#c0c0c0',
    maroon: '#800000',
    purple: '#800080',
    fuchsia: '#ff00ff',
    lime: '#00ff00',
    olive: '#808000',
    navy: '#000080',
    teal: '#008080',
    aqua: '#00ffff',
    orange: '#ffa500',
    transparent: '#ffffff',
  };
  let { ch1, ch2, ch3 } = input;
  const { ch4 } = input;
  if (typeof ch1 === 'string') {
    const text = named[ch1.toLowerCase()] ?? ch1;
    const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(text)?.[1];
    if (hex) {
      if (ch2 !== undefined || ch3 !== undefined || ch4 !== undefined) {
        throw new RenderPDFError('INVALID_OPTIONS', 'Hex colors cannot include numeric channels.');
      }
      const expanded =
        hex.length === 3
          ? hex
              .split('')
              .map((letter) => letter + letter)
              .join('')
          : hex;
      ch1 = Number.parseInt(expanded.slice(0, 2), 16);
      ch2 = Number.parseInt(expanded.slice(2, 4), 16);
      ch3 = Number.parseInt(expanded.slice(4, 6), 16);
    } else if (!/^\d*\.?\d+$/.test(ch1)) {
      throw new RenderPDFError('INVALID_OPTIONS', `Unsupported adapter color: ${ch1}`);
    }
  }
  const channels = [ch1, ch2, ch3, ch4].filter(
    (value): value is ColorChannel => value !== undefined,
  );
  if (![1, 3, 4].includes(channels.length)) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'Provide one gray, three RGB or four CMYK channels.',
    );
  }
  const cmyk = channels.length === 4;
  const normalized = channels.map((value) => {
    const result = typeof value === 'string' || cmyk ? Number(value) : value / 255;
    if (!Number.isFinite(result) || result < 0 || result > 1) {
      throw new RenderPDFError('INVALID_OPTIONS', 'Color channel is outside the supported range.');
    }
    return result;
  });
  const precision = input.precision ?? 3;
  if (!Number.isInteger(precision) || precision < 0 || precision > 6) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'Color precision must be an integer from zero to six.',
    );
  }
  const operator = channels.length === 1 ? 'g' : cmyk ? 'k' : 'rg';
  return `${normalized.map((value) => value.toFixed(precision)).join(' ')} ${operator}`;
}

/** A prepared, scoped facade for DevExtreme 25.1; serialization is explicitly asynchronous. */
export class JsPDFAdapter {
  /** jsPDF-compatible units and current page dimensions used by DevExtreme. */
  readonly internal: {
    readonly scaleFactor: number;
    readonly pageSize: { getWidth(): number; getHeight(): number };
    getNumberOfPages(): number;
  };

  /** DevExtreme's bounded private color bridge; unrelated jsPDF internals are unsupported. */
  readonly __private__ = Object.freeze({
    encodeColorString: encodeColor,
    decodeColorString: decodeColor,
  });

  private currentPage: PDFPageBuilder;
  private state: DrawingState = {
    font: fontDescriptor('Helvetica', 'normal'),
    fontSize: 16,
    lineHeight: 1.15,
    lineWidth: 0.200025,
    textColor: '#000000',
    drawColor: '#000000',
    fillColor: '#000000',
  };
  private readonly commands: Array<() => void | PDFPageBuilder | Promise<void>> = [];
  private readonly savedStates = new Map<PDFPageBuilder, DrawingState[]>();
  private readonly activePaths = new Set<PDFPageBuilder>();
  private completion?: Promise<RenderPDFResult>;

  /** Construct through createJsPDFAdapter so fonts exist before synchronous export begins. */
  constructor(private readonly document: PDFBuilder) {
    this.currentPage = document.addPage();
    this.internal = Object.freeze({
      scaleFactor: document.unitScale,
      pageSize: Object.freeze({
        getWidth: () => this.currentPage.width,
        getHeight: () => this.currentPage.height,
      }),
      getNumberOfPages: () => this.document.pageCount,
    });
  }

  /** Reject drawing after serialization starts, preserving a deterministic snapshot. */
  private assertMutable(): void {
    if (this.completion)
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'This adapter has already been finalized. Create a new document.',
      );
  }

  /** Record paint in order so asynchronous image embedding cannot move it above later text. */
  private enqueue(command: () => void | PDFPageBuilder | Promise<void>): this {
    this.assertMutable();
    this.commands.push(command);
    return this;
  }

  /** Select a prepared face and validate it through the core's synchronous metrics. */
  getFont(name?: string | null, style?: string | null): JsPDFAdapterFont {
    if (name == null && style == null) return this.state.font;
    const font = fontDescriptor(
      name ?? this.state.font.fontName,
      style ?? this.state.font.fontStyle,
    );
    this.document.measureText(' ', coreFont(font));
    return font;
  }

  /** Select a preloaded face; load custom bytes in the factory's fonts option. */
  setFont(name: string, style = 'normal', weight?: number): this {
    this.assertMutable();
    const font = fontDescriptor(name, style, weight);
    this.document.measureText(' ', coreFont(font));
    this.state.font = font;
    return this;
  }

  /** Set typographic points independently of the document's coordinate unit. */
  setFontSize(size: number): this {
    this.assertMutable();
    this.state.fontSize = positive(size, 'Font size');
    return this;
  }
  /** Return the current point size. */
  getFontSize(): number {
    return this.state.fontSize;
  }
  /** Set the baseline-to-baseline font-size multiplier. */
  setLineHeightFactor(value: number): this {
    this.assertMutable();
    this.state.lineHeight = positive(value, 'Line height');
    return this;
  }
  /** Return the current baseline spacing multiplier. */
  getLineHeightFactor(): number {
    return this.state.lineHeight;
  }
  /** Set border width in document coordinates. */
  setLineWidth(width: number): this {
    this.assertMutable();
    this.state.lineWidth = positive(width, 'Line width', true);
    return this;
  }
  /** Return border width in document coordinates. */
  getLineWidth(): number {
    return this.state.lineWidth;
  }

  /** Normalize a color to the same representation returned by the private bridge. */
  private color(
    ch1: ColorChannel,
    ch2?: ColorChannel,
    ch3?: ColorChannel,
    ch4?: ColorChannel,
    precision = 3,
  ): string {
    return decodeColor(
      encodeColor({
        ch1,
        ...(ch2 !== undefined ? { ch2 } : {}),
        ...(ch3 !== undefined ? { ch3 } : {}),
        ...(ch4 !== undefined ? { ch4 } : {}),
        precision,
      }),
    );
  }
  /** Set text color from gray, RGB, CMYK or a supported CSS color. */
  setTextColor(
    ch1: ColorChannel,
    ch2?: ColorChannel,
    ch3?: ColorChannel,
    ch4?: ColorChannel,
  ): this {
    this.assertMutable();
    this.state.textColor = this.color(ch1, ch2, ch3, ch4);
    return this;
  }
  /** Return normalized text color. */
  getTextColor(): string {
    return this.state.textColor;
  }
  /** Set stroke color. */
  setDrawColor(
    ch1: ColorChannel,
    ch2?: ColorChannel,
    ch3?: ColorChannel,
    ch4?: ColorChannel,
  ): this {
    this.assertMutable();
    this.state.drawColor = this.color(ch1, ch2, ch3, ch4, 2);
    return this;
  }
  /** Return normalized stroke color. */
  getDrawColor(): string {
    return this.state.drawColor;
  }
  /** Set fill color. */
  setFillColor(
    ch1: ColorChannel,
    ch2?: ColorChannel,
    ch3?: ColorChannel,
    ch4?: ColorChannel,
  ): this {
    this.assertMutable();
    this.state.fillColor = this.color(ch1, ch2, ch3, ch4, 2);
    return this;
  }
  /** Return normalized fill color. */
  getFillColor(): string {
    return this.state.fillColor;
  }

  /** Measure width and jsPDF-style line height synchronously in document units. */
  getTextDimensions(
    text: string | number | readonly string[],
    options: JsPDFAdapterMeasureOptions = {},
  ): { w: number; h: number } {
    const font = options.font ?? this.getFont(options.fontName, options.fontStyle);
    const fontSize = positive(options.fontSize ?? this.state.fontSize, 'Font size');
    const lines =
      options.maxWidth && options.maxWidth > 0
        ? this.splitTextToSize(text, options.maxWidth, options)
        : linesOf(text);
    const widths = lines.map(
      (line) => this.document.measureText(line, { ...coreFont(font), fontSize }).width,
    );
    const width = widths.reduce((maximum, value) => Math.max(maximum, value), 0);
    const height =
      width === 0
        ? 0
        : (fontSize * (1 + (lines.length - 1) * this.state.lineHeight)) / this.internal.scaleFactor;
    return { w: width, h: height };
  }

  /** Return the current face's text width. */
  getTextWidth(text: string): number {
    return this.getTextDimensions(text).w;
  }

  /** Wrap by measured words, splitting oversized words without losing characters. */
  splitTextToSize(
    text: string | number | readonly string[],
    width: number,
    options: JsPDFAdapterMeasureOptions = {},
  ): string[] {
    positive(width, 'Text width');
    const font = options.font ?? this.getFont(options.fontName, options.fontStyle);
    const fontSize = positive(options.fontSize ?? this.state.fontSize, 'Font size');
    const measure = (value: string) =>
      this.document.measureText(value, { ...coreFont(font), fontSize }).width;
    const result: string[] = [];
    for (const paragraph of linesOf(text)) {
      let current = '';
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const candidate = current ? `${current} ${word}` : word;
        if (measure(candidate) <= width) {
          current = candidate;
          continue;
        }
        if (current) {
          result.push(current);
          current = '';
        }
        for (const character of word) {
          if (current && measure(current + character) > width) {
            result.push(current);
            current = '';
          }
          current += character;
        }
      }
      result.push(current);
    }
    return result;
  }

  /** Position text using the supported alignment and baseline options. */
  text(
    text: string | readonly string[],
    x: number,
    y: number,
    options: JsPDFAdapterTextOptions = {},
  ): this {
    const unsupported =
      options.isInputRtl || options.isOutputRtl || options.isInputVisual || options.isOutputVisual;
    if (unsupported)
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'Bidirectional jsPDF text options are unsupported by this adapter.',
      );
    if (
      options.rotationDirection !== undefined &&
      options.rotationDirection !== 0 &&
      options.rotationDirection !== 1
    ) {
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'rotationDirection must be zero (clockwise) or one (counterclockwise).',
      );
    }
    const fontSize = this.state.fontSize;
    const lineHeight = positive(options.lineHeightFactor ?? this.state.lineHeight, 'Line height');
    const lineSize = fontSize / this.internal.scaleFactor;
    const descent = lineSize * (lineHeight - 1);
    const baseline = options.baseline ?? 'alphabetic';
    const offsets = {
      alphabetic: 0,
      ideographic: 0,
      bottom: -descent,
      top: lineSize - descent,
      middle: lineSize / 2 - descent,
      hanging: lineSize - 2 * descent,
    };
    if (!(baseline in offsets))
      throw new RenderPDFError('INVALID_OPTIONS', 'Unsupported text baseline.');
    const value =
      options.maxWidth && options.maxWidth > 0
        ? this.splitTextToSize(text, options.maxWidth).join('\n')
        : linesOf(text).join('\n');
    const page = this.currentPage;
    const paint = {
      x,
      y: y + offsets[baseline],
      ...coreFont(this.state.font),
      fontSize,
      color: this.state.textColor,
      align: options.align ?? 'left',
      lineHeight,
      ...(options.angle !== undefined
        ? { rotation: options.angle * (options.rotationDirection === 0 ? 1 : -1) }
        : {}),
    };
    return this.enqueue(() => page.drawText(value, paint));
  }

  /** Paint one stroke with the current line state. */
  line(x1: number, y1: number, x2: number, y2: number): this {
    const page = this.currentPage;
    const paint = { x1, y1, x2, y2, color: this.state.drawColor, width: this.state.lineWidth };
    return this.enqueue(() => page.drawLine(paint));
  }

  /** Paint a rectangle; path-only styles are outside the exporter contract. */
  rect(x: number, y: number, width: number, height: number, style = 'S'): this {
    const normalized = style.toUpperCase();
    if (!['S', 'D', 'F', 'FD', 'DF', 'B'].includes(normalized))
      throw new RenderPDFError('INVALID_OPTIONS', 'Unsupported rectangle style.');
    const fill = ['F', 'FD', 'DF', 'B'].includes(normalized);
    const stroke = normalized !== 'F';
    const page = this.currentPage;
    const paint = {
      x,
      y,
      width,
      height,
      ...(fill ? { fill: this.state.fillColor } : {}),
      ...(stroke ? { stroke: this.state.drawColor, strokeWidth: this.state.lineWidth } : {}),
    };
    return this.enqueue(() => page.drawRectangle(paint));
  }

  /** Preserve both PDF graphics and adapter style state. */
  saveGraphicsState(): this {
    this.assertMutable();
    const page = this.currentPage;
    const stack = this.savedStates.get(page) ?? [];
    stack.push({ ...this.state });
    this.savedStates.set(page, stack);
    return this.enqueue(() => page.saveGraphicsState());
  }

  /** Restore a state saved on this same page. */
  restoreGraphicsState(): this {
    this.assertMutable();
    const page = this.currentPage;
    const restored = this.savedStates.get(page)?.pop();
    if (!restored)
      throw new RenderPDFError('INVALID_OPTIONS', 'There is no saved graphics state on this page.');
    this.state = restored;
    return this.enqueue(() => page.restoreGraphicsState());
  }

  /** Begin a clipping path in document coordinates. */
  moveTo(x: number, y: number): this {
    this.assertMutable();
    const page = this.currentPage;
    this.activePaths.add(page);
    return this.enqueue(() => page.moveTo(x, y));
  }
  /** Append one path segment. */
  lineTo(x: number, y: number): this {
    const page = this.currentPage;
    return this.enqueue(() => page.lineTo(x, y));
  }
  /** Close the current path; this is not a document-disposal operation. */
  close(): this {
    if (!this.activePaths.has(this.currentPage)) return this;
    const page = this.currentPage;
    return this.enqueue(() => page.closePath());
  }
  /** Apply the current path as a clip. */
  clip(): this {
    const page = this.currentPage;
    return this.enqueue(() => page.clip());
  }
  /** Clear the current path after clipping. */
  discardPath(): this {
    this.assertMutable();
    const page = this.currentPage;
    this.activePaths.delete(page);
    return this.enqueue(() => page.discardPath());
  }

  /** Add a page using jsPDF's array format and optional orientation shorthand. */
  addPage(
    format?: DocumentPageOptions['format'] | readonly [number, number],
    orientation?: 'p' | 'l' | 'portrait' | 'landscape',
  ): this {
    this.assertMutable();
    if (orientation !== undefined && !['p', 'l', 'portrait', 'landscape'].includes(orientation)) {
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'Page orientation must be portrait or landscape.',
      );
    }
    const direction =
      orientation === 'l' || orientation === 'landscape'
        ? 'landscape'
        : orientation === 'p' || orientation === 'portrait'
          ? 'portrait'
          : undefined;
    let options: DocumentPageOptions;
    const dimensions = Array.isArray(format)
      ? (format as unknown as readonly [number, number])
      : undefined;
    if (format === undefined || dimensions !== undefined) {
      let width = dimensions?.[0] ?? this.currentPage.width;
      let height = dimensions?.[1] ?? this.currentPage.height;
      if (
        (direction === 'landscape' && width < height) ||
        (direction === 'portrait' && width > height)
      )
        [width, height] = [height, width];
      options = { format: { width, height }, orientation: 'portrait' };
    } else {
      options = {
        format: format as NonNullable<DocumentPageOptions['format']>,
        ...(direction ? { orientation: direction } : {}),
      };
    }
    this.currentPage = this.document.addPage(options);
    return this;
  }

  /** Select an existing one-based page for later footer and title paint. */
  setPage(pageNumber: number): this {
    this.assertMutable();
    this.currentPage = this.document.getPage(pageNumber);
    return this;
  }
  /** Return the total number of pages already added. */
  getNumberOfPages(): number {
    return this.document.pageCount;
  }

  /** Queue image placement without allowing asynchronous embedding to reorder paint. */
  addImage(
    source: DocumentImageSource,
    format: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ): this {
    this.assertMutable();
    if (!['PNG', 'JPEG', 'JPG'].includes(format.toUpperCase()))
      throw new RenderPDFError(
        'UNSUPPORTED_IMAGE',
        'The adapter accepts PNG/JPEG image placement.',
      );
    const image = ownImage(source);
    const page = this.currentPage;
    return this.enqueue(async () => {
      await page.drawImage(image, { x, y, width, height });
    });
  }

  /** Flush ordered drawing once and return the immutable common PDF result. */
  toResult(): Promise<RenderPDFResult> {
    this.completion ??= (async () => {
      try {
        for (const command of this.commands) await command();
        return this.document.toResult();
      } finally {
        this.commands.length = 0;
      }
    })();
    return this.completion;
  }

  /** Return an asynchronously finalized PDF Blob. */
  async toBlob(): Promise<Blob> {
    return (await this.toResult()).toBlob();
  }
  /** Return independent PDF bytes. */
  async toUint8Array(): Promise<Uint8Array> {
    return (await this.toResult()).toUint8Array();
  }
  /** Save asynchronously; callers must await this method. */
  async save(filename = 'document.pdf'): Promise<void> {
    await (await this.toResult()).download(filename);
  }
  /** Download alias matching the library's result API. */
  async download(filename = 'document.pdf'): Promise<void> {
    await this.save(filename);
  }

  /** Unlike jsPDF, every output form returns a Promise and must be awaited. */
  async output(type: 'blob'): Promise<Blob>;
  async output(type: 'arraybuffer'): Promise<ArrayBuffer>;
  async output(type: 'uint8array'): Promise<Uint8Array>;
  async output(
    type: 'blob' | 'arraybuffer' | 'uint8array',
  ): Promise<Blob | ArrayBuffer | Uint8Array> {
    if (!['blob', 'arraybuffer', 'uint8array'].includes(type)) {
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'Supported adapter output types are blob, arraybuffer and uint8array.',
      );
    }
    if (type === 'blob') return this.toBlob();
    const bytes = await this.toUint8Array();
    if (type === 'uint8array') return bytes;
    if (type === 'arraybuffer') return bytes.buffer as ArrayBuffer;
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'Supported adapter output types are blob, arraybuffer and uint8array.',
    );
  }
}

/** Prepare fonts and millimeter coordinates before passing the facade as jsPDFDocument. */
export async function createJsPDFAdapter(options: PDFDocumentOptions = {}): Promise<JsPDFAdapter> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new RenderPDFError('INVALID_OPTIONS', 'Adapter options must be an object.');
  }
  return new JsPDFAdapter(await createDocument({ ...options, unit: options.unit ?? 'mm' }));
}
