import fontkit from '@pdf-lib/fontkit';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, StandardFonts } from 'pdf-lib';
import type { PDFFont, PDFRef } from 'pdf-lib';
import type { FontSource, RenderPDFResult } from './api-types.js';
import type {
  DocumentBookmark,
  DocumentBookmarkOptions,
  DocumentFontOptions,
  DocumentPageOptions,
  DocumentTextMetrics,
  DocumentUnit,
  PDFDocumentOptions,
} from './document-types.js';
import { appendPDFPages, loadPDFSource } from './compose-pdf.js';
import type { PDFSource } from './compose-pdf.js';
import { RenderPDFError, throwIfAborted } from './diagnostics.js';
import { PDFPageBuilder } from './document-page.js';
import { applyPDFMetadata, resolveMetadata } from './export-options.js';
import { assertStaticSfnt } from './fonts.js';
import { createResult } from './result.js';

/** Point sizes avoid the CSS reference-pixel conversion used by HTML layout. */
const papers = { A4: [595.28, 841.89], A3: [841.89, 1190.55], Letter: [612, 792] } as const;

/** Resolve exact face identity consistently for drawing and measurement. */
function fontKey(options: DocumentFontOptions = {}): string {
  if (
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    (options.font !== undefined && (typeof options.font !== 'string' || !options.font.trim()))
  ) {
    throw new RenderPDFError('INVALID_OPTIONS', 'Provide a nonempty font family and font options.');
  }
  let family = options.font?.trim().toLowerCase() || 'helvetica';
  if (family === 'times-roman') family = 'times';
  const weight = options.fontWeight ?? 400;
  const style = options.fontStyle ?? 'normal';
  if (
    !Number.isInteger(weight) ||
    weight < 1 ||
    weight > 1000 ||
    !['normal', 'italic'].includes(style)
  ) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'Provide an exact static font weight and normal/italic style.',
    );
  }
  return `${family}:${weight}:${style}`;
}

/** Validate page settings before the underlying page tree changes. */
function pageSize(options: DocumentPageOptions, scale: number): [number, number] {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new RenderPDFError('INVALID_OPTIONS', 'Page options must be an object.');
  }
  const format = options.format ?? 'A4';
  const orientation = options.orientation ?? 'portrait';
  if (!['portrait', 'landscape'].includes(orientation)) {
    throw new RenderPDFError('INVALID_OPTIONS', 'Page orientation must be portrait or landscape.');
  }
  let dimensions: readonly number[];
  if (typeof format === 'string' && Object.hasOwn(papers, format)) dimensions = papers[format];
  else if (format && typeof format === 'object')
    dimensions = [format.width * scale, format.height * scale];
  else
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'Provide A4, A3, Letter or explicit page dimensions.',
    );
  if (dimensions.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new RenderPDFError('INVALID_OPTIONS', 'Page dimensions must be finite and positive.');
  }
  return orientation === 'landscape'
    ? [dimensions[1]!, dimensions[0]!]
    : [dimensions[0]!, dimensions[1]!];
}

/** Keep each outline node and its backend reference private to its document. */
interface BookmarkNode {
  handle: DocumentBookmark;
  ref: PDFRef;
  dict: PDFDict;
  children: BookmarkNode[];
}

/** Mutable PDF document; drawing is synchronous after resources are prepared. */
export class PDFBuilder {
  /** Point conversion shared by page drawing and compatibility adapters. */
  readonly unitScale: number;
  /** Coordinate unit selected at document creation. */
  readonly unit: DocumentUnit;
  private readonly pages: PDFPageBuilder[] = [];
  private readonly activePages = new Set<PDFRef>();
  private readonly characterSets = new WeakMap<PDFFont, ReadonlySet<number>>();
  private readonly bookmarks = new Map<DocumentBookmark, BookmarkNode>();
  private readonly roots: BookmarkNode[] = [];
  private readonly outlines: PDFRef;
  private finished = false;
  private pending = false;
  private output: Promise<RenderPDFResult> | undefined;

  private constructor(
    private readonly pdf: PDFDocument,
    private readonly fonts: ReadonlyMap<string, PDFFont>,
    private readonly fontNames: readonly string[],
    private readonly defaults: DocumentPageOptions,
    unit: DocumentUnit,
    private readonly signal: AbortSignal | undefined,
  ) {
    this.unit = unit;
    this.unitScale = unit === 'mm' ? 72 / 25.4 : unit === 'px' ? 0.75 : 1;
    this.outlines = pdf.context.register(pdf.context.obj({ Type: 'Outlines' }));
  }

  /** Prepare font programs without reading any browser globals. */
  static async create(options: PDFDocumentOptions = {}): Promise<PDFBuilder> {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new RenderPDFError('INVALID_OPTIONS', 'Document options must be an object.');
    }
    const unit = options.unit ?? 'pt';
    if (!['pt', 'mm', 'px'].includes(unit)) {
      throw new RenderPDFError('INVALID_OPTIONS', 'Document coordinates use pt, mm or px.');
    }
    const defaults: DocumentPageOptions = {
      format: typeof options.format === 'object' ? { ...options.format } : (options.format ?? 'A4'),
      orientation: options.orientation ?? 'portrait',
    };
    pageSize(defaults, unit === 'mm' ? 72 / 25.4 : unit === 'px' ? 0.75 : 1);
    const metadata = resolveMetadata(options.metadata);
    const signal = options.signal;
    if (
      signal !== undefined &&
      (!(typeof signal === 'object') ||
        signal === null ||
        typeof signal.aborted !== 'boolean' ||
        typeof signal.addEventListener !== 'function')
    ) {
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'Provide an AbortSignal for document cancellation.',
      );
    }
    throwIfAborted(signal);
    if (options.fonts !== undefined && !Array.isArray(options.fonts)) {
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'Document fonts must be an array of static font sources.',
      );
    }
    const definitions: FontSource[] = (options.fonts ?? []).map((source) => {
      if (
        !source ||
        typeof source.family !== 'string' ||
        !source.family.trim() ||
        (!(source.data instanceof Uint8Array) && !(source.data instanceof ArrayBuffer))
      ) {
        throw new RenderPDFError(
          'INVALID_OPTIONS',
          'Provide a font family and static TTF/OTF bytes.',
        );
      }
      const bytes = Uint8Array.from(
        source.data instanceof Uint8Array ? source.data : new Uint8Array(source.data),
      );
      assertStaticSfnt(bytes);
      const definition = {
        family: source.family.trim(),
        data: bytes,
        weight: source.weight ?? 400,
        style: source.style ?? 'normal',
      };
      fontKey({
        font: definition.family,
        fontWeight: definition.weight,
        fontStyle: definition.style,
      });
      return definition;
    });
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    applyPDFMetadata(pdf, metadata);
    const fonts = new Map<string, PDFFont>();
    const names = new Set<string>();
    const families = [
      [
        'Helvetica',
        StandardFonts.Helvetica,
        StandardFonts.HelveticaBold,
        StandardFonts.HelveticaOblique,
        StandardFonts.HelveticaBoldOblique,
      ],
      [
        'Times',
        StandardFonts.TimesRoman,
        StandardFonts.TimesRomanBold,
        StandardFonts.TimesRomanItalic,
        StandardFonts.TimesRomanBoldItalic,
      ],
      [
        'Courier',
        StandardFonts.Courier,
        StandardFonts.CourierBold,
        StandardFonts.CourierOblique,
        StandardFonts.CourierBoldOblique,
      ],
    ] as const;
    for (const [family, regular, bold, italic, boldItalic] of families) {
      for (const [name, weight, style] of [
        [regular, 400, 'normal'],
        [bold, 700, 'normal'],
        [italic, 400, 'italic'],
        [boldItalic, 700, 'italic'],
      ] as const) {
        throwIfAborted(signal);
        fonts.set(
          fontKey({ font: family, fontWeight: weight, fontStyle: style }),
          await pdf.embedFont(name),
        );
      }
      names.add(family);
    }
    for (const definition of definitions) {
      throwIfAborted(signal);
      const key = fontKey({
        font: definition.family,
        fontWeight: definition.weight ?? 400,
        fontStyle: definition.style ?? 'normal',
      });
      if (fonts.has(key))
        throw new RenderPDFError(
          'INVALID_OPTIONS',
          'Each font family, weight and style must be unique.',
        );
      try {
        fonts.set(key, await pdf.embedFont(definition.data, { subset: true }));
        names.add(definition.family);
      } catch (cause) {
        throw new RenderPDFError('FONT_LOAD_FAILED', `Could not embed font ${definition.family}.`, {
          cause,
        });
      }
    }
    throwIfAborted(signal);
    return new PDFBuilder(pdf, fonts, Object.freeze([...names]), defaults, unit, signal);
  }

  /** Number of physical pages currently in the document. */
  get pageCount(): number {
    return this.pages.length;
  }

  /** Snapshot of registered family names, including standard PDF fonts. */
  getFontNames(): readonly string[] {
    return this.fontNames;
  }

  private assertMutable(): void {
    throwIfAborted(this.signal);
    if (this.finished)
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'The document has been finalized; create another document to edit it.',
      );
  }

  private assertActive(): void {
    this.assertMutable();
    if (this.pending)
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'Await the pending document operation before drawing or saving.',
      );
  }

  private resolveFont(options: DocumentFontOptions = {}): PDFFont {
    const font = this.fonts.get(fontKey(options));
    if (!font)
      throw new RenderPDFError(
        'MISSING_FONT',
        `Register the requested ${options.font ?? 'Helvetica'} weight and style before drawing.`,
      );
    return font;
  }

  private wrapPage(page: import('pdf-lib').PDFPage, index = this.pages.length): PDFPageBuilder {
    this.activePages.add(page.ref);
    const wrapper = new PDFPageBuilder(page, {
      pdf: this.pdf,
      scale: this.unitScale,
      resolveFont: (options) => this.resolveFont(options),
      assertActive: () => {
        this.assertActive();
        if (!this.activePages.has(page.ref))
          throw new RenderPDFError(
            'INVALID_OPTIONS',
            'This page has been removed from its document.',
          );
      },
    });
    this.pages.splice(index, 0, wrapper);
    return wrapper;
  }

  /** Add an independently sized page; no empty page is created implicitly. */
  addPage(options: DocumentPageOptions = {}): PDFPageBuilder {
    this.assertActive();
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new RenderPDFError('INVALID_OPTIONS', 'Page options must be an object.');
    if (this.pages.length >= 1000)
      throw new RenderPDFError('INVALID_OPTIONS', 'A document is limited to 1000 pages.');
    return this.wrapPage(
      this.pdf.addPage(pageSize({ ...this.defaults, ...options }, this.unitScale)),
    );
  }

  /** Insert a page before the given one-based position; pageCount + 1 appends. */
  insertPage(pageNumber: number, options: DocumentPageOptions = {}): PDFPageBuilder {
    this.assertActive();
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new RenderPDFError('INVALID_OPTIONS', 'Page options must be an object.');
    if (
      !Number.isInteger(pageNumber) ||
      pageNumber < 1 ||
      pageNumber > this.pageCount + 1 ||
      this.pageCount >= 1000
    ) {
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'Insertion position must be within this document and its 1000-page limit.',
      );
    }
    return this.wrapPage(
      this.pdf.insertPage(
        pageNumber - 1,
        pageSize({ ...this.defaults, ...options }, this.unitScale),
      ),
      pageNumber - 1,
    );
  }

  /** Reorder existing pages while retaining native destination references. */
  movePage(from: number, to: number): this {
    this.assertActive();
    const wrapper = this.getPage(from);
    this.getPage(to);
    if (from === to) return this;
    const page = this.pdf.getPage(from - 1);
    this.pdf.removePage(from - 1);
    this.pdf.insertPage(to - 1, page);
    this.pages.splice(from - 1, 1);
    this.pages.splice(to - 1, 0, wrapper);
    return this;
  }

  /** Remove a page only when it is not a bookmark/link target or interactive form owner. */
  removePage(pageNumber: number): this {
    this.assertActive();
    this.getPage(pageNumber).assertComplete();
    const ref = this.pdf.getPage(pageNumber - 1).ref;
    for (const node of this.bookmarks.values()) {
      const dest = node.dict.lookup(PDFName.of('Dest'), PDFArray);
      if (dest.get(0) === ref)
        throw new RenderPDFError('INVALID_OPTIONS', 'Cannot remove a bookmarked page.');
    }
    for (const page of this.pdf.getPages()) {
      for (const annotation of page.node.Annots()?.asArray() ?? []) {
        const dict = this.pdf.context.lookup(annotation, PDFDict);
        if (page.ref === ref && dict.get(PDFName.of('Subtype')) === PDFName.of('Widget')) {
          throw new RenderPDFError(
            'INVALID_OPTIONS',
            'Flatten form fields before removing their page.',
          );
        }
        const action = dict.lookupMaybe(PDFName.of('A'), PDFDict);
        const destination =
          dict.lookupMaybe(PDFName.of('Dest'), PDFArray) ??
          action?.lookupMaybe(PDFName.of('D'), PDFArray);
        if (destination?.get(0) === ref)
          throw new RenderPDFError(
            'INVALID_OPTIONS',
            'Cannot remove a page targeted by an internal link.',
          );
      }
    }
    this.pdf.removePage(pageNumber - 1);
    this.activePages.delete(ref);
    this.pages.splice(pageNumber - 1, 1);
    return this;
  }

  /** Look up an existing page by its one-based number. */
  getPage(pageNumber: number): PDFPageBuilder {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > this.pageCount) {
      throw new RenderPDFError('INVALID_OPTIONS', 'Page number is outside this document.');
    }
    return this.pages[pageNumber - 1]!;
  }

  /** Return page handles in document order without exposing the mutable page list. */
  getPages(): readonly PDFPageBuilder[] {
    return Object.freeze([...this.pages]);
  }

  /** Measure using the same embedded font program used by page drawing. */
  measureText(
    text: string,
    options: DocumentFontOptions & { fontSize?: number; lineHeight?: number } = {},
  ): DocumentTextMetrics {
    this.assertActive();
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new RenderPDFError('INVALID_OPTIONS', 'Text measurement options must be an object.');
    if (typeof text !== 'string')
      throw new RenderPDFError('INVALID_OPTIONS', 'Text must be a string.');
    const size = options.fontSize ?? 12;
    const leading = options.lineHeight ?? 1.15;
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(leading) || leading <= 0) {
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'Font size and line height must be finite and positive.',
      );
    }
    const font = this.resolveFont(options);
    let supported = this.characterSets.get(font);
    if (!supported) {
      supported = new Set(font.getCharacterSet());
      this.characterSets.set(font, supported);
    }
    for (const char of text.replace(/[\r\n]/g, '')) {
      if (!supported.has(char.codePointAt(0)!))
        throw new RenderPDFError('MISSING_GLYPH', `The selected font has no glyph for ${char}.`);
    }
    const lines = text.split(/\r\n|\r|\n/);
    const ascent = font.heightAtSize(size, { descender: false });
    const descent = Math.max(0, font.heightAtSize(size) - ascent);
    let width = 0;
    for (const line of lines) width = Math.max(width, font.widthOfTextAtSize(line, size));
    return {
      width: width / this.unitScale,
      height: (text ? lines.length * size * leading : 0) / this.unitScale,
      ascent: ascent / this.unitScale,
      descent: descent / this.unitScale,
    };
  }

  /** Append native PDF pages, preserving page geometry and supported page content. */
  async appendPDF(source: PDFSource, pageNumbers?: readonly number[]): Promise<this> {
    this.assertActive();
    if (
      pageNumbers !== undefined &&
      (!Array.isArray(pageNumbers) ||
        pageNumbers.length === 0 ||
        pageNumbers.length > 1000 ||
        pageNumbers.some((page) => !Number.isSafeInteger(page) || page < 1))
    ) {
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'Provide a nonempty array of positive integer page numbers.',
      );
    }
    const selection = pageNumbers === undefined ? undefined : [...pageNumbers];
    this.pending = true;
    try {
      const donor = await loadPDFSource(source, this.signal);
      this.assertMutable();
      const pages = await appendPDFPages(this.pdf, donor, selection, this.signal);
      for (const page of pages) this.wrapPage(page);
      return this;
    } finally {
      this.pending = false;
    }
  }

  /** Flatten prepared interactive appearances into ordinary page content. */
  flattenForms(): this {
    this.assertActive();
    for (const page of this.pages) page.assertComplete();
    this.pdf.getForm().flatten({ updateFieldAppearances: false });
    // pdf-lib can leave deleted widget references behind after flattening.
    for (const page of this.pdf.getPages()) {
      const annotations = page.node.Annots();
      if (!annotations) continue;
      for (let index = annotations.size() - 1; index >= 0; index -= 1) {
        if (!this.pdf.context.lookup(annotations.get(index))) annotations.remove(index);
      }
    }
    return this;
  }

  /** Create a bookmark pointing to an existing page, optionally below another bookmark. */
  addBookmark(title: string, options: DocumentBookmarkOptions): DocumentBookmark {
    this.assertActive();
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new RenderPDFError('INVALID_OPTIONS', 'Provide bookmark destination options.');
    if (typeof title !== 'string' || !title.trim())
      throw new RenderPDFError('INVALID_OPTIONS', 'Bookmark title must be nonempty.');
    this.getPage(options.pageNumber);
    const parent = options.parent ? this.bookmarks.get(options.parent) : undefined;
    if (options.parent && !parent)
      throw new RenderPDFError('INVALID_OPTIONS', 'Bookmark parent belongs to another document.');
    const target = this.pdf.getPage(options.pageNumber - 1).ref;
    const backend = this.pdf;
    const handle = Object.freeze({
      title,
      get pageNumber() {
        return backend.getPages().findIndex((page) => page.ref === target) + 1;
      },
    });
    const dict = this.pdf.context.obj({
      Title: PDFHexString.fromText(title),
      Parent: parent?.ref ?? this.outlines,
      Dest: [this.pdf.getPage(options.pageNumber - 1).ref, PDFName.of('Fit')],
    });
    const node = { handle, dict, ref: this.pdf.context.register(dict), children: [] };
    this.bookmarks.set(handle, node);
    (parent?.children ?? this.roots).push(node);
    return handle;
  }

  private writeBookmarks(): void {
    if (!this.roots.length) return;
    const linkChildren = (parent: PDFDict, children: BookmarkNode[]): number => {
      let count = 0;
      for (const [index, node] of children.entries()) {
        if (index > 0) node.dict.set(PDFName.of('Prev'), children[index - 1]!.ref);
        if (index + 1 < children.length)
          node.dict.set(PDFName.of('Next'), children[index + 1]!.ref);
        count += 1 + linkChildren(node.dict, node.children);
      }
      if (children.length) {
        parent.set(PDFName.of('First'), children[0]!.ref);
        parent.set(PDFName.of('Last'), children[children.length - 1]!.ref);
        parent.set(PDFName.of('Count'), this.pdf.context.obj(count));
      }
      return count;
    };
    linkChildren(this.pdf.context.lookup(this.outlines, PDFDict), this.roots);
    this.pdf.catalog.set(PDFName.of('Outlines'), this.outlines);
  }

  /** Finalize once; subsequent output requests reuse the same immutable PDF. */
  async toResult(): Promise<RenderPDFResult> {
    if (this.output) return this.output;
    this.assertActive();
    if (!this.pageCount)
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'Add at least one page before finalizing the document.',
      );
    for (const page of this.pages) page.assertComplete();
    this.writeBookmarks();
    this.finished = true;
    this.output = this.pdf
      .save({ updateFieldAppearances: false })
      .then((bytes) => {
        throwIfAborted(this.signal);
        return createResult(bytes, this.pageCount, []);
      })
      .catch((cause: unknown) => {
        if (
          cause instanceof RenderPDFError ||
          (cause instanceof Error && cause.name === 'AbortError')
        )
          throw cause;
        throw new RenderPDFError('PDF_WRITE_FAILED', 'The document could not be serialized.', {
          cause,
        });
      });
    return this.output;
  }
}

/** Prepare an empty document with registered fonts and explicit coordinate units. */
export async function createDocument(options: PDFDocumentOptions = {}): Promise<PDFBuilder> {
  return PDFBuilder.create(options);
}
