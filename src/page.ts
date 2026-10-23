import type { PageGeometry, RenderPDFOptions } from './api-types.js';
import { RenderPDFError } from './diagnostics.js';

/** Resolve physical paper dimensions and validate the small public option surface. */
export function resolvePage(
  /** Caller-owned options; resolving them never changes their values. */
  options: RenderPDFOptions,
): PageGeometry {
  if (!options || !Array.isArray(options.fonts) || options.fonts.length === 0) {
    throw new RenderPDFError('INVALID_OPTIONS', 'Provide at least one explicitly registered font.');
  }
  // Standard portrait dimensions in PDF points; the internal pipeline uses CSS pixels.
  const formats = { A4: [595.28, 841.89], A3: [841.89, 1190.55], Letter: [612, 792] } as const;
  // Reject unknown runtime values even when a JavaScript caller bypasses the TypeScript union.
  const format = options.format ?? 'A4';
  if (typeof format !== 'object' && !Object.hasOwn(formats, format)) {
    throw new RenderPDFError('INVALID_OPTIONS', `Unsupported page format: ${format}.`);
  }
  // Orientation changes the paper, never the measured source width or text wrapping.
  const orientation = options.orientation ?? 'portrait';
  if (orientation !== 'portrait' && orientation !== 'landscape') {
    // oxlint-disable-next-line typescript/restrict-template-expressions -- JavaScript callers can bypass the typed union.
    throw new RenderPDFError('INVALID_OPTIONS', `Unsupported page orientation: ${orientation}.`);
  }
  // Each edge is copied so later caller mutations cannot change an in-progress export.
  const margin = options.margin ?? 24;
  // A shorthand applies identical CSS-pixel spacing to all four edges.
  const edges =
    typeof margin === 'number'
      ? { top: margin, right: margin, bottom: margin, left: margin }
      : { top: margin?.top, right: margin?.right, bottom: margin?.bottom, left: margin?.left };
  if (Object.values(edges).some((edge) => !Number.isFinite(edge) || edge < 0)) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'Every page margin must be finite and nonnegative.',
    );
  }
  // Standard paper inputs use points; caller-supplied custom dimensions already use CSS pixels.
  const dimensions =
    typeof format === 'object'
      ? [format?.width, format?.height]
      : formats[format].map((points) => points / 0.75);
  if (dimensions.some((dimension) => !Number.isFinite(dimension) || dimension <= 0)) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'Custom page width and height must be finite positive CSS pixel values.',
    );
  }
  // Landscape swaps only the physical paper axes.
  const width = dimensions[orientation === 'portrait' ? 0 : 1]!;
  // Margins reduce available source height without changing browser geometry.
  const height = dimensions[orientation === 'portrait' ? 1 : 0]!;
  if (edges.left + edges.right >= width || edges.top + edges.bottom >= height) {
    throw new RenderPDFError('INVALID_OPTIONS', 'Page margins leave no positive content area.');
  }
  if (
    options.rasterScale !== undefined &&
    (!Number.isFinite(options.rasterScale) || options.rasterScale <= 0)
  ) {
    throw new RenderPDFError('INVALID_OPTIONS', 'Raster scale must be a finite positive number.');
  }
  if (options.onWarning !== undefined && typeof options.onWarning !== 'function') {
    throw new RenderPDFError('INVALID_OPTIONS', 'onWarning must be a function.');
  }
  if (options.fallback !== undefined && !['auto', 'strict'].includes(options.fallback)) {
    throw new RenderPDFError('INVALID_OPTIONS', 'fallback must be auto or strict.');
  }
  if (options.pageBreak !== undefined && !['auto', 'css'].includes(options.pageBreak)) {
    throw new RenderPDFError('INVALID_OPTIONS', 'pageBreak must be auto or css.');
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new RenderPDFError('INVALID_OPTIONS', 'signal must be an AbortSignal.');
  }
  return { width, height, margin: edges };
}
