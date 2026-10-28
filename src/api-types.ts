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

/** Small supported API surface; unsupported layout fails explicitly. */
export interface RenderPDFOptions {
  /** Explicit registered faces used by the supplied source; no implicit font substitution. */
  fonts: readonly RegisteredFont[];
  /** Standard page size (default A4) or explicit physical dimensions in CSS pixels. */
  format?: 'A4' | 'A3' | 'Letter' | CustomPageSize;
  /** Page orientation, defaulting to portrait. */
  orientation?: 'portrait' | 'landscape';
  /** CSS-pixel margins, defaulting to 24 on every edge; content is never implicitly rescaled. */
  margin?: number | PageMargins;
  /** Physical pixels per CSS pixel in selected local raster regions, defaulting to 2. */
  rasterScale?: number;
  /** Automatically rasterize safe local effects (default auto); strict requires explicit data-raster. */
  fallback?: 'auto' | 'strict';
  /** Reject unsupported decorative CSS instead of omitting it; defaults to false. */
  strictCss?: boolean;
  /** Honor supported CSS page breaks (default css), or use geometry-only automatic cuts. */
  pageBreak?: 'auto' | 'css';
  /** Stop preparation and subsequent rendering stages without producing a partial PDF. */
  signal?: AbortSignal;
  /** Observe documented approximations, raster choices and relaxed pagination preferences. */
  onWarning?: (warning: RenderWarning) => void;
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
