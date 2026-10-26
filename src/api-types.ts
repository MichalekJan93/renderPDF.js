import type { RenderWarning } from './diagnostics.js';

/** One explicit static font program registered for browser layout and PDF embedding. */
export interface RegisteredFont {
  /** CSS family name; provide the same family in the source element's styles. */
  readonly family: string;
  /** Explicit CSS weight of this static face, without browser-synthesized styling. */
  readonly weight: number;
  /** Supported face style. */
  readonly style: 'normal' | 'italic';
  /** Exact font bytes; registration owns its program rather than extracting system fonts. */
  readonly bytes: Uint8Array;
}

/** Input for explicit font registration; bytes are supplied by the application. */
export interface FontSource {
  /** CSS family to register in the current document. */
  family: string;
  /** Complete TTF/OTF program available to the browser and PDF adapter. */
  data: Uint8Array | ArrayBuffer;
  /** Static face weight, defaulting to 400. */
  weight?: number;
  /** Static face style, defaulting to normal. */
  style?: 'normal' | 'italic';
}

/** Physical page and source-to-page margins in CSS reference pixels. */
export interface PageGeometry {
  /** Page width in CSS reference pixels (1px = 0.75pt). */
  width: number;
  /** Page height in CSS reference pixels. */
  height: number;
  /** Empty page edges in CSS pixels. */
  margin: PageMargins;
}

/** Per-edge empty page space, measured in CSS pixels. */
export interface PageMargins {
  /** Top empty edge. */
  top: number;
  /** Right empty edge. */
  right: number;
  /** Bottom empty edge. */
  bottom: number;
  /** Left empty edge. */
  left: number;
}

/** Explicit physical paper dimensions in the shared CSS reference pixel units. */
export interface CustomPageSize {
  /** Base paper width in CSS pixels; landscape orientation swaps the supplied axes. */
  width: number;
  /** Base paper height in CSS pixels, including margins. */
  height: number;
}

/** One selectable line repeated in a reserved area above or below each page's content. */
export interface PageTextOptions {
  /** Plain Latin text; {pageNumber} and {pageCount} expand after pagination. */
  text: string;
  /** Reserved height in CSS pixels, in addition to the page's outer margins. */
  height: number;
  /** Exact face included in fonts; defaults to its first registered face. */
  font?: RegisteredFont;
  /** Text size in CSS pixels, defaulting to 12. */
  fontSize?: number;
  /** Horizontal alignment within the page's content width, defaulting to left. */
  align?: 'left' | 'center' | 'right';
}

/** Document properties stored in the PDF, independent of visible page content. */
export interface PDFMetadata {
  /** Human-readable document title; defaults to RenderPDF.js when omitted. */
  title?: string;
  /** Author displayed in PDF document properties. */
  author?: string;
  /** Short description of the document's subject. */
  subject?: string;
  /** Search keywords copied before export begins. */
  keywords?: readonly string[];
}

/** Observable export stages; counters describe work within one stage, never elapsed-time estimates. */
export type RenderStage =
  | 'preparing'
  | 'layout'
  | 'pagination'
  | 'resources'
  | 'pages'
  | 'saving'
  | 'complete';

/** Immutable progress notification delivered synchronously to the application's callback. */
export interface RenderProgress {
  /** Current stage, in pipeline order. */
  readonly stage: RenderStage;
  /** Finished work units within the current stage. */
  readonly completed: number;
  /** Known work units in this stage; page totals are available after pagination. */
  readonly total: number;
}

/** Shared physical paper settings for HTML and standalone image conversion. */
export interface PDFPageOptions {
  /** Standard page size (default A4) or explicit physical dimensions in CSS pixels. */
  format?: 'A4' | 'A3' | 'Letter' | CustomPageSize;
  /** Page orientation, defaulting to portrait. */
  orientation?: 'portrait' | 'landscape';
  /** CSS-pixel margins, defaulting to 24 on every edge; content is never implicitly rescaled. */
  margin?: number | PageMargins;
}

/** Small supported API surface; unsupported layout fails explicitly. */
export interface RenderPDFOptions extends PDFPageOptions {
  /** Explicit registered faces used by the supplied source; no implicit font substitution. */
  fonts: readonly RegisteredFont[];
  /** Physical pixels per CSS pixel in selected local raster regions, defaulting to 2. */
  rasterScale?: number;
  /** Automatically rasterize safe local effects (default auto); strict requires explicit data-raster. */
  fallback?: 'auto' | 'strict';
  /** Honor supported CSS page breaks (default css), or use geometry-only automatic cuts. */
  pageBreak?: 'auto' | 'css';
  /** Repeat native THEAD groups on table continuation pages; defaults to false. */
  repeatTableHeaders?: boolean;
  /** Plain text vertically centered in a reserved area above the source on every page. */
  header?: PageTextOptions;
  /** Plain text vertically centered in a reserved area below the source on every page. */
  footer?: PageTextOptions;
  /** Unicode document properties; all supplied values are copied before asynchronous preparation. */
  metadata?: PDFMetadata;
  /** Stop preparation and subsequent rendering stages without producing a partial PDF. */
  signal?: AbortSignal;
  /** Observe documented approximations, raster choices and relaxed pagination preferences. */
  onWarning?: (warning: RenderWarning) => void;
  /** Observe stage-local work counts; the renderer yields for browser updates when provided. */
  onProgress?: (progress: RenderProgress) => void;
}

/** One caller-owned image file or its complete binary bytes; the signature determines its format. */
export type ImageSource = Blob | ArrayBuffer | Uint8Array;

/** Convert one PNG/JPEG or all main image frames of a TIFF, without HTML or font registration. */
export interface ImagePDFOptions extends PDFPageOptions {
  /** Copied Unicode PDF properties. */
  metadata?: PDFMetadata;
  /** Cancel between input reading, frame decoding, image embedding and page writing stages. */
  signal?: AbortSignal;
  /** Frozen stage-local counters; image conversion omits HTML layout/pagination stages. */
  onProgress?: (progress: RenderProgress) => void;
}

/** Complete PDF result with independently usable browser output forms. */
export interface RenderPDFResult {
  /** Number of generated pages. */
  readonly pageCount: number;
  /** Frozen diagnostics for this export; there is no production console logging. */
  readonly warnings: readonly RenderWarning[];
  /** Return a fresh byte copy so callers cannot corrupt future downloads. */
  toUint8Array(): Promise<Uint8Array>;
  /** Return a browser PDF Blob without triggering a download. */
  toBlob(): Promise<Blob>;
  /** Download the completed PDF without invoking a print dialog. */
  download(filename?: string): Promise<void>;
}
