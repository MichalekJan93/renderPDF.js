import type { RenderPDFOptions, RenderPDFResult } from './api-types.js';
import { RenderPDFError, throwIfAborted, type RenderWarning } from './diagnostics.js';
import { collectPageBreaks } from './breaks.js';
import { resolveMetadata } from './export-options.js';
import { validateRegisteredFonts } from './fonts.js';
import { measurePreparedLayout } from './layout.js';
import { resolvePage } from './page.js';
import { resolvePageBands } from './page-bands.js';
import { paginate } from './pagination.js';
import { writePDF } from './pdf.js';
import { prepareSource, withCancellation } from './prepare.js';
import { createProgressReporter } from './progress.js';
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
  const bands = resolvePageBands(page, options);
  const metadata = resolveMetadata(options.metadata);
  // Fonts are immutable registration handles; copy the collection to stabilize face selection.
  const fonts = [...options.fonts];
  validateRegisteredFonts(fonts);
  // Preserve primitive options and callback identity throughout this export.
  const {
    signal,
    onWarning,
    onProgress,
    rasterScale = 2,
    fallback = 'auto',
    pageBreak = 'css',
    repeatTableHeaders = false,
  } = options;
  // Observe the source synchronously so edits immediately after renderPDF() are detected.
  const source = prepareSource(element, signal);
  const progress = createProgressReporter(onProgress, signal);
  const reportProgress = progress.report;
  try {
    if (reportProgress) await reportProgress({ stage: 'preparing', completed: 0, total: 1 });
    await source.ready();
    // A progress listener may change CSSOM without a DOM mutation; own the settled state before notifying it.
    if (reportProgress) source.captureBaseline();
    if (reportProgress) await reportProgress({ stage: 'preparing', completed: 1, total: 1 });
    if (reportProgress) await reportProgress({ stage: 'layout', completed: 0, total: 1 });
    // Reject edits queued after readiness before beginning synchronous browser measurement.
    source.assertUnchanged();
    // No await separates geometry measurement from its baseline; a second full style scan is redundant.
    const snapshot = measurePreparedLayout(element, fonts, { fallback, repeatTableHeaders });
    // With progress enabled, the settled baseline was already captured before its layout callbacks.
    if (!reportProgress) source.captureBaseline();
    if (reportProgress) await reportProgress({ stage: 'layout', completed: 1, total: 1 });
    if (reportProgress) await reportProgress({ stage: 'pagination', completed: 0, total: 1 });
    if (reportProgress) source.assertUnchanged();
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
      bands.content.height - bands.content.margin.top - bands.content.margin.bottom,
      (warning) => paginationWarnings.push(warning),
    );
    if (reportProgress) await reportProgress({ stage: 'pagination', completed: 1, total: 1 });
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
    if (onWarning || reportProgress) source.assertUnchanged();
    // Only the writer knows pdf-lib; geometry, source ownership and output API stay separate.
    const output = await withCancellation(
      writePDF(snapshot, fonts, page, slices, {
        rasterScale,
        includeRasterText,
        ...(bands.header ? { header: bands.header } : {}),
        ...(bands.footer ? { footer: bands.footer } : {}),
        ...(metadata ? { metadata } : {}),
        ...(reportProgress ? { reportProgress } : {}),
        ...(signal ? { signal } : {}),
      }),
      signal,
    );
    source.assertUnchanged();
    validateRegisteredFonts(fonts);
    throwIfAborted(signal);
    if (reportProgress) {
      await reportProgress({ stage: 'complete', completed: 1, total: 1 });
      // Completion listeners remain application code and must not invalidate the verified source.
      source.assertUnchanged();
      validateRegisteredFonts(fonts);
    }
    return { ...output, snapshot, warnings };
  } catch (error) {
    return progress.rethrow(error);
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
