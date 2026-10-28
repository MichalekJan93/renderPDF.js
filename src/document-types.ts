import type { PDFFont, PDFDocument } from 'pdf-lib';
import type { FontSource, PDFMetadata, ImageSource } from './api-types.js';

/** Coordinate unit; font sizes always use typographic points. */
export type DocumentUnit = 'pt' | 'mm' | 'px';

/** Physical page dimensions in the document's chosen coordinate unit. */
export interface DocumentPageOptions {
  /** Named paper or explicit width and height, including page edges. */
  format?: 'A4' | 'A3' | 'Letter' | { width: number; height: number };
  /** Landscape swaps the supplied base dimensions. */
  orientation?: 'portrait' | 'landscape';
}

/** Prepare a document independently of browser layout and the DOM. */
export interface PDFDocumentOptions extends DocumentPageOptions {
  /** Coordinate unit, defaulting to points. */
  unit?: DocumentUnit;
  /** Static fonts embedded before synchronous drawing and measurement begin. */
  fonts?: readonly FontSource[];
  /** PDF document properties. */
  metadata?: PDFMetadata;
  /** Cooperative cancellation during resource preparation and serialization. */
  signal?: AbortSignal;
}

/** Exact font face; all built-in families have regular, bold and italic variants. */
export interface DocumentFontOptions {
  /** Registered family, defaulting to Helvetica. */
  font?: string;
  /** Static weight, defaulting to 400. */
  fontWeight?: number;
  /** Static face style, defaulting to normal. */
  fontStyle?: 'normal' | 'italic';
}

/** Text metrics use the document's coordinate unit. */
export interface DocumentTextMetrics {
  /** Largest line width. */
  width: number;
  /** Total line advance, including line spacing. */
  height: number;
  /** Distance from the baseline to the top of the font. */
  ascent: number;
  /** Positive distance below the baseline. */
  descent: number;
}

/** Axis-aligned rectangle measured from the page's top-left corner. */
export interface DocumentRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Vector paint settings; colors use CSS color strings. */
export interface DocumentShapeOptions {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
}

/** Text position uses a baseline measured down from the top edge. */
export interface DocumentTextOptions extends DocumentFontOptions {
  x: number;
  y: number;
  /** Font size in points, independent of coordinate units. */
  fontSize?: number;
  color?: string;
  align?: 'left' | 'center' | 'right';
  /** Baseline advance as a multiple of fontSize, defaulting to 1.15. */
  lineHeight?: number;
  rotation?: number;
  maxWidth?: number;
  opacity?: number;
  link?: string;
}

/** One line segment in top-left page coordinates. */
export interface DocumentLineOptions {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color?: string;
  width?: number;
  opacity?: number;
}

/** Native bitmap bytes, a data URL, or an existing browser image/canvas. */
export type DocumentImageSource = ImageSource | string | HTMLCanvasElement | HTMLImageElement;

/** Explicit image placement; dimensions use document units. */
export interface DocumentImageOptions extends DocumentRectangle {
  rotation?: number;
  opacity?: number;
}

/** Common interactive field appearance and validation settings. */
export interface DocumentFieldOptions extends DocumentFontOptions {
  fontSize?: number;
  textColor?: string;
  borderColor?: string;
  backgroundColor?: string;
  borderWidth?: number;
  readOnly?: boolean;
  required?: boolean;
}

/** Text field content and display behavior. */
export interface DocumentTextFieldOptions extends DocumentFieldOptions {
  value?: string;
  multiline?: boolean;
  maxLength?: number;
}

/** Checkbox initial state. */
export interface DocumentCheckBoxOptions extends DocumentFieldOptions {
  checked?: boolean;
}

/** Dropdown selection and editability. */
export interface DocumentDropdownOptions extends DocumentFieldOptions {
  value?: string | readonly string[];
  editable?: boolean;
  multiselect?: boolean;
}

/** Internal page services; the public page API does not expose backend objects. */
export interface DocumentPageContext {
  readonly pdf: PDFDocument;
  readonly scale: number;
  resolveFont(options?: DocumentFontOptions): PDFFont;
  assertActive(): void;
}

/** Page destinations are one-based and belong to the current document. */
export interface DocumentBookmarkOptions {
  pageNumber: number;
  /** Optional parent returned by addBookmark. */
  parent?: DocumentBookmark;
}

/** Opaque destination handle used to build a bookmark hierarchy. */
export interface DocumentBookmark {
  readonly title: string;
  readonly pageNumber: number;
}
