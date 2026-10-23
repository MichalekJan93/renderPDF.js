import type { RenderPDFOptions, RenderPDFResult } from './api-types.js';
import { RenderPDFError, throwIfAborted, type RenderWarning } from './diagnostics.js';
import { collectPageBreaks } from './breaks.js';
import { validateRegisteredFonts } from './fonts.js';
import { snapshotLayout } from './layout.js';
import { resolvePage } from './page.js';
import { paginate } from './pagination.js';
import { writePDF } from './pdf.js';
import { prepareSource, withCancellation } from './prepare.js';
import { createResult } from './result.js';

/** Measure a stable browser element and export supported paint as selectable, paginated PDF. */
export async function renderDocument(
  /** Connected source in the current browser document; its width and markup stay caller-owned. */
  element: HTMLElement,
  /** Explicit fonts and the small supported page, raster and diagnostic options. */
  options: RenderPDFOptions,
  /** Research-only switch for comparing visible pixels without the invisible text layer. */
  includeRasterText = true,
) {
  // Validate and copy paper geometry before asynchronous work can observe caller changes.
  const page = resolvePage(options);
  // Fonts are immutable registration handles; copy the collection to stabilize face selection.
  const fonts = [...options.fonts];
  validateRegisteredFonts(fonts);
  // Preserve primitive options and callback identity throughout this export.
  const { signal, onWarning, rasterScale = 2, fallback = 'auto', pageBreak = 'css' } = options;
  // Observe the source synchronously so edits immediately after renderPDF() are detected.
  const source = prepareSource(element, signal);
  try {
    await source.ready();
    // Browser layout owns wrapping, Flexbox, Grid and table geometry.
    const snapshot = await withCancellation(snapshotLayout(element, fonts, { fallback }), signal);
    source.assertUnchanged();
    if (snapshot.width > page.width - page.margin.left - page.margin.right) {
      throw new RenderPDFError(
        'SOURCE_OVERFLOW',
        'Source is wider than the configured page content area. Set the source width explicitly; no implicit scaling is applied.',
      );
    }
    // CSS fragmentation preferences use the same measured coordinates as every paint operation.
    if (pageBreak === 'css') Object.assign(snapshot, collectPageBreaks(element, snapshot));
    // Page planning completes before callbacks so relaxed preferences are reported consistently.
    const paginationWarnings: RenderWarning[] = [];
    // Every text line, raster and table interval shares these exact page cuts with the writer.
    const slices = paginate(
      snapshot,
      page.height - page.margin.top - page.margin.bottom,
      (warning) => paginationWarnings.push(warning),
    );
    // Report approximation honestly even for documents without a local raster subtree.
    const warnings = [...snapshot.warnings, ...paginationWarnings];
    if (
      snapshot.operations.some((operation) => operation.kind === 'text') &&
      !warnings.some((warning) => warning.code === 'TEXT_METRICS_APPROXIMATED')
    ) {
      warnings.unshift({
        code: 'TEXT_METRICS_APPROXIMATED',
        message:
          'PDF text uses browser word origins and approximate baseline/kerning metrics; full glyph shaping fidelity is not guaranteed.',
      });
    }
    // Freeze callback records before application code can mutate them or the source.
    for (const warning of warnings) onWarning?.(Object.freeze(warning));
    if (onWarning) source.assertUnchanged();
    // Only the writer knows pdf-lib; geometry, source ownership and output API stay separate.
    const output = await withCancellation(
      writePDF(snapshot, fonts, page, slices, {
        rasterScale,
        includeRasterText,
        ...(signal ? { signal } : {}),
      }),
      signal,
    );
    source.assertUnchanged();
    validateRegisteredFonts(fonts);
    throwIfAborted(signal);
    return { ...output, snapshot, warnings };
  } finally {
    source.dispose();
  }
}

/** Export a stable browser element through the minimal public PDF API. */
export async function renderPDF(
  /** Connected source; browser layout and caller-owned markup remain unchanged. */
  element: HTMLElement,
  /** Explicit font programs and supported conversion options. */
  options: RenderPDFOptions,
): Promise<RenderPDFResult> {
  // The evidence runner and public API share exactly one preparation and rendering pipeline.
  const output = await renderDocument(element, options);
  return createResult(output.bytes, output.slices.length, output.warnings);
}
