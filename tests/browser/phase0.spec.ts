import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { ExperimentResult } from '../../experiments/pdf';
import type { captureRaster } from '../../src/raster';
import type { snapshotLayout } from '../../src/layout';
import type { RegisteredFont } from '../../src/index';
import type { InspectedPage } from './pdf-inspector';

/** Match the renderer's default local raster resolution without downsampling glyph edges. */
const rasterPixelRatio = 2;

/** Browser fixture contract exposed only for reproducible Phase 0 research. */
interface ProbeApi {
  /** Run the experiment with optional extraction text in raster regions. */
  run: (includeRasterText?: boolean) => Promise<ExperimentResult>;
  /** Explicit font bytes shared by the fixture and the writer. */
  fonts: RegisteredFont[];
  /** Independent entry points for negative capability checks. */
  snapshotLayout: typeof snapshotLayout;
  captureRaster: typeof captureRaster;
}

/** Decode the self-contained PDF.js rendering returned across the browser boundary.
 * @param dataUrl PNG data URL emitted by the independent PDF inspector.
 */
function decodePng(dataUrl: string): PNG {
  return PNG.sync.read(Buffer.from(dataUrl.split(',')[1]!, 'base64'));
}

/** Preserve a raw pixel-difference diagnostic with an explicit channel threshold.
 * @param actual Rendered PDF page or bounded region.
 * @param expected Browser reference pixels at the same scale.
 * @param channelTolerance Largest permitted RGB channel difference per pixel.
 */
function mismatchRatio(actual: PNG, expected: PNG, channelTolerance = 60): number {
  expect(actual.width).toBe(expected.width);
  expect(actual.height).toBe(expected.height);
  // Count pixels, rather than channels, so the reported percentage is understandable.
  let mismatches = 0;
  for (let offset = 0; offset < actual.data.length; offset += 4) {
    if (
      Math.abs(actual.data[offset]! - expected.data[offset]!) > channelTolerance ||
      Math.abs(actual.data[offset + 1]! - expected.data[offset + 1]!) > channelTolerance ||
      Math.abs(actual.data[offset + 2]! - expected.data[offset + 2]!) > channelTolerance
    )
      mismatches += 1;
  }
  return mismatches / (actual.width * actual.height);
}

/** Compare fixed-position images while excluding detected antialiased edge pixels.
 * @param actual Independent PDF rendering at the reference's scale and origin.
 * @param expected Original browser rendering; no alignment or blur is applied.
 * @param difference Optional perceptual diff image saved with the measured evidence.
 */
function perceptualMismatchRatio(actual: PNG, expected: PNG, difference?: PNG): number {
  expect(actual.width).toBe(expected.width);
  expect(actual.height).toBe(expected.height);
  return (
    pixelmatch(actual.data, expected.data, difference?.data ?? null, actual.width, actual.height, {
      threshold: 0.1,
      includeAA: false,
    }) /
    (actual.width * actual.height)
  );
}

/** Build a white PDF-sized reference containing exactly the page's source interval.
 * @param source Chromium screenshot of the original DOM root.
 * @param page Independently rendered PDF page dimensions.
 * @param start Root-relative source interval start in CSS pixels.
 * @param end Root-relative source interval end in CSS pixels.
 * @param pixelRatio Physical verification pixels per CSS pixel.
 */
function referencePage(
  source: PNG,
  page: InspectedPage,
  start: number,
  end: number,
  pixelRatio = 1,
): PNG {
  // White is the PDF page background; source pixels begin at the explicit 24px margins.
  const reference = new PNG({ width: page.width, height: page.height });
  reference.data.fill(255);
  // Reference bitmaps store whole pixels; fractional source cuts round to the nearest pixel.
  const sourceStart = Math.round(start * pixelRatio);
  // The final interval can be shorter than the A4 content box.
  const height = Math.min(Math.round((end - start) * pixelRatio), source.height - sourceStart);
  PNG.bitblt(
    source,
    reference,
    0,
    sourceStart,
    source.width,
    height,
    24 * pixelRatio,
    24 * pixelRatio,
  );
  return reference;
}

/** Extract a same-sized visual region for a meaningful local-raster comparison.
 * @param image Full page image containing the requested region.
 * @param x Region's horizontal CSS pixel position.
 * @param y Region's vertical CSS pixel position.
 * @param width Region's CSS pixel width.
 * @param height Region's CSS pixel height.
 * @param pixelRatio Physical verification pixels per CSS pixel.
 */
function crop(
  image: PNG,
  x: number,
  y: number,
  width: number,
  height: number,
  pixelRatio = 1,
): PNG {
  // Pixel rounding is shared by actual/reference to avoid inventing geometry differences.
  const region = new PNG({
    width: Math.round(width * pixelRatio),
    height: Math.round(height * pixelRatio),
  });
  PNG.bitblt(
    image,
    region,
    Math.round(x * pixelRatio),
    Math.round(y * pixelRatio),
    region.width,
    region.height,
    0,
    0,
  );
  return region;
}

test('browser layout, native PDF text, local raster and two-page mapping work together', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  // All export work must stay local; only the fixture's initial assets may use HTTP.
  const exportRequests: string[] = [];
  await page.goto('/tests/fixtures/rendering.html');
  await page.waitForFunction(() => Boolean((window as unknown as { phase0?: ProbeApi }).phase0));
  await page.evaluate(() => document.fonts.ready);
  // Source DOM remains the user's UI; an export cannot alter it.
  const source = page.locator('#source');
  // Preserve initial markup and a direct browser reference before conversion.
  const originalMarkup = await source.evaluate((element) => element.outerHTML);
  // Playwright clips the element from Chromium's real rendering surface.
  const sourcePng = PNG.sync.read(await source.screenshot());
  // A separate browser surface matches the 2x capture while native-text checks stay at 96 DPI.
  const rasterPage = await browser.newPage({
    deviceScaleFactor: rasterPixelRatio,
    viewport: page.viewportSize()!,
  });
  let rasterSourcePng: PNG;
  let rasterReferenceBounds: { x: number; y: number; width: number; height: number }[];
  try {
    await rasterPage.goto(page.url());
    await rasterPage.waitForFunction(() =>
      Boolean((window as unknown as { phase0?: ProbeApi }).phase0),
    );
    const rasterSource = rasterPage.locator('#source');
    expect(await rasterSource.evaluate((element) => element.outerHTML)).toBe(originalMarkup);
    // Equal outer dimensions alone could hide wrapping differences under the fixture's min-height.
    rasterReferenceBounds = await rasterSource.evaluate((element) => {
      const origin = element.getBoundingClientRect();
      return Array.from(element.querySelectorAll('[data-raster]'), (region) => {
        const bounds = region.getBoundingClientRect();
        return {
          x: bounds.x - origin.x,
          y: bounds.y - origin.y,
          width: bounds.width,
          height: bounds.height,
        };
      });
    });
    rasterSourcePng = PNG.sync.read(await rasterSource.screenshot());
  } finally {
    await rasterPage.close();
  }
  expect(rasterSourcePng.width).toBe(sourcePng.width * rasterPixelRatio);
  expect(rasterSourcePng.height).toBe(sourcePng.height * rasterPixelRatio);
  page.on('request', (request) => {
    if (/^https?:/.test(request.url())) exportRequests.push(request.url());
  });
  // Browser-only generation and PDF.js inspection share no writer internals.
  const evidence = await page.evaluate(async (pixelRatio) => {
    // The typed experiment fixture is deliberately separate from a public library API.
    const api = (window as unknown as { phase0: ProbeApi }).phase0;
    // Record a local timing baseline without imposing an invented performance target.
    const exportStarted = performance.now();
    // Enable extraction-only text inside the two local raster regions.
    const result = await api.run(true);
    // Exclude PDF.js verification and artifact serialization from conversion elapsed time.
    const exportElapsedMs = performance.now() - exportStarted;
    // Vite serves this development-only inspector; runtime conversion does not import it.
    const inspectorPath = '/tests/browser/pdf-inspector.ts';
    // Dynamic path prevents TypeScript from interpreting the root URL as a disk import.
    const inspector = (await import(
      /* @vite-ignore */ inspectorPath
    )) as typeof import('./pdf-inspector');
    // Independent PDF.js parsing yields both pixels and selectable text objects.
    const pages = await inspector.inspectPdf(Array.from(result.bytes));
    // Render the same bytes at native capture resolution for bounded raster comparisons only.
    const rasterPages = await inspector.inspectPdf(Array.from(result.bytes), pixelRatio);
    // Serialize geometry only; live element references are intentionally omitted.
    const operations = result.snapshot.operations.map((operation) => ({
      kind: operation.kind,
      bounds: operation.bounds,
      ...(operation.kind === 'text'
        ? { text: operation.text, baseline: operation.baseline, invisible: operation.invisible }
        : {}),
    }));
    // Measure the stress line separately so mostly white page area cannot hide shaping differences.
    const sourceBounds = document.querySelector<HTMLElement>('#source')!.getBoundingClientRect();
    // This crop is a diagnostic metric; Phase 0 does not promise identical shaping.
    const typographyBounds = document
      .querySelector<HTMLElement>('#typography')!
      .getBoundingClientRect();
    return {
      bytes: Array.from(result.bytes),
      blobType: result.blob.type,
      blobSize: result.blob.size,
      pages,
      rasterPages,
      slices: result.slices,
      operations,
      warnings: result.snapshot.warnings,
      exportElapsedMs,
      typography: {
        x: typographyBounds.x - sourceBounds.x,
        y: typographyBounds.y - sourceBounds.y,
        width: typographyBounds.width,
        height: typographyBounds.height,
      },
    };
  }, rasterPixelRatio);
  // Both resolutions must describe the same CSS layout before comparing their pixels.
  expect(rasterReferenceBounds).toEqual(
    evidence.operations
      .filter((operation) => operation.kind === 'raster')
      .map((operation) => operation.bounds),
  );
  // Preserve raw evidence before assertions so structural failures remain reviewable.
  await writeFile(testInfo.outputPath('experiment.pdf'), Buffer.from(evidence.bytes));
  await writeFile(testInfo.outputPath('source.png'), PNG.sync.write(sourcePng));
  await writeFile(
    testInfo.outputPath('structure.json'),
    JSON.stringify(
      {
        slices: evidence.slices,
        operations: evidence.operations,
        pages: evidence.pages.map((pdfPage) => ({
          width: pdfPage.width,
          height: pdfPage.height,
          text: pdfPage.text,
          imagePaints: pdfPage.imagePaints,
          imageSizes: pdfPage.imageSizes,
        })),
      },
      null,
      2,
    ),
  );
  expect(await source.evaluate((element) => element.outerHTML)).toBe(originalMarkup);
  expect(evidence.blobType).toBe('application/pdf');
  expect(evidence.blobSize).toBe(evidence.bytes.length);
  expect(Buffer.from(evidence.bytes).subarray(0, 5).toString()).toBe('%PDF-');
  expect(evidence.pages).toHaveLength(2);
  expect(evidence.slices).toHaveLength(2);
  expect(evidence.slices[0]!.end).toBe(evidence.slices[1]!.start);
  // PDF.js may split or merge text items; extraction is checked as human-readable content.
  const pageTexts = evidence.pages.map((pdfPage) => pdfPage.text.map((item) => item.text).join(''));
  // These strings cover Unicode, explicit font faces, invisible text and the final page.
  const expectedStrings = [
    'Unicode accents: \u00e1\u010d\u010f\u00e9\u011b\u00ed\u0148\u00f3\u0159\u0161\u0165\u00fa\u016f\u00fd\u017e.',
    'Bold text: \u010d',
    'Italic text: \u0159',
    'Raster region is alive.',
    'End of the second page.',
  ];
  for (const expected of expectedStrings)
    expect(pageTexts.join('\n').split(expected)).toHaveLength(2);
  expect(pageTexts[1]).toContain('End of the second page.');
  expect(
    new Set(evidence.pages.flatMap((pdfPage) => pdfPage.text.map((item) => item.fontName))).size,
  ).toBeGreaterThanOrEqual(3);
  expect(evidence.operations.filter((operation) => operation.kind === 'raster')).toHaveLength(2);
  expect(evidence.pages.reduce((sum, pdfPage) => sum + pdfPage.imagePaints, 0)).toBe(3);
  expect(evidence.pages[1]!.imagePaints).toBeGreaterThanOrEqual(1);
  // No embedded bitmap may cover the complete source document or PDF page.
  for (const image of evidence.pages.flatMap((pdfPage) => pdfPage.imageSizes)) {
    expect(image.width).toBeLessThan(720 * 2);
    expect(image.height).toBeLessThan(900 * 2);
  }
  // Verify native and invisible text against the very same page-to-source coordinate map.
  const baselineErrors: number[] = [];
  // Delay coordinate assertions until visual metrics have also been persisted.
  const xOriginChecks: { text: string; currentX: number; expectedX: number }[] = [];
  for (const operation of evidence.operations) {
    if (operation.kind !== 'text' || !operation.text || operation.baseline === undefined) continue;
    // Each atomic text line must be wholly owned by one source interval.
    const pageIndex = evidence.slices.findIndex(
      (slice) => operation.bounds.y >= slice.start - 0.01 && operation.bounds.y < slice.end - 0.01,
    );
    expect(pageIndex).toBeGreaterThanOrEqual(0);
    // Match exact fixture text; PDF.js can normalize trailing or leading spaces.
    const extracted = evidence.pages[pageIndex]!.text.find(
      (item) => item.text.trim() === operation.text!.trim(),
    );
    expect(extracted, `PDF text for ${operation.text}`).toBeDefined();
    // PDF baseline runs upward from the bottom edge of the A4 MediaBox.
    const expectedBaseline =
      841.89 - (24 + operation.baseline - evidence.slices[pageIndex]!.start) * 0.75;
    baselineErrors.push(Math.abs(extracted!.transform[5]! - expectedBaseline));
    xOriginChecks.push({
      text: operation.text,
      currentX: extracted!.transform[4]!,
      expectedX: (24 + operation.bounds.x) * 0.75,
    });
  }
  // Compare actual browser pixels against independently rendered PDF pages at 96 DPI.
  const pageMismatchRatios: number[] = [];
  // Perceptual comparison excludes detected antialiasing without moving any image pixels.
  const perceptualPageMismatchRatios: number[] = [];
  // Record local raster fidelity separately so white page area cannot hide a failed capture.
  const rasterMismatchRatios: number[] = [];
  // The same comparator is applied to bounded raster crops to avoid white-area dilution.
  const perceptualRasterMismatchRatios: number[] = [];
  // Typography's raw score stays visible even when edge antialiasing is excluded for its gate.
  let typographyMismatchRatio: number | null = null;
  // A bounded typography gate verifies actual word placement separately from full-page layout.
  let perceptualTypographyMismatchRatio: number | null = null;
  // Mutated references prove this comparator remains sensitive to shifted or missing text.
  let comparatorSentinels: { shiftedTextRatio: number; missingTextRatio: number } | null = null;
  for (let index = 0; index < evidence.pages.length; index += 1) {
    // Page image and source interval share one root-relative coordinate map.
    const pdfPage = evidence.pages[index]!;
    // Independent rendered PDF pixels include native text and local raster elements together.
    const actual = decodePng(pdfPage.png);
    // Copy only the source interval assigned to the current PDF page.
    const slice = evidence.slices[index]!;
    // The reference preserves the browser's own Flexbox/Grid positions.
    const reference = referencePage(sourcePng, pdfPage, slice.start, slice.end);
    pageMismatchRatios.push(mismatchRatio(actual, reference));
    // Save a standard diff visualization, including excluded antialiased pixels.
    const difference = new PNG({ width: actual.width, height: actual.height });
    perceptualPageMismatchRatios.push(perceptualMismatchRatio(actual, reference, difference));
    await writeFile(
      testInfo.outputPath(`difference-page-${index + 1}.png`),
      PNG.sync.write(difference),
    );
    await writeFile(testInfo.outputPath(`pdf-page-${index + 1}.png`), PNG.sync.write(actual));
    await writeFile(
      testInfo.outputPath(`browser-page-${index + 1}.png`),
      PNG.sync.write(reference),
    );
    if (evidence.typography.y >= slice.start && evidence.typography.y < slice.end) {
      // Use identical pixels and rounding for the browser/PDF kerning stress crop.
      const bounds = evidence.typography;
      // Save both bounded samples so a high mismatch can be visually investigated.
      const actualTypography = crop(
        actual,
        24 + bounds.x,
        24 + bounds.y - slice.start,
        bounds.width,
        bounds.height,
      );
      // The reference preserves the browser's original kerning, ligatures and line breaks.
      const referenceTypography = crop(
        reference,
        24 + bounds.x,
        24 + bounds.y - slice.start,
        bounds.width,
        bounds.height,
      );
      typographyMismatchRatio = mismatchRatio(actualTypography, referenceTypography);
      perceptualTypographyMismatchRatio = perceptualMismatchRatio(
        actualTypography,
        referenceTypography,
      );
      // A two-pixel displacement must remain visible to the fixed-position comparator.
      const shiftedTypography = new PNG({
        width: referenceTypography.width,
        height: referenceTypography.height,
      });
      shiftedTypography.data.fill(255);
      PNG.bitblt(
        referenceTypography,
        shiftedTypography,
        0,
        0,
        referenceTypography.width - 2,
        referenceTypography.height,
        2,
        0,
      );
      // Erasing the text verifies that antialias exclusion cannot hide a missing text layer.
      const missingTypography = new PNG({
        width: referenceTypography.width,
        height: referenceTypography.height,
      });
      missingTypography.data.fill(255);
      comparatorSentinels = {
        shiftedTextRatio: perceptualMismatchRatio(shiftedTypography, referenceTypography),
        missingTextRatio: perceptualMismatchRatio(missingTypography, referenceTypography),
      };
      await writeFile(testInfo.outputPath('typography-pdf.png'), PNG.sync.write(actualTypography));
      await writeFile(
        testInfo.outputPath('typography-browser.png'),
        PNG.sync.write(referenceTypography),
      );
    }
    // Keep the original 96-DPI page and typography gates; compare rasters at matching 192 DPI.
    const rasterActual = decodePng(evidence.rasterPages[index]!.png);
    const rasterReference = referencePage(
      rasterSourcePng,
      evidence.rasterPages[index]!,
      slice.start,
      slice.end,
      rasterPixelRatio,
    );
    await writeFile(
      testInfo.outputPath(`raster-pdf-page-${index + 1}.png`),
      PNG.sync.write(rasterActual),
    );
    await writeFile(
      testInfo.outputPath(`raster-browser-page-${index + 1}.png`),
      PNG.sync.write(rasterReference),
    );
    for (const operation of evidence.operations) {
      if (
        operation.kind !== 'raster' ||
        operation.bounds.y < slice.start ||
        operation.bounds.y >= slice.end
      )
        continue;
      // Local captures use the identical margin and vertical page offset as text.
      const bounds = operation.bounds;
      // Compare identical bounded samples using both raw and antialias-aware metrics.
      const actualRaster = crop(
        rasterActual,
        24 + bounds.x,
        24 + bounds.y - slice.start,
        bounds.width,
        bounds.height,
        rasterPixelRatio,
      );
      // Browser pixels preserve the exact region selected for the local raster fallback.
      const referenceRaster = crop(
        rasterReference,
        24 + bounds.x,
        24 + bounds.y - slice.start,
        bounds.width,
        bounds.height,
        rasterPixelRatio,
      );
      rasterMismatchRatios.push(mismatchRatio(actualRaster, referenceRaster));
      perceptualRasterMismatchRatios.push(perceptualMismatchRatio(actualRaster, referenceRaster));
    }
  }
  // Removing extraction-only text must leave every visible PDF pixel unchanged.
  const withoutTextPages = await page.evaluate(async () => {
    // Export again through the same local browser path with invisible text disabled.
    const api = (window as unknown as { phase0: ProbeApi }).phase0;
    // The comparison isolates text rendering mode from raster compositing behavior.
    const result = await api.run(false);
    // Load the independent development-only PDF inspector from the Vite server.
    const inspectorPath = '/tests/browser/pdf-inspector.ts';
    // The module is already cached from the structural verification above.
    const inspector = (await import(
      /* @vite-ignore */ inspectorPath
    )) as typeof import('./pdf-inspector');
    return inspector.inspectPdf(Array.from(result.bytes));
  });
  for (let index = 0; index < evidence.pages.length; index += 1) {
    expect(
      mismatchRatio(
        decodePng(evidence.pages[index]!.png),
        decodePng(withoutTextPages[index]!.png),
        0,
      ),
    ).toBe(0);
  }
  expect(
    withoutTextPages.flatMap((pdfPage) => pdfPage.text.map((item) => item.text)).join(''),
  ).not.toContain('Raster region is alive.');
  // Ignore inspector module/worker fetches: the export itself already completed before loading them.
  const unexpectedRequests = exportRequests.filter(
    (url) =>
      !url.includes('/tests/browser/pdf-inspector.ts') &&
      !url.includes('/node_modules/') &&
      !url.includes('/@vite/client'),
  );
  expect(unexpectedRequests).toEqual([]);
  // Save reproducible evidence even when a tolerance assertion fails.
  await writeFile(
    testInfo.outputPath('metrics.json'),
    JSON.stringify(
      {
        chromium: browser.version(),
        pageVerificationDpi: 96,
        rasterVerificationDpi: 96 * rasterPixelRatio,
        bytes: evidence.bytes.length,
        exportElapsedMs: evidence.exportElapsedMs,
        textLineCount: evidence.operations.filter((operation) => operation.kind === 'text').length,
        invisibleLineCount: evidence.operations.filter(
          (operation) => operation.kind === 'text' && operation.invisible,
        ).length,
        pages: evidence.pages.length,
        imagePaints: evidence.pages.map((pdfPage) => pdfPage.imagePaints),
        maxBaselineErrorPt: Math.max(...baselineErrors),
        maxXOriginErrorPt: Math.max(
          ...xOriginChecks.map((check) => Math.abs(check.currentX - check.expectedX)),
        ),
        pageMismatchRatios,
        rasterMismatchRatios,
        typographyMismatchRatio,
        perceptualPageMismatchRatios,
        perceptualRasterMismatchRatios,
        perceptualTypographyMismatchRatio,
        comparatorSentinels,
        channelTolerance: 60,
        visualGate: {
          comparator: 'pixelmatch',
          threshold: 0.1,
          includeAA: false,
          alignment: 'none',
          blur: 'none',
        },
        pageTolerance: 0.02,
        rasterTolerance: 0.05,
        typographyTolerance: 0.02,
        warnings: evidence.warnings,
      },
      null,
      2,
    ),
  );
  expect(Math.max(...baselineErrors)).toBeLessThan(0.02);
  for (const check of xOriginChecks) {
    expect(
      Math.abs(check.currentX - check.expectedX),
      `PDF x origin for ${JSON.stringify(check.text)}: currentX=${check.currentX}pt expectedX=${check.expectedX}pt`,
    ).toBeLessThan(0.02);
  }
  for (const ratio of perceptualPageMismatchRatios) expect(ratio).toBeLessThan(0.02);
  for (const ratio of perceptualRasterMismatchRatios) expect(ratio).toBeLessThan(0.05);
  expect(perceptualTypographyMismatchRatio).not.toBeNull();
  expect(perceptualTypographyMismatchRatio!).toBeLessThan(0.02);
  expect(comparatorSentinels).not.toBeNull();
  expect(comparatorSentinels!.shiftedTextRatio).toBeGreaterThan(0.05);
  expect(comparatorSentinels!.missingTextRatio).toBeGreaterThan(0.05);
});

test('unsupported CSS, unavailable faces and invalid raster sizes fail explicitly', async ({
  page,
}) => {
  // The negative resource probe must never contact a real network endpoint.
  await page.route('https://example.invalid/**', (route) => route.abort());
  await page.goto('/tests/fixtures/rendering.html');
  await page.waitForFunction(() => Boolean((window as unknown as { phase0?: ProbeApi }).phase0));
  // Capability failures are checked using real connected browser elements.
  const errors = await page.evaluate(async () => {
    // Reuse the same registered fonts as the successful experiment.
    const api = (window as unknown as { phase0: ProbeApi }).phase0;
    // Select an explicit local snapshot boundary already present in the fixture.
    const raster = document.querySelector<HTMLElement>('#source [data-raster]')!;
    // The original source stays unchanged after each negative case.
    const source = document.querySelector<HTMLElement>('#source')!;
    // Capture meaningful error messages, without treating missing rejection as success.
    const messages: string[] = [];
    /** Record a rejected capability probe for a browser-supported operation. */
    async function rejection(operation: () => Promise<unknown>): Promise<void> {
      try {
        await operation();
        messages.push('NO_ERROR');
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error));
      }
    }
    await rejection(() => api.captureRaster(raster, api.fonts, 0));
    await rejection(() => api.captureRaster(raster, api.fonts, 100_000));
    await rejection(() => api.snapshotLayout(source, []));
    // Positioning needs a general stacking/paint planner and is deliberately rejected.
    const originalPosition = source.style.position;
    try {
      source.style.position = 'relative';
      await rejection(() => api.snapshotLayout(source, api.fonts));
    } finally {
      source.style.position = originalPosition;
    }
    // A loaded system fallback cannot replace an exact registered face.
    const originalFamily = source.style.fontFamily;
    try {
      source.style.fontFamily = 'Unregistered Phase Zero Face';
      await rejection(() => api.snapshotLayout(source, api.fonts));
    } finally {
      source.style.fontFamily = originalFamily;
    }
    // External URL resources must fail before the raster adapter serializes the subtree.
    const originalBackground = raster.style.backgroundImage;
    try {
      raster.style.backgroundImage = 'url("https://example.invalid/remote.png")';
      await rejection(() => api.captureRaster(raster, api.fonts, 1));
    } finally {
      raster.style.backgroundImage = originalBackground;
    }
    await rejection(() => api.captureRaster(raster, api.fonts, 1, { x: 1, y: 0 }));
    return messages;
  });
  expect(errors[0]).toMatch(/scale.*positive/i);
  expect(errors[1]).toMatch(/budget|bounds/i);
  expect(errors[2]).toMatch(/registered fonts/i);
  expect(errors[3]).toMatch(/unsupported CSS.*position/i);
  expect(errors[4]).toMatch(/exact registered font/i);
  expect(errors[5]).toMatch(/inline bitmap resources/i);
  expect(errors[6]).toMatch(/offsets.*fractions/i);
});

test('the demo downloads a PDF Blob without a print dialog or browser errors', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  // Browser-side print calls are observable without opening a modal system window.
  await page.addInitScript(() => {
    // This test-only counter survives the button's asynchronous export handler.
    const state = window as unknown as { phase0PrintCalls: number };
    state.phase0PrintCalls = 0;
    window.print = () => {
      state.phase0PrintCalls += 1;
    };
  });
  // Capture console and uncaught exceptions throughout fixture loading and export.
  const browserErrors: string[] = [];
  // Unexpected dialogs are dismissed only to ensure test cleanup.
  const dialogs: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await page.goto('/tests/fixtures/rendering.html');
  // Wait for exact font registration before invoking the actual download button.
  const button = page.getByRole('button', { name: 'Download experiment PDF' });
  await expect(button).toBeEnabled();
  // Listening starts before clicking so the generated Blob download cannot be missed.
  const downloadPromise = page.waitForEvent('download');
  await button.click();
  // The browser consumes the Blob directly without a backend or print service.
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('renderpdf-phase0.pdf');
  await download.saveAs(testInfo.outputPath('download.pdf'));
  // Check the actual user-facing file rather than relying solely on the runner result.
  const downloadedBytes = await readFile(testInfo.outputPath('download.pdf'));
  expect(downloadedBytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(downloadedBytes.byteLength).toBeGreaterThan(1_000);
  await expect(page.getByRole('status')).toContainText('2 pages');
  await expect(button).toBeEnabled();
  expect(
    await page.evaluate(() => (window as unknown as { phase0PrintCalls: number }).phase0PrintCalls),
  ).toBe(0);
  expect(dialogs).toEqual([]);
  expect(browserErrors).toEqual([]);
});
