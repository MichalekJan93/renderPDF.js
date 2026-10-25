import type { RenderWarning } from './diagnostics.js';

/** A rectangle relative to the source root, measured in CSS pixels. */
export interface Bounds {
  /** Horizontal distance from the root's left edge. */
  x: number;
  /** Vertical distance from the root's top edge. */
  y: number;
  /** Browser-measured width. */
  width: number;
  /** Browser-measured height. */
  height: number;
}

/** A browser-measured line of selectable text. */
export interface TextOperation {
  /** Discriminant for ordered paint dispatch. */
  kind: 'text';
  /** Line fragment bounds in root CSS pixels. */
  bounds: Bounds;
  /** Browser-resolved visible text for this line. */
  text: string;
  /** Browser-measured words retain native origins without accumulating run-width drift. */
  runs: {
    /** Word text, retaining ligatures and non-breaking spaces within each run. */
    text: string;
    /** Horizontal word origin relative to the source root, in CSS pixels. */
    x: number;
    /** Browser-measured word advance width in CSS pixels. */
    width: number;
  }[];
  /** Baseline position relative to the root's top edge. */
  baseline: number;
  /** CSS font size in pixels. */
  fontSize: number;
  /** Exact registered family selected by the browser-facing font contract. */
  family: string;
  /** Registered face weight. */
  weight: number;
  /** Registered face style. */
  style: 'normal' | 'italic';
  /** Disable OpenType kerning when the browser explicitly selects font-kerning: none. */
  kerning?: boolean;
  /** Computed CSS rgb/rgba text color. */
  color: string;
  /** True for extraction-only text inside a raster subtree. */
  invisible: boolean;
}

/** A supported axis-aligned box painted by native PDF operations. */
export interface BoxOperation {
  /** Discriminant for ordered paint dispatch. */
  kind: 'box';
  /** Border-box geometry in root CSS pixels. */
  bounds: Bounds;
  /** Computed solid background. */
  background: string;
  /** Uniform border color. */
  borderColor: string;
  /** Uniform border width in CSS pixels. */
  borderWidth: number;
}

/** An explicitly isolated DOM subtree captured at its paint-order position. */
export interface RasterOperation {
  /** Discriminant for ordered paint dispatch. */
  kind: 'raster';
  /** Region in root CSS pixels; effects must stay within this box. */
  bounds: Bounds;
  /** Live source used only by the browser capture adapter. */
  element: HTMLElement;
}

/** An image source embedded once as a PDF image object. */
export interface ImageOperation {
  /** Discriminant for ordered paint dispatch. */
  kind: 'image';
  /** Browser-measured image border box. */
  bounds: Bounds;
  /** Decoded image source; experiment fixtures use self-contained PNGs. */
  element: HTMLImageElement;
}

/** A flattened, ordered experiment display list, not a general CSS paint tree. */
export type PaintOperation = TextOperation | BoxOperation | RasterOperation | ImageOperation;

/** Immutable geometry metadata plus a bounded list of ordered paint operations. */
export interface LayoutSnapshot {
  /** Measured root width in CSS pixels. */
  width: number;
  /** Measured root height in CSS pixels. */
  height: number;
  /** Operations in the supported static DOM paint order. */
  operations: PaintOperation[];
  /** Explicitly diagnosed approximations and unsupported behavior. */
  warnings: RenderWarning[];
  /** Indivisible browser-measured table rows and spanning cells, in root CSS pixels. */
  atomicBounds?: Bounds[];
  /** Forced CSS page boundaries in source coordinates; zero/end boundaries create no empty pages. */
  forcedBreaks?: number[];
  /** Preferred indivisible blocks; oversized preferences may relax with an explicit warning. */
  avoidBreakBounds?: Bounds[];
}
