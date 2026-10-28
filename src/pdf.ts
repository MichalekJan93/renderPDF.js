import fontkit from '@pdf-lib/fontkit';
import {
  PDFDocument,
  clip,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setCharacterSqueeze,
  setTextRenderingMode,
  TextRenderingMode,
} from 'pdf-lib';
import type { PDFFont, PDFImage, PDFPage } from 'pdf-lib';
import type { PageGeometry, RegisteredFont } from './api-types.js';
import { RenderPDFError, throwIfAborted } from './diagnostics.js';
import { nativeImageFormat } from './images.js';
import type { PageSlice } from './pagination.js';
import { captureRaster } from './raster.js';
import type { Bounds, LayoutSnapshot, TextOperation } from './types.js';

/** CSS reference pixels convert to PDF points only at this adapter boundary. */
const PX_TO_PT = 0.75;

/** Bounded writer settings independent of DOM layout measurement. */
export interface PDFWriteOptions {
  /** Physical pixels per CSS pixel for explicitly selected raster regions. */
  rasterScale?: number;
  /** Include extraction-only text inside a region already painted as a bitmap. */
  includeRasterText?: boolean;
  /** Omit a raster root's unsupported outer shadow without changing the source. */
  omitUnsupportedCss?: boolean;
  /** Stop before beginning subsequent asynchronous writing stages. */
  signal?: AbortSignal;
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
): PDFFont {
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
  return face.font;
}

/** Paint measured words at browser origins while retaining each word's ligatures. */
function drawLine(
  /** PDF page owning this complete measured line. */
  page: PDFPage,
  /** Browser line origins and baseline in source CSS pixels. */
  text: TextOperation,
  /** Matching embedded font program. */
  font: PDFFont,
  /** Inclusive source top of the current page, in CSS pixels. */
  start: number,
  /** Page edges and margins in CSS pixels. */
  geometry: PageGeometry,
): void {
  // Text rendering mode 3 preserves extraction without painting a second visible copy.
  const color = parseColor(text.color);
  for (const run of text.runs) {
    // pdf-lib discards fontkit positioning; shorter runs limit accumulated advance drift.
    const nativeWidth = font.widthOfTextAtSize(run.text, text.fontSize);
    // shortcut: word-width fitting approximates kerning until positioned glyphs are supported.
    const squeeze = nativeWidth > 0 ? (run.width / nativeWidth) * 100 : 100;
    page.pushOperators(
      pushGraphicsState(),
      setCharacterSqueeze(squeeze),
      setTextRenderingMode(text.invisible ? TextRenderingMode.Invisible : TextRenderingMode.Fill),
    );
    page.drawText(run.text, {
      font,
      size: text.fontSize * PX_TO_PT,
      x: (geometry.margin.left + run.x) * PX_TO_PT,
      y: (geometry.height - geometry.margin.top - (text.baseline - start)) * PX_TO_PT,
      color: color.color,
      opacity: color.opacity,
    });
    page.pushOperators(popGraphicsState());
  }
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
    if (nativeImageFormat(bytes) === 'png') {
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
    if (snapshot.width > geometry.width - geometry.margin.left - geometry.margin.right) {
      throw new RenderPDFError('SOURCE_OVERFLOW', 'Source is wider than the PDF content area.');
    }
    // The PDF dependency stays behind this adapter and receives only explicit font programs.
    const pdf = await PDFDocument.create();
    throwIfAborted(options.signal);
    pdf.registerFontkit(fontkit);
    pdf.setTitle('RenderPDF.js');
    // Full embedding avoids subset/ligature mapping complications without using private APIs.
    const faces: EmbeddedFace[] = [];
    for (const definition of fonts) {
      throwIfAborted(options.signal);
      // Cache coverage once per embedded face rather than rebuilding it for every line.
      const font = await pdf.embedFont(definition.bytes);
      faces.push({ definition, font, characters: new Set(font.getCharacterSet()) });
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
    // Raster resources are captured exactly once per operation before ordered composition.
    const images = new Map<object, PDFImage>();
    // Repeated native image references share one embedded resource within the export.
    const nativeImages = new Map<string, PDFImage>();
    for (const operation of snapshot.operations) {
      throwIfAborted(options.signal);
      if (operation.kind === 'raster') {
        // Paint fractional origins inside the bitmap, avoiding another PDF image shift.
        const aligned = rasterPlacement(operation.bounds);
        try {
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
    }
    for (const slice of slices) {
      throwIfAborted(options.signal);
      // Clip every primitive to the same source interval; tall backgrounds may span pages.
      const page = pdf.addPage([geometry.width * PX_TO_PT, geometry.height * PX_TO_PT]);
      page.pushOperators(
        pushGraphicsState(),
        rectangle(
          geometry.margin.left * PX_TO_PT,
          (geometry.height - geometry.margin.top - (slice.end - slice.start)) * PX_TO_PT,
          (geometry.width - geometry.margin.left - geometry.margin.right) * PX_TO_PT,
          (slice.end - slice.start) * PX_TO_PT,
        ),
        clip(),
        endPath(),
      );
      for (const operation of snapshot.operations) {
        // Skip off-page text entirely; clipping alone would leave duplicate extraction items.
        const bounds = operation.bounds;
        if (bounds.y >= slice.end - 0.01 || bounds.y + bounds.height <= slice.start + 0.01)
          continue;
        if (operation.kind === 'text') {
          if (!operation.invisible || options.includeRasterText !== false) {
            drawLine(page, operation, matchingFont(operation, faces), slice.start, geometry);
          }
          continue;
        }
        // Padding is transparent; page ownership retains the original browser border box.
        const placement = operation.kind === 'raster' ? rasterPlacement(bounds) : bounds;
        // Convert top-left DOM coordinates to bottom-left PDF coordinates only here.
        const position = {
          x: (geometry.margin.left + placement.x) * PX_TO_PT,
          y:
            (geometry.height -
              geometry.margin.top -
              (placement.y - slice.start) -
              placement.height) *
            PX_TO_PT,
          width: placement.width * PX_TO_PT,
          height: placement.height * PX_TO_PT,
        };
        if (operation.kind === 'box') {
          // PDF strokes are centered; inset them to match the CSS outer border box.
          const background = parseColor(operation.background);
          // Border color remains explicit even when a fully transparent background is used.
          const border = parseColor(operation.borderColor);
          page.drawRectangle({ ...position, color: background.color, opacity: background.opacity });
          if (operation.borderWidth > 0) {
            // Native borders remain uniform solid strokes within the supported subset.
            const inset = (operation.borderWidth * PX_TO_PT) / 2;
            page.drawRectangle({
              x: position.x + inset,
              y: position.y + inset,
              width: position.width - inset * 2,
              height: position.height - inset * 2,
              borderWidth: operation.borderWidth * PX_TO_PT,
              borderColor: border.color,
              borderOpacity: border.opacity,
            });
          }
        } else {
          page.drawImage(images.get(operation)!, position);
        }
      }
      page.pushOperators(popGraphicsState());
    }
    throwIfAborted(options.signal);
    // A fresh ArrayBuffer-backed copy is accepted by browser Blob definitions.
    const bytes = Uint8Array.from(await pdf.save());
    throwIfAborted(options.signal);
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
