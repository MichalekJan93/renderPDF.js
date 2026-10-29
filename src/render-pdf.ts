import type {
  PageGeometry,
  RegisteredFont,
  RenderPDFOptions,
  RenderPDFResult,
} from './api-types.js';
import { RenderPDFError, throwIfAborted, type RenderWarning } from './diagnostics.js';
import { collectPageBreaks } from './breaks.js';
import { resolveMetadata } from './export-options.js';
import { registerFont, validateRegisteredFonts } from './fonts.js';
import { measurePreparedLayout } from './layout.js';
import { resolvePage } from './page.js';
import { resolvePageBands, type PageBand, type PreparedPageBand } from './page-bands.js';
import { paginate } from './pagination.js';
import { writePDF } from './pdf.js';
import { prepareSource, withCancellation } from './prepare.js';
import { createProgressReporter } from './progress.js';
import { createResult } from './result.js';

/** Render connected page decoration once as a selectable single-page PDF form. */
async function preparePageBand(
  /** Validated legacy text, independent slots, or browser HTML. */
  band: PageBand | undefined,
  /** Main source whose document and subtree must remain distinct from the band. */
  sourceElement: HTMLElement,
  /** Exact browser/PDF faces shared by both HTML sources. */
  fonts: readonly RegisteredFont[],
  /** Final chosen physical page size, including orientation. */
  page: PageGeometry,
  /** Stable rendering settings copied before asynchronous source preparation. */
  options: {
    /** Captured raster policy for this export. */
    fallback: 'auto' | 'strict';
    /** Reject unsupported decoration consistently in the source and HTML page bands. */
    strictCss: boolean;
    /** Physical pixels per browser CSS pixel. */
    rasterScale: number;
    /** Source guard policy also used by the decoration. */
    verifySource: 'full' | 'mutations';
    /** Reject unavailable faces or paint them with a diagnosed base face. */
    fontMismatch: 'error' | 'fallback';
    /** Registered family selected for substitution when requested. */
    fontFallback: string | undefined;
    /** Parent cancellation signal, including an absent signal. */
    signal: AbortSignal | undefined;
  },
  /** Preserve the caller's research-only raster extraction policy. */
  includeRasterText: boolean,
): Promise<{ band?: PreparedPageBand; warnings: readonly RenderWarning[] }> {
  if (!band || !('kind' in band) || band.kind !== 'html') {
    return { ...(band ? { band } : {}), warnings: [] };
  }
  if (
    band.element.ownerDocument !== sourceElement.ownerDocument ||
    sourceElement.contains(band.element) ||
    band.element.contains(sourceElement)
  ) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'HTML page header/footer must be connected outside the source in its browser document.',
    );
  }
  const printableWidth = page.width - page.margin.left - page.margin.right;
  const output = await renderDocument(
    band.element,
    {
      fonts,
      format: { width: printableWidth, height: band.height },
      margin: 0,
      orientation: 'portrait',
      fit: 'none',
      pageBreak: 'auto',
      strictCss: options.strictCss,
      ...(options.fallback ? { fallback: options.fallback } : {}),
      ...(options.rasterScale ? { rasterScale: options.rasterScale } : {}),
      ...(options.verifySource ? { verifySource: options.verifySource } : {}),
      fontMismatch: options.fontMismatch,
      ...(options.fontFallback ? { fontFallback: options.fontFallback } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    },
    includeRasterText,
  );
  if (output.slices.length !== 1) {
    throw new RenderPDFError(
      'SOURCE_OVERFLOW',
      'HTML page header/footer exceeds its reserved height.',
    );
  }
  return {
    band: { kind: 'html', height: band.height, bytes: output.bytes },
    warnings: output.warnings,
  };
}

/** Measure a stable browser element and export supported paint as selectable, paginated PDF. */
export async function renderDocument(
  /** Connected source whose browser layout and markup stay caller-owned. */
  element: HTMLElement,
  /** Explicit fonts and the small supported page, raster and diagnostic options. */
  options: RenderPDFOptions = {},
  /** Research-only switch for comparing visible pixels without the invisible text layer. */
  includeRasterText = true,
) {
  // Validate and copy paper geometry before asynchronous work can observe caller changes.
  let page = resolvePage(options);
  const metadata = resolveMetadata(options.metadata);
  // Fonts are immutable registration handles; copy the collection to stabilize face selection.
  const suppliedFonts = [...(options.fonts ?? [])];
  validateRegisteredFonts(suppliedFonts, element.ownerDocument);
  // Capture caller-owned band fields before lazy font loading can yield to application code.
  const requestedHeader =
    options.header && typeof options.header === 'object' ? { ...options.header } : options.header;
  const requestedFooter =
    options.footer && typeof options.footer === 'object' ? { ...options.footer } : options.footer;
  // Preserve primitive options and callback identity throughout this export.
  const {
    signal,
    onWarning,
    onProgress,
    rasterScale = 2,
    fallback = 'auto',
    strictCss = false,
    pageBreak = 'css',
    repeatTableHeaders = false,
    orientation = 'portrait',
    fit = 'none',
    verifySource = 'full',
    fontFallback: requestedFontFallback,
  } = options;
  // Existing explicit-font calls keep strict behavior; no-font calls use a diagnosed base face.
  const fontMismatch =
    options.fontMismatch ??
    (suppliedFonts.length === 0 || requestedFontFallback !== undefined ? 'fallback' : 'error');
  if (typeof strictCss !== 'boolean') {
    throw new RenderPDFError('INVALID_OPTIONS', 'strictCss must be a boolean.');
  }
  // Observe the source synchronously so edits immediately after renderPDF() are detected.
  const source = prepareSource(element, signal, verifySource);
  // Live HTML decorations need the same ownership window as the main source.
  const bandSources: ReturnType<typeof prepareSource>[] = [];
  /** Reject changes to any measured source before composing its PDF paint. */
  function assertSourcesUnchanged(): void {
    source.assertUnchanged();
    for (const bandSource of bandSources) bandSource.assertUnchanged();
  }
  const progress = createProgressReporter(onProgress, signal);
  const reportProgress = progress.report;
  try {
    for (const band of [requestedHeader, requestedFooter]) {
      if (!band || !('element' in band)) continue;
      if (
        band.element.ownerDocument !== element.ownerDocument ||
        element.contains(band.element) ||
        band.element.contains(element)
      ) {
        throw new RenderPDFError(
          'INVALID_OPTIONS',
          'HTML page header/footer must be connected outside the source in its browser document.',
        );
      }
      bandSources.push(prepareSource(band.element, signal, verifySource));
    }
    if (reportProgress) await reportProgress({ stage: 'preparing', completed: 0, total: 1 });
    // A lazy chunk keeps the bundled programs out of exact-font consumers' initial download.
    const fonts = [...suppliedFonts];
    let fallbackFamily = fontMismatch === 'fallback' ? requestedFontFallback : undefined;
    if (fonts.length === 0 || (fontMismatch === 'fallback' && !fallbackFamily)) {
      const base = await import('./base-font.js');
      fonts.push(
        ...(await base.loadBaseFonts(
          element.ownerDocument,
          registerFont,
          () => new RenderPDFError('FONT_LOAD_FAILED', 'Bundled base font could not be loaded.'),
        )),
      );
      if (fontMismatch === 'fallback') fallbackFamily = base.BASE_FONT_FAMILY;
    }
    validateRegisteredFonts(fonts, element.ownerDocument);
    if (
      fallbackFamily &&
      !fonts.some((font) => font.family.toLowerCase() === fallbackFamily.toLowerCase())
    ) {
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        `fontFallback requires a registered family: ${fallbackFamily}.`,
      );
    }
    // Resolve the original band values, even if the caller changed its options while fonts loaded.
    const bandOptions: RenderPDFOptions = { ...options, fonts };
    delete bandOptions.header;
    delete bandOptions.footer;
    if (requestedHeader !== undefined) bandOptions.header = requestedHeader;
    if (requestedFooter !== undefined) bandOptions.footer = requestedFooter;
    let bands = resolvePageBands(page, bandOptions);
    await source.ready();
    // A band may wait for its own images or fonts; own the main CSS state across that yield.
    if (reportProgress || bandSources.length) source.captureBaseline();
    if (bandSources.length) await Promise.all(bandSources.map((bandSource) => bandSource.ready()));
    for (const bandSource of bandSources) bandSource.captureBaseline();
    // A progress listener may change CSSOM without a DOM mutation; own the settled state before notifying it.
    if (reportProgress) await reportProgress({ stage: 'preparing', completed: 1, total: 1 });
    if (reportProgress) await reportProgress({ stage: 'layout', completed: 0, total: 1 });
    // Reject edits queued after readiness before beginning synchronous browser measurement.
    assertSourcesUnchanged();
    // No await separates geometry measurement from its baseline; a second full style scan is redundant.
    const snapshot = measurePreparedLayout(element, fonts, {
      fallback,
      repeatTableHeaders,
      strictCss,
      ...(fallbackFamily ? { fontFallback: fallbackFamily } : {}),
    });
    // Auto orientation chooses the wider paper only when portrait cannot contain source width.
    if (
      orientation === 'auto' &&
      snapshot.width > page.width - page.margin.left - page.margin.right &&
      page.height > page.width &&
      bands.content.margin.top + bands.content.margin.bottom < page.width
    ) {
      page = { ...page, width: page.height, height: page.width };
      bands = {
        ...bands,
        content: { ...bands.content, width: page.width, height: page.height },
      };
    }
    // The original CSS-pixel snapshot stays intact; only the PDF boundary scales its paint.
    const printableWidth = page.width - page.margin.left - page.margin.right;
    const sourceScale = fit === 'width' ? Math.min(1, printableWidth / snapshot.width) : 1;
    // Progress or HTML bands already required an earlier baseline across asynchronous work.
    if (!reportProgress && !bandSources.length) source.captureBaseline();
    if (reportProgress) await reportProgress({ stage: 'layout', completed: 1, total: 1 });
    if (reportProgress) await reportProgress({ stage: 'pagination', completed: 0, total: 1 });
    if (reportProgress) assertSourcesUnchanged();
    if (snapshot.width * sourceScale > printableWidth + 0.01) {
      throw new RenderPDFError(
        'SOURCE_OVERFLOW',
        'Source is wider than the configured page content area. Set fit to width or reduce the source width.',
      );
    }
    // CSS fragmentation preferences use the same measured coordinates as every paint operation.
    if (pageBreak === 'css') Object.assign(snapshot, collectPageBreaks(element, snapshot));
    // Page planning completes before callbacks so relaxed preferences are reported consistently.
    const paginationWarnings: RenderWarning[] = [];
    // Every text line, raster and table interval shares these exact page cuts with the writer.
    const slices = paginate(
      snapshot,
      (bands.content.height - bands.content.margin.top - bands.content.margin.bottom) / sourceScale,
      (warning) => paginationWarnings.push(warning),
    );
    if (reportProgress) await reportProgress({ stage: 'pagination', completed: 1, total: 1 });
    // Report approximation honestly even for documents without a local raster subtree.
    const warnings = [...snapshot.warnings, ...paginationWarnings];
    // Repeated HTML stays independently measured; its PDF form is reused on every physical page.
    const header = await preparePageBand(
      bands.header,
      element,
      fonts,
      page,
      {
        fallback,
        strictCss,
        rasterScale,
        verifySource,
        fontMismatch,
        fontFallback: fallbackFamily,
        signal,
      },
      includeRasterText,
    );
    const footer = await preparePageBand(
      bands.footer,
      element,
      fonts,
      page,
      {
        fallback,
        strictCss,
        rasterScale,
        verifySource,
        fontMismatch,
        fontFallback: fallbackFamily,
        signal,
      },
      includeRasterText,
    );
    // Rendering an HTML band yields to independent browser work; recheck the main source afterward.
    if (bandSources.length) assertSourcesUnchanged();
    warnings.push(...header.warnings, ...footer.warnings);
    if (verifySource === 'mutations') {
      warnings.push({
        code: 'SOURCE_VERIFICATION_REDUCED',
        message:
          'Mutation-only source verification can miss CSSOM edits and other computed-style changes during export.',
      });
    }
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
    if (onWarning || reportProgress) assertSourcesUnchanged();
    // Only the writer knows pdf-lib; geometry, source ownership and output API stay separate.
    const output = await withCancellation(
      writePDF(snapshot, fonts, page, slices, {
        rasterScale,
        sourceScale,
        omitUnsupportedCss: !strictCss,
        includeRasterText,
        ...(fallbackFamily ? { fontFallback: fallbackFamily } : {}),
        ...(header.band ? { header: header.band } : {}),
        ...(footer.band ? { footer: footer.band } : {}),
        ...(metadata ? { metadata } : {}),
        ...(reportProgress ? { reportProgress } : {}),
        ...(signal ? { signal } : {}),
      }),
      signal,
    );
    assertSourcesUnchanged();
    validateRegisteredFonts(fonts, element.ownerDocument);
    throwIfAborted(signal);
    if (reportProgress) {
      await reportProgress({ stage: 'complete', completed: 1, total: 1 });
      // Completion listeners remain application code and must not invalidate the verified source.
      assertSourcesUnchanged();
      validateRegisteredFonts(fonts, element.ownerDocument);
    }
    return { ...output, snapshot, warnings };
  } catch (error) {
    return progress.rethrow(error);
  } finally {
    for (const bandSource of bandSources) bandSource.dispose();
    source.dispose();
  }
}

/** Export a stable browser element through the minimal public PDF API. */
export async function renderPDF(
  /** Connected source; browser layout and caller-owned markup remain unchanged. */
  element: HTMLElement,
  /** Explicit font programs and supported conversion options. */
  options: RenderPDFOptions = {},
): Promise<RenderPDFResult> {
  // The evidence runner and public API share exactly one preparation and rendering pipeline.
  const output = await renderDocument(element, options);
  return createResult(output.bytes, output.slices.length, output.warnings);
}
