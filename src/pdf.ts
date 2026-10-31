import fontkit from '@pdf-lib/fontkit';
import {
  PDFDocument,
  PDFArray,
  PDFHexString,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  beginText,
  clip,
  endPath,
  endText,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setFillingColor,
  setFontAndSize,
  setGraphicsState,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  TextRenderingMode,
} from 'pdf-lib';
import type { PDFFont, PDFImage, PDFName, PDFPage } from 'pdf-lib';
import type { PageGeometry, PDFMetadata, RegisteredFont, RenderProgress } from './api-types.js';
import { RenderPDFError, throwIfAborted } from './diagnostics.js';
import { applyPDFMetadata } from './export-options.js';
import { inspectBitmap, validatePngData } from './image-input.js';
import { nativeImageFormat } from './images.js';
import type { PageText, PreparedPageBand } from './page-bands.js';
import type { PageSlice } from './pagination.js';
import { captureRaster, prepareRasterFontCss } from './raster.js';
import { PositionedFont } from './text.js';
import type { PositionedGlyph } from './text.js';
import type {
  Bounds,
  LayoutSnapshot,
  PaintOperation,
  RoundedCorners,
  TextOperation,
} from './types.js';

/** CSS reference pixels convert to PDF points only at this adapter boundary. */
const PX_TO_PT = 0.75;

/** Approximate each quarter ellipse with one cubic PDF path segment. */
const QUARTER_ELLIPSE = (4 / 3) * Math.tan(Math.PI / 8);

/** Permit subsetting only the TrueType SFNT flavor verified by the browser suite. */
function canSubsetTrueType(
  /** Registered font bytes, before pdf-lib parses the program. */
  bytes: Uint8Array,
): boolean {
  // fontkit's CFF subset stream is not accepted by PDF.js for the registered OTF fixtures.
  return bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0;
}

/** Build a closed SVG path in local top-left CSS pixel coordinates. */
function roundedRectanglePath(
  /** Border-box width in CSS pixels. */
  width: number,
  /** Border-box height in CSS pixels. */
  height: number,
  /** Browser-resolved corner radii in CSS pixels. */
  corners: RoundedCorners,
): string {
  // Each corner's control distances follow the same quarter-ellipse ratio.
  const { topLeft, topRight, bottomRight, bottomLeft } = corners;
  return [
    `M ${topLeft.x} 0`,
    `L ${width - topRight.x} 0`,
    `C ${width - topRight.x + QUARTER_ELLIPSE * topRight.x} 0 ${width} ${topRight.y - QUARTER_ELLIPSE * topRight.y} ${width} ${topRight.y}`,
    `L ${width} ${height - bottomRight.y}`,
    `C ${width} ${height - bottomRight.y + QUARTER_ELLIPSE * bottomRight.y} ${width - bottomRight.x + QUARTER_ELLIPSE * bottomRight.x} ${height} ${width - bottomRight.x} ${height}`,
    `L ${bottomLeft.x} ${height}`,
    `C ${bottomLeft.x - QUARTER_ELLIPSE * bottomLeft.x} ${height} 0 ${height - bottomLeft.y + QUARTER_ELLIPSE * bottomLeft.y} 0 ${height - bottomLeft.y}`,
    `L 0 ${topLeft.y}`,
    `C 0 ${topLeft.y - QUARTER_ELLIPSE * topLeft.y} ${topLeft.x - QUARTER_ELLIPSE * topLeft.x} 0 ${topLeft.x} 0`,
    'Z',
  ].join(' ');
}

/** Inset an already normalized CSS corner for a uniform centered border stroke. */
function insetRoundedCorners(
  /** Outer border-box radii in CSS pixels. */
  corners: RoundedCorners,
  /** Half the uniform border width in CSS pixels. */
  inset: number,
): RoundedCorners {
  // A zero inner component becomes square instead of crossing the opposite edge.
  const reduce = ({ x, y }: RoundedCorners['topLeft']) => ({
    x: Math.max(0, x - inset),
    y: Math.max(0, y - inset),
  });
  return {
    topLeft: reduce(corners.topLeft),
    topRight: reduce(corners.topRight),
    bottomRight: reduce(corners.bottomRight),
    bottomLeft: reduce(corners.bottomLeft),
  };
}

/** Bounded writer settings independent of DOM layout measurement. */
export interface PDFWriteOptions {
  /** Physical pixels per CSS pixel for explicitly selected raster regions. */
  rasterScale?: number;
  /** Selected replacement family, used to reject unsafe raster text substitution. */
  fontFallback?: string;
  /** Include extraction-only text inside a region already painted as a bitmap. */
  includeRasterText?: boolean;
  /** Omit a raster root's unsupported outer shadow without changing the source. */
  omitUnsupportedCss?: boolean;
  /** Uniform source-to-paper ratio; page bands remain at their original physical size. */
  sourceScale?: number;
  /** Stop before beginning subsequent asynchronous writing stages. */
  signal?: AbortSignal;
  /** Prepared text or HTML placed above the source, outside its page clip. */
  header?: PreparedPageBand;
  /** Prepared text or HTML placed below the source, outside its page clip. */
  footer?: PreparedPageBand;
  /** Owned Unicode document properties, resolved before preparation begins. */
  metadata?: Readonly<PDFMetadata>;
  /** Internal awaited reporter; public application callbacks remain synchronous. */
  reportProgress?: (progress: RenderProgress) => Promise<void>;
}

/** Serialized PDF and the exact source intervals used for page ownership. */
export interface PDFWriteResult {
  /** Complete PDF file owned by this export. */
  bytes: Uint8Array;
  /** Shared source offsets for visible objects and extraction text. */
  slices: PageSlice[];
}

/** One embedded exact face with its Unicode coverage cached for the whole export. */
interface EmbeddedFace {
  /** Exact browser-facing family, weight and style contract. */
  definition: RegisteredFont;
  /** Public pdf-lib font adapter for text drawing. */
  font: PDFFont;
  /** Code points supported by the embedded program, never a silent substitute. */
  characters: ReadonlySet<number>;
  /** Shaped glyph origins and extraction maps reusable for repeated words. */
  positioned: PositionedFont;
}

/** Parse the computed sRGB colors admitted by the supported layout subset. */
function parseColor(
  /** Computed rgb()/rgba() value supplied by the browser snapshot. */
  value: string,
) {
  // Chromium serializes ordinary computed colors as rgb() or rgba().
  const parts = value.match(
    /^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/,
  );
  if (!parts) {
    throw new RenderPDFError('UNSUPPORTED_CSS', `Unsupported computed color: ${value}`);
  }
  return {
    color: rgb(Number(parts[1]) / 255, Number(parts[2]) / 255, Number(parts[3]) / 255),
    opacity: Number(parts[4] ?? 1),
  };
}

/** Match browser text to its explicit family and static face, then validate coverage. */
function matchingFont(
  /** Measured line whose exact selected face is required. */
  text: TextOperation,
  /** Embedded programs and their reusable coverage sets. */
  faces: readonly EmbeddedFace[],
): EmbeddedFace {
  // Case-insensitive family matching follows the explicit browser registration contract.
  const face = faces.find(
    /** A face must match all three descriptors; a synthetic browser face is unsupported. */
    ({ definition }) =>
      definition.family.toLowerCase() === text.family.toLowerCase() &&
      definition.weight === text.weight &&
      definition.style === text.style,
  );
  if (!face) {
    throw new RenderPDFError(
      'MISSING_FONT',
      `Unregistered font face: ${text.family} ${text.weight} ${text.style}`,
    );
  }
  for (const character of text.text) {
    if (!face.characters.has(character.codePointAt(0)!)) {
      throw new RenderPDFError(
        'MISSING_GLYPH',
        `Missing glyph: ${character} (${text.family} ${text.weight} ${text.style})`,
      );
    }
  }
  return face;
}

/** Page resource names are reused without depending on private PDFPage fields. */
interface TextResources {
  /** Public font references registered once for each page and exact face. */
  fonts: Map<PDFFont, PDFName>;
  /** Text opacity resources shared by equal alpha values within this page. */
  opacity: Map<number, PDFName>;
}

/** Emit one text-show operator for each constant-height shaped span. */
function drawPositionedRun(
  /** Page whose PDF font widths match the shaped glyph advances. */
  page: PDFPage,
  /** Glyph origins and nominal advances in the embedded font's units. */
  glyphs: readonly PositionedGlyph[],
  /** Measured browser run origin converted to PDF points. */
  x: number,
  /** Browser baseline converted to PDF points. */
  baseline: number,
  /** PDF points per font unit for this text size. */
  scale: number,
  /** Font units per em used by PDF TJ spacing adjustments. */
  unitsPerEm: number,
): void {
  // A TJ array adjusts only horizontal placement; different vertical offsets need a new matrix.
  for (let firstIndex = 0; firstIndex < glyphs.length;) {
    // Each span owns its first origin, encoded CID bytes and optional spacing array.
    const first = glyphs[firstIndex]!;
    let nextIndex = firstIndex + 1;
    let encoded = first.encoded.asString();
    let adjusted: PDFArray | undefined;
    for (; nextIndex < glyphs.length && glyphs[nextIndex]!.y === first.y; nextIndex += 1) {
      // Consecutive origins are compared against the previous glyph's PDF advance.
      const previous = glyphs[nextIndex - 1]!;
      const current = glyphs[nextIndex]!;
      // Positive TJ values move the pen left; the difference preserves kerning and mark offsets.
      const adjustment = ((previous.x + previous.advance - current.x) * 1000) / unitsPerEm;
      if (adjustment !== 0) {
        adjusted ??= PDFArray.withContext(page.doc.context);
        adjusted.push(PDFHexString.of(encoded));
        adjusted.push(PDFNumber.of(adjustment));
        encoded = '';
      }
      encoded += current.encoded.asString();
    }
    // Unadjusted spans serialize as one short Tj; only spaced spans need TJ arrays.
    const textOperator = adjusted
      ? (adjusted.push(PDFHexString.of(encoded)),
        PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [adjusted]))
      : showText(PDFHexString.of(encoded));
    page.pushOperators(
      setTextMatrix(1, 0, 0, 1, x + first.x * scale, baseline + first.y * scale),
      textOperator,
    );
    firstIndex = nextIndex;
  }
}

/** Paint shaped glyphs at measured run origins without scaling glyph outlines. */
function drawLine(
  /** PDF page owning this complete measured line. */
  page: PDFPage,
  /** Browser line origins and baseline in source CSS pixels. */
  text: TextOperation,
  /** Matching embedded font program. */
  face: EmbeddedFace,
  /** Inclusive source top of the current page, in CSS pixels. */
  start: number,
  /** Page edges and margins in CSS pixels. */
  geometry: PageGeometry,
  /** Resource caches owned by this one PDF page. */
  resources: TextResources,
  /** Uniform source scale, with one for page text outside the source. */
  sourceScale = 1,
): void {
  // Text rendering mode 3 preserves extraction without painting a second visible copy.
  const color = parseColor(text.color);
  let fontName = resources.fonts.get(face.font);
  if (!fontName) {
    fontName = page.node.newFontDictionary(face.font.name, face.font.ref);
    resources.fonts.set(face.font, fontName);
  }
  page.pushOperators(pushGraphicsState(), setFillingColor(color.color));
  if (color.opacity !== 1) {
    let opacity = resources.opacity.get(color.opacity);
    if (!opacity) {
      opacity = page.node.newExtGState(
        'TextOpacity',
        page.doc.context.obj({ Type: 'ExtGState', ca: color.opacity }),
      );
      resources.opacity.set(color.opacity, opacity);
    }
    page.pushOperators(setGraphicsState(opacity));
  }
  page.pushOperators(
    beginText(),
    setFontAndSize(fontName, text.fontSize * sourceScale * PX_TO_PT),
    setTextRenderingMode(text.invisible ? TextRenderingMode.Invisible : TextRenderingMode.Fill),
  );
  const scale = (text.fontSize * sourceScale * PX_TO_PT) / face.positioned.unitsPerEm;
  const baseline =
    (geometry.height - geometry.margin.top - (text.baseline - start) * sourceScale) * PX_TO_PT;
  for (const run of text.runs) {
    const x = (geometry.margin.left + run.x * sourceScale) * PX_TO_PT;
    drawPositionedRun(
      page,
      face.positioned.shape(run.text, text.kerning ?? true),
      x,
      baseline,
      scale,
      face.positioned.unitsPerEm,
    );
  }
  page.pushOperators(endText(), popGraphicsState());
}

/** Prepare a single shaped, selectable page line after the final page count is known. */
function pageTextLine(
  /** Validated immutable band settings. */
  band: PageText,
  /** One-based physical page number. */
  pageNumber: number,
  /** Final page total, including all table continuation pages. */
  pageCount: number,
  /** Reserved band top in CSS pixels from the paper's top edge. */
  top: number,
  /** Original page margins defining horizontal alignment. */
  geometry: PageGeometry,
  /** Exact embedded face programs with shaped glyph metrics. */
  faces: readonly EmbeddedFace[],
): TextOperation {
  const text = band.text
    .replaceAll('{pageNumber}', String(pageNumber))
    .replaceAll('{pageCount}', String(pageCount));
  const face = faces.find((candidate) => candidate.definition === band.font)!;
  const scale = band.fontSize / face.positioned.unitsPerEm;
  const metrics = face.positioned.measure(text);
  const width = (metrics.right - metrics.left) * scale;
  const height = (metrics.ascent + metrics.descent) * scale;
  const availableWidth = geometry.width - geometry.margin.left - geometry.margin.right;
  if (width > availableWidth + 0.01 || height > band.height + 0.01) {
    throw new RenderPDFError(
      'SOURCE_OVERFLOW',
      'Page header/footer text does not fit its reserved height or page content width; increase its area or reduce fontSize.',
    );
  }
  const offset =
    band.align === 'right'
      ? availableWidth - width
      : band.align === 'center'
        ? (availableWidth - width) / 2
        : 0;
  const x = offset - metrics.left * scale;
  // drawLine expects root coordinates; these page bands use the original top margin as origin.
  const y = top - geometry.margin.top + (band.height - height) / 2;
  return {
    kind: 'text',
    bounds: { x: offset, y, width, height },
    text,
    runs: [{ text, x, width }],
    baseline: y + metrics.ascent * scale,
    fontSize: band.fontSize,
    family: band.font.family,
    weight: band.font.weight,
    style: band.font.style,
    color: 'rgb(0, 0, 0)',
    invisible: false,
  };
}

/** Expand one or three selectable page lines and reject text that would paint over another slot. */
function pageBandLines(
  /** Immutable prepared band; HTML is painted as an embedded PDF page instead. */
  band: PreparedPageBand | undefined,
  /** One-based page number after final pagination. */
  pageNumber: number,
  /** Physical page total used by placeholders. */
  pageCount: number,
  /** Band top edge in CSS pixels from the physical paper edge. */
  top: number,
  /** Original paper and printable width in CSS pixels. */
  geometry: PageGeometry,
  /** Embedded programs whose metrics match text drawing. */
  faces: readonly EmbeddedFace[],
): TextOperation[] {
  if (!band || ('kind' in band && band.kind === 'html')) return [];
  const settings = 'kind' in band ? band.lines : [band];
  const lines = settings.map((line) =>
    pageTextLine(line, pageNumber, pageCount, top, geometry, faces),
  );
  for (const [index, first] of lines.entries()) {
    matchingFont(first, faces);
    for (const second of lines.slice(index + 1)) {
      if (
        first.bounds.x < second.bounds.x + second.bounds.width - 0.01 &&
        second.bounds.x < first.bounds.x + first.bounds.width - 0.01 &&
        first.bounds.y < second.bounds.y + second.bounds.height - 0.01 &&
        second.bounds.y < first.bounds.y + first.bounds.height - 0.01
      ) {
        throw new RenderPDFError('SOURCE_OVERFLOW', 'Page header/footer text slots overlap.');
      }
    }
  }
  return lines;
}

/** Expand a raster placement to whole CSS pixels without shifting visible content. */
function rasterPlacement(
  /** Original browser border box in source CSS pixels. */
  bounds: Bounds,
): Bounds {
  // Transparent padding retains fractional pixel phase inside an aligned image.
  const x = Math.floor(bounds.x);
  const y = Math.floor(bounds.y);
  return {
    x,
    y,
    width: Math.ceil(bounds.x + bounds.width) - x,
    height: Math.ceil(bounds.y + bounds.height) - y,
  };
}

/** Read a browser-accessible PNG/JPEG without changing or recapturing the source DOM. */
async function embedImage(
  /** PDF document receiving the original compressed bitmap bytes. */
  pdf: PDFDocument,
  /** Decoded source image resolved by the browser's resource selection. */
  element: HTMLImageElement,
  /** Optional caller signal also passed to the resource request. */
  signal?: AbortSignal,
): Promise<PDFImage> {
  // currentSrc preserves the exact browser-selected resource after image preparation.
  const source = element.currentSrc || element.src;
  try {
    throwIfAborted(signal);
    // CORS fetch prevents opaque cross-origin data from becoming an apparently valid export.
    const response = await fetch(source, {
      mode: 'cors',
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`Image request returned HTTP ${response.status}.`);
    // Inspect actual signatures rather than trusting a filename or server Content-Type.
    const bytes = new Uint8Array(await response.arrayBuffer());
    throwIfAborted(signal);
    // The export response can differ from the already-decoded browser image; validate these exact bytes.
    const bitmap = inspectBitmap(bytes);
    // HTML image placement cannot apply the standalone image API's EXIF transformation.
    nativeImageFormat(bytes);
    if (bitmap.orientation !== 1) {
      throw new RenderPDFError(
        'RESOURCE_LOAD_FAILED',
        'HTML image orientation must be 1; normalize its pixels before exporting.',
      );
    }
    if (bitmap.format === 'png') {
      await validatePngData(bytes, signal);
      throwIfAborted(signal);
      return await pdf.embedPng(bytes);
    }
    return await pdf.embedJpg(bytes);
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof RenderPDFError) throw error;
    throw new RenderPDFError(
      'RESOURCE_LOAD_FAILED',
      'The source image could not be embedded; provide a readable PNG/JPEG with same-origin or CORS access.',
      { cause: error },
    );
  }
}

/** Serialize a measured display list with consistent ordered paint and page mapping. */
export async function writePDF(
  /** Prepared source geometry; this adapter never performs DOM measurement. */
  snapshot: LayoutSnapshot,
  /** Exact font programs already registered for source browser layout. */
  fonts: readonly RegisteredFont[],
  /** Validated physical page and per-edge margins, in CSS pixels. */
  geometry: PageGeometry,
  /** Validated source intervals planned before diagnostics and any PDF allocation. */
  slices: PageSlice[],
  /** Optional raster quality and cancellation controls. */
  options: PDFWriteOptions = {},
): Promise<PDFWriteResult> {
  try {
    throwIfAborted(options.signal);
    const sourceScale = options.sourceScale ?? 1;
    if (!Number.isFinite(sourceScale) || sourceScale <= 0 || sourceScale > 1) {
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'Source scale must be greater than zero and at most one.',
      );
    }
    if (
      snapshot.width * sourceScale >
      geometry.width - geometry.margin.left - geometry.margin.right + 0.01
    ) {
      throw new RenderPDFError('SOURCE_OVERFLOW', 'Source is wider than the PDF content area.');
    }
    // The PDF dependency stays behind this adapter and receives only explicit font programs.
    const pdf = await PDFDocument.create();
    throwIfAborted(options.signal);
    pdf.registerFontkit(fontkit);
    applyPDFMetadata(pdf, options.metadata);
    // Only faces referenced by selectable text or text bands need PDF font objects.
    const neededFaceDescriptors = new Set(
      snapshot.operations
        .filter(
          (operation): operation is Extract<PaintOperation, { kind: 'text' }> =>
            operation.kind === 'text' &&
            (!operation.invisible || options.includeRasterText !== false),
        )
        .map(
          (operation) => `${operation.family.toLowerCase()}:${operation.weight}:${operation.style}`,
        ),
    );
    const neededBandFaces = new Set<RegisteredFont>();
    for (const band of [options.header, options.footer]) {
      if (!band || ('kind' in band && band.kind === 'html')) continue;
      if ('kind' in band && band.kind === 'slots') {
        for (const line of band.lines) neededBandFaces.add(line.font);
      } else {
        neededBandFaces.add(band.font);
      }
    }
    const embeddedDefinitions = fonts.filter(
      (font) =>
        neededBandFaces.has(font) ||
        neededFaceDescriptors.has(`${font.family.toLowerCase()}:${font.weight}:${font.style}`),
    );
    // Resources count processed fonts, local paint and prepared HTML forms.
    const resourceTotal = options.reportProgress
      ? embeddedDefinitions.length +
        snapshot.operations.filter(
          (operation) => operation.kind === 'image' || operation.kind === 'raster',
        ).length +
        Number(
          options.header !== undefined &&
            'kind' in options.header &&
            options.header.kind === 'html',
        ) +
        Number(
          options.footer !== undefined &&
            'kind' in options.footer &&
            options.footer.kind === 'html',
        )
      : 0;
    let resourceCompleted = 0;
    if (options.reportProgress)
      await options.reportProgress({ stage: 'resources', completed: 0, total: resourceTotal });
    // Subset CIDs are mapped back to shaped Unicode after all text is drawn.
    const faces: EmbeddedFace[] = [];
    for (const definition of embeddedDefinitions) {
      throwIfAborted(options.signal);
      // Cache coverage once per embedded face rather than rebuilding it for every line.
      const subset = canSubsetTrueType(definition.bytes);
      const font = await pdf.embedFont(definition.bytes, {
        subset,
      });
      faces.push({
        definition,
        font,
        characters: new Set(font.getCharacterSet()),
        positioned: new PositionedFont(font, definition.bytes, subset),
      });
      resourceCompleted += 1;
      if (options.reportProgress)
        await options.reportProgress({
          stage: 'resources',
          completed: resourceCompleted,
          total: resourceTotal,
        });
    }
    // Validate every line before allocating any potentially expensive raster capture.
    for (const operation of snapshot.operations) {
      if (
        operation.kind === 'text' &&
        (!operation.invisible || options.includeRasterText !== false)
      ) {
        matchingFont(operation, faces);
      }
    }
    // Validate page-specific placeholders and slot overlap before allocating raster captures.
    const pageLines = slices.map((_, index) => ({
      header: pageBandLines(
        options.header,
        index + 1,
        slices.length,
        geometry.margin.top,
        geometry,
        faces,
      ),
      footer: pageBandLines(
        options.footer,
        index + 1,
        slices.length,
        geometry.height - geometry.margin.bottom - (options.footer?.height ?? 0),
        geometry,
        faces,
      ),
    }));
    // An HTML band is rendered once as a vector/text PDF form and reused on every page.
    const embeddedHeader =
      options.header && 'kind' in options.header && options.header.kind === 'html'
        ? (await pdf.embedPdf(options.header.bytes))[0]
        : undefined;
    if (embeddedHeader) {
      resourceCompleted += 1;
      if (options.reportProgress)
        await options.reportProgress({
          stage: 'resources',
          completed: resourceCompleted,
          total: resourceTotal,
        });
    }
    const embeddedFooter =
      options.footer && 'kind' in options.footer && options.footer.kind === 'html'
        ? (await pdf.embedPdf(options.footer.bytes))[0]
        : undefined;
    if (embeddedFooter) {
      resourceCompleted += 1;
      if (options.reportProgress)
        await options.reportProgress({
          stage: 'resources',
          completed: resourceCompleted,
          total: resourceTotal,
        });
    }
    // Raster resources are captured exactly once per operation before ordered composition.
    const images = new Map<object, PDFImage>();
    // Repeated native image references share one embedded resource within the export.
    const nativeImages = new Map<string, PDFImage>();
    // Prepare font data URLs only if an operation actually needs a local raster capture.
    let rasterFontCss: string | undefined;
    for (const operation of snapshot.operations) {
      throwIfAborted(options.signal);
      if (operation.kind === 'raster') {
        // Paint fractional origins inside the bitmap, avoiding another PDF image shift.
        const aligned = rasterPlacement(operation.bounds);
        try {
          // The immutable string is shared across captures and released with this export.
          rasterFontCss ??= prepareRasterFontCss(fonts);
          // Local capture owns its temporary resources and never mutates the source.
          const bytes = await captureRaster(
            operation.element,
            fonts,
            options.rasterScale ?? 2,
            {
              x: operation.bounds.x - aligned.x,
              y: operation.bounds.y - aligned.y,
            },
            options.omitUnsupportedCss ?? false,
            rasterFontCss,
            options.fontFallback,
          );
          throwIfAborted(options.signal);
          images.set(operation, await pdf.embedPng(bytes));
        } catch (error) {
          throwIfAborted(options.signal);
          if (error instanceof RenderPDFError) throw error;
          throw new RenderPDFError(
            'RASTER_FAILED',
            'The selected local raster region could not be captured.',
            {
              cause: error,
            },
          );
        }
      }
      if (operation.kind === 'image') {
        // The browser-selected URL identifies the original compressed native image resource.
        const source = operation.element.currentSrc || operation.element.src;
        // An already embedded source can be painted at several measured locations.
        let image = nativeImages.get(source);
        if (!image) {
          image = await embedImage(pdf, operation.element, options.signal);
          nativeImages.set(source, image);
        }
        images.set(operation, image);
      }
      if (operation.kind === 'image' || operation.kind === 'raster') {
        resourceCompleted += 1;
        if (options.reportProgress)
          await options.reportProgress({
            stage: 'resources',
            completed: resourceCompleted,
            total: resourceTotal,
          });
      }
    }
    if (options.reportProgress)
      await options.reportProgress({ stage: 'pages', completed: 0, total: slices.length });
    for (const [pageIndex, slice] of slices.entries()) {
      throwIfAborted(options.signal);
      const page = pdf.addPage([geometry.width * PX_TO_PT, geometry.height * PX_TO_PT]);
      const textResources: TextResources = { fonts: new Map(), opacity: new Map() };
      /** Replay native paint inside one source-to-page interval without duplicating extraction. */
      function paint(
        /** Original operation references, so repeated images retain their embedded resources. */
        operations: readonly PaintOperation[],
        /** Source coordinate mapped to the area's top. */
        start: number,
        /** Physical page clip in CSS pixels, independent of source coordinates. */
        area: Bounds,
      ): void {
        const placementGeometry = { ...geometry, margin: { ...geometry.margin, top: area.y } };
        page.pushOperators(
          pushGraphicsState(),
          rectangle(
            area.x * PX_TO_PT,
            (geometry.height - area.y - area.height) * PX_TO_PT,
            area.width * PX_TO_PT,
            area.height * PX_TO_PT,
          ),
          clip(),
          endPath(),
        );
        for (const operation of operations) {
          // Skip off-page text entirely; clipping alone would leave duplicate extraction items.
          const bounds = operation.bounds;
          if (
            bounds.y >= start + area.height / sourceScale - 0.01 ||
            bounds.y + bounds.height <= start + 0.01
          )
            continue;
          if (operation.kind === 'text') {
            if (!operation.invisible || options.includeRasterText !== false) {
              drawLine(
                page,
                operation,
                matchingFont(operation, faces),
                start,
                placementGeometry,
                textResources,
                sourceScale,
              );
            }
            continue;
          }
          // Padding is transparent; page ownership retains the original browser border box.
          const placement = operation.kind === 'raster' ? rasterPlacement(bounds) : bounds;
          // Convert top-left DOM coordinates to bottom-left PDF coordinates only here.
          const position = {
            x: (geometry.margin.left + placement.x * sourceScale) * PX_TO_PT,
            y:
              (geometry.height - area.y - (placement.y - start + placement.height) * sourceScale) *
              PX_TO_PT,
            width: placement.width * sourceScale * PX_TO_PT,
            height: placement.height * sourceScale * PX_TO_PT,
          };
          if (operation.kind === 'box') {
            // PDF strokes are centered; inset them to match the CSS outer border box.
            const background = parseColor(operation.background);
            // Border color remains explicit even when a fully transparent background is used.
            const border = parseColor(operation.borderColor);
            if (operation.roundedCorners) {
              // SVG path coordinates run down from this PDF top edge, preserving the CSS-pixel shape.
              const path = roundedRectanglePath(
                bounds.width,
                bounds.height,
                operation.roundedCorners,
              );
              page.drawSvgPath(path, {
                x: position.x,
                y: position.y + position.height,
                scale: sourceScale * PX_TO_PT,
                color: background.color,
                opacity: background.opacity,
              });
              if (operation.borderWidth > 0) {
                // An inset centerline places the border entirely inside the rounded outer edge.
                const inset = operation.borderWidth / 2;
                page.drawSvgPath(
                  roundedRectanglePath(
                    bounds.width - operation.borderWidth,
                    bounds.height - operation.borderWidth,
                    insetRoundedCorners(operation.roundedCorners, inset),
                  ),
                  {
                    x: position.x + inset * sourceScale * PX_TO_PT,
                    y: position.y + position.height - inset * sourceScale * PX_TO_PT,
                    scale: sourceScale * PX_TO_PT,
                    borderWidth: operation.borderWidth,
                    borderColor: border.color,
                    borderOpacity: border.opacity,
                  },
                );
              }
            } else {
              page.drawRectangle({
                ...position,
                color: background.color,
                opacity: background.opacity,
              });
              if (operation.borderWidth > 0) {
                // Native rectangular borders remain uniform solid strokes within the supported subset.
                const inset = (operation.borderWidth * sourceScale * PX_TO_PT) / 2;
                page.drawRectangle({
                  x: position.x + inset,
                  y: position.y + inset,
                  width: position.width - inset * 2,
                  height: position.height - inset * 2,
                  borderWidth: operation.borderWidth * sourceScale * PX_TO_PT,
                  borderColor: border.color,
                  borderOpacity: border.opacity,
                });
              }
            }
          } else if (operation.kind === 'border') {
            // Shared collapsed edges are already resolved and paint once as native filled rectangles.
            const color = parseColor(operation.color);
            page.drawRectangle({ ...position, color: color.color, opacity: color.opacity });
          } else {
            page.drawImage(images.get(operation)!, position);
          }
        }
        page.pushOperators(popGraphicsState());
      }
      const contentTop = geometry.margin.top + (options.header?.height ?? 0);
      const repeatedHeight =
        slice.headerHeight ?? (slice.header ? slice.header.bodyStart - slice.header.bounds.y : 0);
      // Stream order follows the visual reading order, including selectable repeated text.
      for (const line of pageLines[pageIndex]!.header) {
        drawLine(page, line, matchingFont(line, faces), 0, geometry, textResources);
      }
      if (embeddedHeader) {
        page.drawPage(embeddedHeader, {
          x: geometry.margin.left * PX_TO_PT,
          y: (geometry.height - geometry.margin.top - options.header!.height) * PX_TO_PT,
          width: (geometry.width - geometry.margin.left - geometry.margin.right) * PX_TO_PT,
          height: options.header!.height * PX_TO_PT,
        });
      }
      if (slice.header) {
        // Ancestor backgrounds are clipped to this table's width and cannot obscure source rows.
        paint(slice.header.operations, slice.header.bounds.y, {
          x: geometry.margin.left + slice.header.bounds.x * sourceScale,
          y: contentTop,
          width: slice.header.bounds.width * sourceScale,
          height: repeatedHeight * sourceScale,
        });
      }
      // The source interval moves down only on a table continuation page; its coordinates stay intact.
      paint(snapshot.operations, slice.start, {
        x: geometry.margin.left,
        y: contentTop + repeatedHeight * sourceScale,
        width: geometry.width - geometry.margin.left - geometry.margin.right,
        height: (slice.end - slice.start) * sourceScale,
      });
      for (const line of pageLines[pageIndex]!.footer) {
        drawLine(page, line, matchingFont(line, faces), 0, geometry, textResources);
      }
      if (embeddedFooter) {
        page.drawPage(embeddedFooter, {
          x: geometry.margin.left * PX_TO_PT,
          y: geometry.margin.bottom * PX_TO_PT,
          width: (geometry.width - geometry.margin.left - geometry.margin.right) * PX_TO_PT,
          height: options.footer!.height * PX_TO_PT,
        });
      }
      if (options.reportProgress)
        await options.reportProgress({
          stage: 'pages',
          completed: pageIndex + 1,
          total: slices.length,
        });
    }
    throwIfAborted(options.signal);
    if (options.reportProgress)
      await options.reportProgress({ stage: 'saving', completed: 0, total: 1 });
    for (const face of faces) {
      await face.positioned.embedUnicode(pdf);
      throwIfAborted(options.signal);
    }
    // A fresh ArrayBuffer-backed copy is accepted by browser Blob definitions.
    const bytes = Uint8Array.from(await pdf.save());
    throwIfAborted(options.signal);
    if (options.reportProgress)
      await options.reportProgress({ stage: 'saving', completed: 1, total: 1 });
    return { bytes, slices };
  } catch (error) {
    throwIfAborted(options.signal);
    if (error instanceof RenderPDFError) throw error;
    throw new RenderPDFError(
      'PDF_WRITE_FAILED',
      'The measured content could not be serialized as a PDF.',
      {
        cause: error,
      },
    );
  }
}
