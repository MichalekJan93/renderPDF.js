import {
  appendBezierCurve,
  breakTextIntoLines,
  clip as clipPath,
  clipEvenOdd,
  closePath as closePDFPath,
  concatTransformationMatrix,
  degrees,
  endPath,
  fill as fillPath,
  fillAndStroke as fillStrokePath,
  lineTo as lineToPDF,
  moveTo as moveToPDF,
  PDFHexString,
  PDFNumber,
  PDFName,
  PDFString,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setFillingColor,
  setGraphicsState,
  setLineWidth,
  setStrokingColor,
  stroke as strokePath,
} from 'pdf-lib';
import type { Color, PDFField, PDFFont, PDFPage, PDFTextField } from 'pdf-lib';
import type {
  DocumentCheckBoxOptions,
  DocumentDropdownOptions,
  DocumentFieldOptions,
  DocumentImageOptions,
  DocumentImageSource,
  DocumentLineOptions,
  DocumentPageContext,
  DocumentRectangle,
  DocumentShapeOptions,
  DocumentTextFieldOptions,
  DocumentTextOptions,
} from './document-types.js';
import { RenderPDFError } from './diagnostics.js';
import { parseDocumentColor } from './document-colors.js';
import { assertImageSize, imagePlacement } from './image-geometry.js';
import { inspectBitmap, validatePngData } from './image-input.js';

/** Six coefficients map top-left document coordinates to transformed document coordinates. */
type Matrix = readonly [number, number, number, number, number, number];

/** Use the public form method's options without importing a private backend module. */
type FieldAppearanceOptions = NonNullable<Parameters<PDFTextField['addToPage']>[1]>;

/** Fontkit may encode missing code points as .notdef; cache each face's real coverage. */
const fontCharacters = new WeakMap<PDFFont, ReadonlySet<number>>();

/** Reject invalid values before appending operators or creating interactive fields. */
function finite(value: number, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new RenderPDFError('INVALID_OPTIONS', `${name} must be a finite number.`);
}

/** Geometric sizes may be hairlines only when the caller explicitly allows zero. */
function positive(value: number, name: string, allowZero = false): void {
  finite(value, name);
  if (allowZero ? value < 0 : value <= 0)
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      `${name} must be ${allowZero ? 'nonnegative' : 'positive'}.`,
    );
}

/** Validate all dimensions before a rectangle changes the document. */
function validateRectangle(value: DocumentRectangle): void {
  if (!value || typeof value !== 'object')
    throw new RenderPDFError('INVALID_OPTIONS', 'Provide a rectangle with x, y, width and height.');
  finite(value.x, 'x');
  finite(value.y, 'y');
  positive(value.width, 'width');
  positive(value.height, 'height');
}

/** Alpha is independent of CSS color alpha and multiplies it when painting. */
function opacity(value = 1): number {
  finite(value, 'opacity');
  if (value < 0 || value > 1)
    throw new RenderPDFError('INVALID_OPTIONS', 'Opacity must be between 0 and 1.');
  return value;
}

/** URI actions deliberately exclude executable and local-file schemes. */
function linkURI(value: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'Provide an absolute HTTP, HTTPS, mailto or tel link.',
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new RenderPDFError('INVALID_OPTIONS', 'The link URL is invalid.', { cause });
  }
  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol))
    throw new RenderPDFError('INVALID_OPTIONS', 'Links support HTTP, HTTPS, mailto and tel URLs.');
  return url.href;
}

/** Font failures retain the public diagnostic used by text and form appearances. */
function assertEncodable(font: PDFFont, text: string): void {
  let characters = fontCharacters.get(font);
  if (!characters) {
    characters = new Set(font.getCharacterSet());
    fontCharacters.set(font, characters);
  }
  for (const character of text) {
    if (character === '\r' || character === '\n') continue;
    const point = character.codePointAt(0)!;
    if (!characters.has(point))
      throw new RenderPDFError(
        'MISSING_GLYPH',
        `The selected font cannot encode U+${point.toString(16).toUpperCase()}.`,
      );
  }
  try {
    font.encodeText(text.replace(/[\r\n]/g, ''));
  } catch (cause) {
    throw new RenderPDFError('MISSING_GLYPH', 'The selected font cannot encode this text.', {
      cause,
    });
  }
}

/** Native drawing surface; asynchronous image calls must finish before later drawing. */
export class PDFPageBuilder {
  /** Path and graphics state are tracked because PDF readers otherwise accept accidental leakage. */
  private pathOpen = false;
  private pendingImages = 0;
  private matrix: Matrix = [1, 0, 0, 1, 0, 0];
  private readonly stack: Matrix[] = [];
  private readonly userUnit: number;
  private readonly scale: number;

  /** The owning document supplies registered fonts, units and finalization/cancellation checks. */
  constructor(
    private readonly page: PDFPage,
    private readonly context: DocumentPageContext,
  ) {
    // Imported pages can scale native coordinates; match PDF readers' fallback for invalid values.
    const declaredUnit = page.node.lookup(PDFName.of('UserUnit'));
    const unit = declaredUnit instanceof PDFNumber ? declaredUnit.asNumber() : 1;
    this.userUnit = Number.isFinite(unit) && unit > 0 ? unit : 1;
    this.scale = context.scale / this.userUnit;
  }

  /** Physical page width in document units. */
  get width(): number {
    return this.page.getWidth() / this.scale;
  }
  /** Physical page height in document units. */
  get height(): number {
    return this.page.getHeight() / this.scale;
  }

  /** Reader-facing page rotation does not change its unrotated drawing coordinates. */
  get rotation(): number {
    return this.page.getRotation().angle;
  }

  /** Rotate the completed page view by an integral number of quarter turns. */
  setRotation(angle: number): this {
    this.ready();
    finite(angle, 'rotation');
    if (angle % 90 !== 0)
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'Page rotation must be a multiple of 90 degrees.',
      );
    this.page.setRotation(degrees(((angle % 360) + 360) % 360));
    return this;
  }

  /** Guard both finalization and paint order before a synchronous operation changes the page. */
  private ready(allowPath = false): void {
    this.context.assertActive();
    if (this.pendingImages)
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'Await drawImage before drawing or saving this page.',
      );
    if (this.pathOpen && !allowPath)
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'Paint, clip or discard the current path before another drawing operation.',
      );
  }

  /** Finalization refuses incomplete operations instead of silently saving partial content. */
  assertComplete(): void {
    this.ready();
    if (this.stack.length)
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'Restore every saved graphics state before saving the PDF.',
      );
  }

  /** Convert a caller point to the backend's upward-pointing page coordinates. */
  private point(x: number, y: number): [number, number] {
    finite(x, 'x');
    finite(y, 'y');
    const box = this.page.getMediaBox();
    return [box.x + x * this.scale, box.y + box.height - y * this.scale];
  }

  /** Emit a separate native text run per line so alignment remains correct after wrapping. */
  drawText(text: string, options: DocumentTextOptions): this {
    this.ready();
    if (!options || typeof options !== 'object')
      throw new RenderPDFError('INVALID_OPTIONS', 'Provide text drawing options.');
    if (typeof text !== 'string')
      throw new RenderPDFError('INVALID_OPTIONS', 'Text must be a string.');
    const [anchorX, anchorY] = this.point(options.x, options.y);
    const fontSize = (options.fontSize ?? 12) / this.userUnit;
    const lineHeight = options.lineHeight ?? 1.15;
    const rotation = options.rotation ?? 0;
    positive(fontSize, 'fontSize');
    positive(lineHeight, 'lineHeight');
    finite(rotation, 'rotation');
    const align = options.align ?? 'left';
    if (!['left', 'center', 'right'].includes(align))
      throw new RenderPDFError('INVALID_OPTIONS', 'Text alignment must be left, center or right.');
    if (options.maxWidth !== undefined) positive(options.maxWidth, 'maxWidth');
    const color = parseDocumentColor(options.color ?? 'black');
    const alpha = opacity(options.opacity) * color.opacity;
    const uri = options.link === undefined ? undefined : linkURI(options.link);
    const font = this.context.resolveFont(options);
    const textWidth = (line: string) => font.widthOfTextAtSize(line, fontSize);
    let lines: string[];
    try {
      assertEncodable(font, text);
      lines =
        options.maxWidth === undefined
          ? text.replace(/\r\n?/g, '\n').split('\n')
          : breakTextIntoLines(text, [' '], options.maxWidth * this.scale, textWidth);
    } catch (cause) {
      throw new RenderPDFError('MISSING_GLYPH', 'The selected font cannot encode this text.', {
        cause,
      });
    }
    const radians = (rotation * Math.PI) / 180;
    const cos = Math.cos(radians),
      sin = Math.sin(radians);
    const [originX, originY] = this.point(0, 0);
    for (const [index, line] of lines.entries()) {
      const width = textWidth(line);
      const shift = align === 'center' ? width / 2 : align === 'right' ? width : 0;
      const advance = index * fontSize * lineHeight;
      const x = anchorX - shift * cos - advance * sin;
      const y = anchorY + shift * sin - advance * cos;
      this.page.drawText(line, {
        x,
        y,
        font,
        size: fontSize,
        color: color.color,
        opacity: alpha,
        rotate: degrees(-rotation),
      });
      if (uri && width > 0) {
        // Annotation rectangles enclose rotated glyph bounds; they do not alter page paint.
        const ascent = font.heightAtSize(fontSize, { descender: false });
        const descent = font.heightAtSize(fontSize) - ascent;
        const corners = [
          [0, -ascent],
          [width, -ascent],
          [width, descent],
          [0, descent],
        ].map(([dx, dy]) => ({
          x: (x + dx! * cos - dy! * sin - originX) / this.scale,
          y: (originY - y + dx! * sin + dy! * cos) / this.scale,
        }));
        const left = Math.min(...corners.map((p) => p.x)),
          top = Math.min(...corners.map((p) => p.y));
        this.addLink(uri, {
          x: left,
          y: top,
          width: Math.max(...corners.map((p) => p.x)) - left,
          height: Math.max(...corners.map((p) => p.y)) - top,
        });
      }
    }
    return this;
  }

  /** Draw one native line with a width in document units. */
  drawLine(options: DocumentLineOptions): this {
    this.ready();
    if (!options || typeof options !== 'object')
      throw new RenderPDFError('INVALID_OPTIONS', 'Provide line drawing options.');
    const [x1, y1] = this.point(options.x1, options.y1),
      [x2, y2] = this.point(options.x2, options.y2);
    const width = options.width ?? 1;
    positive(width, 'width', true);
    const color = parseDocumentColor(options.color ?? 'black');
    this.page.drawLine({
      start: { x: x1, y: y1 },
      end: { x: x2, y: y2 },
      thickness: width * this.scale,
      color: color.color,
      opacity: opacity(options.opacity) * color.opacity,
    });
    return this;
  }

  /** Resolve shared paint before rectangle, ellipse or SVG operators are appended. */
  private paint(options: DocumentShapeOptions): {
    color?: Color;
    borderColor?: Color;
    borderWidth: number;
    opacity: number;
    borderOpacity: number;
  } {
    const fill = options.fill === undefined ? undefined : parseDocumentColor(options.fill);
    const stroke =
      options.stroke === undefined
        ? fill
          ? undefined
          : parseDocumentColor('black')
        : parseDocumentColor(options.stroke);
    const width = options.strokeWidth ?? 1;
    positive(width, 'strokeWidth', true);
    const alpha = opacity(options.opacity);
    return {
      ...(fill ? { color: fill.color } : {}),
      ...(stroke ? { borderColor: stroke.color } : {}),
      borderWidth: stroke ? width * this.scale : 0,
      opacity: alpha * (fill?.opacity ?? 1),
      borderOpacity: alpha * (stroke?.opacity ?? 1),
    };
  }

  /** Rectangle coordinates identify its top-left corner. */
  drawRectangle(options: DocumentRectangle & DocumentShapeOptions): this {
    this.ready();
    validateRectangle(options);
    const paint = this.paint(options),
      [x, y] = this.point(options.x, options.y + options.height);
    this.page.drawRectangle({
      x,
      y,
      width: options.width * this.scale,
      height: options.height * this.scale,
      ...paint,
    });
    return this;
  }

  /** Ellipses use a top-left bounding rectangle, matching other document shapes. */
  drawEllipse(options: DocumentRectangle & DocumentShapeOptions): this {
    this.ready();
    validateRectangle(options);
    const paint = this.paint(options),
      [x, y] = this.point(options.x + options.width / 2, options.y + options.height / 2);
    this.page.drawEllipse({
      x,
      y,
      xScale: (options.width * this.scale) / 2,
      yScale: (options.height * this.scale) / 2,
      ...paint,
    });
    return this;
  }

  /** Circle x/y identify its center; radius uses document units. */
  drawCircle(options: { x: number; y: number; radius: number } & DocumentShapeOptions): this {
    this.ready();
    if (!options || typeof options !== 'object')
      throw new RenderPDFError('INVALID_OPTIONS', 'Provide circle drawing options.');
    positive(options.radius, 'radius');
    return this.drawEllipse({
      ...options,
      x: options.x - options.radius,
      y: options.y - options.radius,
      width: options.radius * 2,
      height: options.radius * 2,
    });
  }

  /** Draw SVG path geometry; this API does not load or interpret SVG documents. */
  drawSvgPath(
    path: string,
    options: { x: number; y: number; scale?: number; rotation?: number } & DocumentShapeOptions,
  ): this {
    this.ready();
    if (!options || typeof options !== 'object')
      throw new RenderPDFError('INVALID_OPTIONS', 'Provide SVG path drawing options.');
    if (typeof path !== 'string' || !path.trim())
      throw new RenderPDFError('INVALID_OPTIONS', 'Provide SVG path geometry.');
    const [x, y] = this.point(options.x, options.y),
      paint = this.paint(options);
    const scale = options.scale ?? 1,
      rotation = options.rotation ?? 0;
    positive(scale, 'scale');
    finite(rotation, 'rotation');
    try {
      this.page.drawSvgPath(path, {
        x,
        y,
        scale: scale * this.scale,
        rotate: degrees(-rotation),
        ...paint,
        borderWidth: paint.borderWidth / (scale * this.scale),
      });
    } catch (cause) {
      throw new RenderPDFError('INVALID_OPTIONS', 'The SVG path is invalid.', { cause });
    }
    return this;
  }

  /** Save clipping and transforms together with the PDF graphics state. */
  saveGraphicsState(): this {
    this.ready(true);
    this.page.pushOperators(pushGraphicsState());
    this.stack.push([...this.matrix]);
    return this;
  }

  /** Restore a previously saved state; an unmatched restore is an error. */
  restoreGraphicsState(): this {
    this.ready(true);
    const matrix = this.stack.pop();
    if (!matrix)
      throw new RenderPDFError('INVALID_OPTIONS', 'No saved graphics state is available.');
    this.page.pushOperators(popGraphicsState());
    this.matrix = matrix;
    return this;
  }

  /** Compose an affine transform expressed in top-left document coordinates. */
  transform(matrix: Matrix): this {
    this.ready(true);
    if (!Array.isArray(matrix) || matrix.length !== 6)
      throw new RenderPDFError('INVALID_OPTIONS', 'A transform requires six finite coefficients.');
    for (const value of matrix) finite(value, 'transform coefficient');
    const [a, b, c, d, e, f] = matrix;
    if (Math.abs(a * d - b * c) < 1e-12)
      throw new RenderPDFError('INVALID_OPTIONS', 'A transform must be invertible.');
    const [pa, pb, pc, pd, pe, pf] = this.matrix;
    const [originX, originY] = this.point(0, 0);
    const scale = this.scale;
    this.page.pushOperators(
      concatTransformationMatrix(
        a,
        -b,
        -c,
        d,
        (1 - a) * originX + c * originY + e * scale,
        (1 - d) * originY + b * originX - f * scale,
      ),
    );
    this.matrix = [
      pa * a + pc * b,
      pb * a + pd * b,
      pa * c + pc * d,
      pb * c + pd * d,
      pa * e + pc * f + pe,
      pb * e + pd * f + pf,
    ];
    return this;
  }

  /** Start a new subpath without implicitly discarding an earlier subpath. */
  moveTo(x: number, y: number): this {
    this.ready(true);
    this.page.pushOperators(moveToPDF(...this.point(x, y)));
    this.pathOpen = true;
    return this;
  }

  /** Append a native straight segment to the current path. */
  lineTo(x: number, y: number): this {
    this.ready(true);
    this.requirePath();
    this.page.pushOperators(lineToPDF(...this.point(x, y)));
    return this;
  }

  /** Append a cubic Bezier curve using two control points and one end point. */
  curveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): this {
    this.ready(true);
    this.requirePath();
    const first = this.point(x1, y1),
      second = this.point(x2, y2),
      end = this.point(x3, y3);
    this.page.pushOperators(appendBezierCurve(...first, ...second, ...end));
    return this;
  }

  /** Close the current subpath while retaining it for painting or clipping. */
  closePath(): this {
    this.ready(true);
    this.requirePath();
    this.page.pushOperators(closePDFPath());
    return this;
  }

  /** Require actual geometry before a path-ending operation. */
  private requirePath(): void {
    if (!this.pathOpen)
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'Start a path with moveTo before painting or clipping it.',
      );
  }

  /** Intersect the clip with the current path; discardPath ends the path afterwards. */
  clip(rule: 'nonzero' | 'evenodd' = 'nonzero'): this {
    this.ready(true);
    this.requirePath();
    if (rule !== 'nonzero' && rule !== 'evenodd')
      throw new RenderPDFError('INVALID_OPTIONS', 'The clipping rule must be nonzero or evenodd.');
    this.page.pushOperators(rule === 'evenodd' ? clipEvenOdd() : clipPath());
    return this;
  }

  /** Clip to one rectangle and consume its path. */
  clipRectangle(options: DocumentRectangle): this {
    this.ready();
    validateRectangle(options);
    const [x, y] = this.point(options.x, options.y + options.height);
    this.page.pushOperators(
      rectangle(x, y, options.width * this.scale, options.height * this.scale),
      clipPath(),
      endPath(),
    );
    return this;
  }

  /** Discard pending geometry without painting it. */
  discardPath(): this {
    this.ready(true);
    this.requirePath();
    this.page.pushOperators(endPath());
    this.pathOpen = false;
    return this;
  }

  /** Stroke an accumulated native path. */
  stroke(options: { color?: string; width?: number; opacity?: number } = {}): this {
    return this.paintPath(
      {
        stroke: options.color ?? 'black',
        ...(options.width === undefined ? {} : { strokeWidth: options.width }),
        ...(options.opacity === undefined ? {} : { opacity: options.opacity }),
      },
      'stroke',
    );
  }

  /** Fill an accumulated native path. */
  fill(options: { color?: string; opacity?: number } = {}): this {
    return this.paintPath(
      {
        fill: options.color ?? 'black',
        ...(options.opacity === undefined ? {} : { opacity: options.opacity }),
      },
      'fill',
    );
  }

  /** Fill and stroke an accumulated native path in one paint operation. */
  fillAndStroke(options: DocumentShapeOptions = {}): this {
    return this.paintPath(
      { ...options, fill: options.fill ?? 'black', stroke: options.stroke ?? 'black' },
      'both',
    );
  }

  /** Alpha is stored in a page resource and scoped to this path operation. */
  private paintPath(options: DocumentShapeOptions, mode: 'fill' | 'stroke' | 'both'): this {
    this.ready(true);
    this.requirePath();
    const paint = this.paint(options);
    const state = this.context.pdf.context.register(
      this.context.pdf.context.obj({
        Type: 'ExtGState',
        ca: paint.opacity,
        CA: paint.borderOpacity,
      }),
    );
    const name = this.page.node.newExtGState('PathAlpha', state);
    this.page.pushOperators(
      pushGraphicsState(),
      setGraphicsState(name),
      setLineWidth(paint.borderWidth),
      ...(paint.color ? [setFillingColor(paint.color)] : []),
      ...(paint.borderColor ? [setStrokingColor(paint.borderColor)] : []),
      mode === 'fill' ? fillPath() : mode === 'stroke' ? strokePath() : fillStrokePath(),
      popGraphicsState(),
    );
    this.pathOpen = false;
    return this;
  }

  /** Read image bytes before modifying page paint; no network is initiated for string inputs. */
  private async imageBytes(source: DocumentImageSource): Promise<Uint8Array> {
    if (source instanceof Uint8Array) return Uint8Array.from(source);
    if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
    if (typeof Blob !== 'undefined' && source instanceof Blob)
      return new Uint8Array(await source.arrayBuffer());
    if (typeof source === 'object' && source !== null && 'tagName' in source) {
      if ('toDataURL' in source) {
        assertImageSize(source.width, source.height);
        return this.imageBytes(source.toDataURL('image/png'));
      }
      if ('naturalWidth' in source) {
        const originalSource = source.currentSrc || source.src;
        if (!source.complete || !source.naturalWidth) await source.decode();
        this.context.assertActive();
        if ((source.currentSrc || source.src) !== originalSource)
          throw new RenderPDFError(
            'SOURCE_CHANGED',
            'The browser image source changed while decoding.',
          );
        assertImageSize(source.naturalWidth, source.naturalHeight);
        const canvas = source.ownerDocument.createElement('canvas');
        canvas.width = source.naturalWidth;
        canvas.height = source.naturalHeight;
        const drawing = canvas.getContext('2d');
        if (!drawing)
          throw new RenderPDFError(
            'RESOURCE_LOAD_FAILED',
            'A canvas context is required to read this image.',
          );
        drawing.drawImage(source, 0, 0);
        return this.imageBytes(canvas.toDataURL('image/png'));
      }
    }
    if (typeof source === 'string') {
      const data = /^data:image\/(?:png|jpe?g);base64,([a-z\d+/=\s]+)$/i.exec(source)?.[1];
      if (!data)
        throw new RenderPDFError(
          'UNSUPPORTED_IMAGE',
          'Image strings must be PNG/JPEG base64 data URLs.',
        );
      try {
        return Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
      } catch (cause) {
        throw new RenderPDFError('INVALID_SOURCE', 'The image data URL contains invalid base64.', {
          cause,
        });
      }
    }
    throw new RenderPDFError(
      'INVALID_SOURCE',
      'Provide PNG/JPEG bytes, a File/Blob, a data URL or a browser image/canvas.',
    );
  }

  /** Embed one PNG/JPEG at explicit dimensions, applying EXIF orientation and clockwise rotation. */
  async drawImage(source: DocumentImageSource, options: DocumentImageOptions): Promise<this> {
    this.ready();
    validateRectangle(options);
    options = { ...options };
    const alpha = opacity(options.opacity),
      rotation = options.rotation ?? 0;
    finite(rotation, 'rotation');
    this.pendingImages += 1;
    try {
      const bytes = await this.imageBytes(source);
      this.context.assertActive();
      const bitmap = inspectBitmap(bytes);
      if (bitmap.format === 'png') await validatePngData(bytes);
      const image =
        bitmap.format === 'png'
          ? await this.context.pdf.embedPng(bytes)
          : await this.context.pdf.embedJpg(bytes);
      this.context.assertActive();
      const displayWidth = bitmap.orientation >= 5 ? bitmap.height : bitmap.width;
      const displayHeight = bitmap.orientation >= 5 ? bitmap.width : bitmap.height;
      const matrix = imagePlacement(bitmap.width, bitmap.height, bitmap.orientation, {
        width: displayWidth,
        height: displayHeight,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
      });
      const widthScale = (options.width * this.scale) / displayWidth,
        heightScale = (options.height * this.scale) / displayHeight;
      const angle = (-rotation * Math.PI) / 180,
        [x, y] = this.point(options.x, options.y);
      this.page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(
          Math.cos(angle),
          Math.sin(angle),
          -Math.sin(angle),
          Math.cos(angle),
          x,
          y,
        ),
        concatTransformationMatrix(1, 0, 0, 1, 0, -options.height * this.scale),
        concatTransformationMatrix(
          matrix[0] * widthScale,
          matrix[1] * heightScale,
          matrix[2] * widthScale,
          matrix[3] * heightScale,
          matrix[4] * widthScale,
          matrix[5] * heightScale,
        ),
      );
      try {
        this.page.drawImage(image, { x: 0, y: 0, width: 1, height: 1, opacity: alpha });
      } finally {
        this.page.pushOperators(popGraphicsState());
      }
      return this;
    } catch (cause) {
      this.context.assertActive();
      if (cause instanceof RenderPDFError) throw cause;
      throw new RenderPDFError(
        'RESOURCE_LOAD_FAILED',
        'The PNG/JPEG image could not be drawn. Check that browser image resources are loaded and CORS-readable.',
        { cause },
      );
    } finally {
      this.pendingImages -= 1;
    }
  }

  /** Transform annotation rectangles separately because PDF annotations do not inherit page graphics state. */
  private annotationRectangle(rect: DocumentRectangle): number[] {
    validateRectangle(rect);
    const [a, b, c, d, e, f] = this.matrix;
    const corners = [
      [rect.x, rect.y],
      [rect.x + rect.width, rect.y],
      [rect.x, rect.y + rect.height],
      [rect.x + rect.width, rect.y + rect.height],
    ].map(([x, y]) => this.point(a * x! + c * y! + e, b * x! + d * y! + f));
    return [
      Math.min(...corners.map(([x]) => x)),
      Math.min(...corners.map(([, y]) => y)),
      Math.max(...corners.map(([x]) => x)),
      Math.max(...corners.map(([, y]) => y)),
    ];
  }

  /** Add a clickable external link without an opaque border. */
  addLink(url: string, rect: DocumentRectangle): this {
    this.ready();
    const uri = linkURI(url),
      bounds = this.annotationRectangle(rect);
    const annotation = this.context.pdf.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: bounds,
      Border: [0, 0, 0],
      F: 4,
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(uri) },
    });
    this.page.node.addAnnot(this.context.pdf.context.register(annotation));
    return this;
  }

  /** Add a Unicode note annotation; it remains separate from visible page content. */
  addNote(text: string, rect: DocumentRectangle, options: { title?: string } = {}): this {
    this.ready();
    if (
      typeof text !== 'string' ||
      (options.title !== undefined && typeof options.title !== 'string')
    )
      throw new RenderPDFError('INVALID_OPTIONS', 'Note content and title must be strings.');
    const annotation = this.context.pdf.context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: this.annotationRectangle(rect),
      Contents: PDFHexString.fromText(text),
      T: PDFHexString.fromText(options.title ?? ''),
      Name: 'Note',
      Open: false,
      C: [1, 1, 0],
      F: 4,
    });
    this.page.node.addAnnot(this.context.pdf.context.register(annotation));
    return this;
  }

  /** Field appearances cannot faithfully represent sheared or arbitrary transformed widgets. */
  private fieldOptions(
    name: string,
    rect: DocumentRectangle,
    options: DocumentFieldOptions,
  ): FieldAppearanceOptions {
    this.ready();
    validateRectangle(rect);
    if (!options || typeof options !== 'object')
      throw new RenderPDFError('INVALID_OPTIONS', 'Provide a form field options object.');
    if (typeof name !== 'string' || !name.trim() || /(^\.|\.\.|\.$)/.test(name))
      throw new RenderPDFError('INVALID_OPTIONS', 'Provide a nonempty, valid form field name.');
    if (this.matrix.some((value, index) => value !== [1, 0, 0, 1, 0, 0][index]))
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'Create form fields outside transformed graphics states.',
      );
    for (const value of [options.readOnly, options.required])
      if (value !== undefined && typeof value !== 'boolean')
        throw new RenderPDFError('INVALID_OPTIONS', 'Form flags must be booleans.');
    positive(options.fontSize ?? 12, 'fontSize');
    positive(options.borderWidth ?? 1, 'borderWidth', true);
    const text = parseDocumentColor(options.textColor ?? 'black'),
      border = parseDocumentColor(options.borderColor ?? 'black'),
      background = parseDocumentColor(options.backgroundColor ?? 'white');
    if ([text, border, background].some((value) => value.opacity !== 1))
      throw new RenderPDFError('INVALID_OPTIONS', 'Interactive field colors must be opaque.');
    const [x, y] = this.point(rect.x, rect.y + rect.height);
    const font = this.context.resolveFont(options);
    const form = this.context.pdf.getForm();
    if (form.getFields().some((field) => field.getName().startsWith(`${name}.`)))
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'A form field cannot replace an existing field group.',
      );
    const parts = name.split('.');
    for (let count = 1; count <= parts.length; count += 1)
      if (form.getFieldMaybe(parts.slice(0, count).join('.')))
        throw new RenderPDFError(
          'INVALID_OPTIONS',
          'A form field with this name or parent name already exists.',
        );
    return {
      x,
      y,
      width: rect.width * this.scale,
      height: rect.height * this.scale,
      font,
      textColor: text.color,
      borderColor: border.color,
      backgroundColor: background.color,
      borderWidth: (options.borderWidth ?? 1) * this.scale,
    };
  }

  /** Apply common flags after creating a field but before marking appearances clean. */
  private fieldFlags(field: PDFField, options: DocumentFieldOptions): void {
    if (options.readOnly) field.enableReadOnly();
    if (options.required) field.enableRequired();
  }

  /** Create a Unicode-capable text input with its explicitly selected embedded font. */
  addTextField(
    name: string,
    rect: DocumentRectangle,
    options: DocumentTextFieldOptions = {},
  ): this {
    const appearance = this.fieldOptions(name, rect, options),
      value = options.value ?? '';
    if (
      typeof value !== 'string' ||
      (options.multiline !== undefined && typeof options.multiline !== 'boolean')
    )
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'Text field value must be text and multiline must be boolean.',
      );
    if (
      options.maxLength !== undefined &&
      (!Number.isSafeInteger(options.maxLength) ||
        options.maxLength <= 0 ||
        value.length > options.maxLength)
    )
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'The text field maximum length must be positive and fit its value.',
      );
    assertEncodable(appearance.font!, value);
    const field = this.context.pdf.getForm().createTextField(name);
    if (options.multiline) field.enableMultiline();
    if (options.maxLength !== undefined) field.setMaxLength(options.maxLength);
    field.setText(value);
    this.fieldFlags(field, options);
    field.addToPage(this.page, appearance);
    field.setFontSize((options.fontSize ?? 12) / this.userUnit);
    field.updateAppearances(appearance.font!);
    return this;
  }

  /** Create an interactive checkbox with a native checkmark appearance. */
  addCheckBox(name: string, rect: DocumentRectangle, options: DocumentCheckBoxOptions = {}): this {
    const appearance = this.fieldOptions(name, rect, options);
    if (options.checked !== undefined && typeof options.checked !== 'boolean')
      throw new RenderPDFError('INVALID_OPTIONS', 'The checkbox state must be boolean.');
    const field = this.context.pdf.getForm().createCheckBox(name);
    if (options.checked) field.check();
    this.fieldFlags(field, options);
    field.addToPage(this.page, appearance);
    field.updateAppearances();
    return this;
  }

  /** Create a dropdown with copied choices and a validated initial selection. */
  addDropdown(
    name: string,
    rect: DocumentRectangle,
    choices: readonly string[],
    options: DocumentDropdownOptions = {},
  ): this {
    const appearance = this.fieldOptions(name, rect, options);
    if (
      !Array.isArray(choices) ||
      choices.some((choice) => typeof choice !== 'string') ||
      new Set(choices).size !== choices.length
    )
      throw new RenderPDFError('INVALID_OPTIONS', 'Dropdown choices must be unique strings.');
    for (const flag of [options.editable, options.multiselect])
      if (flag !== undefined && typeof flag !== 'boolean')
        throw new RenderPDFError('INVALID_OPTIONS', 'Dropdown flags must be booleans.');
    const values: readonly string[] =
      typeof options.value === 'string' ? [options.value] : (options.value ?? []);
    if (
      !Array.isArray(values) ||
      values.some(
        (value) => typeof value !== 'string' || (!options.editable && !choices.includes(value)),
      ) ||
      (!options.multiselect && values.length > 1)
    )
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'The dropdown selection must match its choices and selection mode.',
      );
    for (const value of [...choices, ...values]) assertEncodable(appearance.font!, value);
    const field = this.context.pdf.getForm().createDropdown(name);
    field.setOptions([...choices]);
    if (options.editable) field.enableEditing();
    if (options.multiselect) field.enableMultiselect();
    if (values.length) field.select([...values]);
    this.fieldFlags(field, options);
    field.addToPage(this.page, appearance);
    field.setFontSize((options.fontSize ?? 12) / this.userUnit);
    field.updateAppearances(appearance.font!);
    return this;
  }
}
