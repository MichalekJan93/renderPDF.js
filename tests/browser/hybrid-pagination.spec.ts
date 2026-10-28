import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { RegisteredFont } from '../../src/index';
import type { InspectedPage } from './pdf-inspector';

/** Load a privacy-safe document with the same exact fonts in browser layout and PDF output.
 * @param page Chromium page used by the browser integration test.
 */
async function loadFixture(page: Page): Promise<void> {
  await page.goto('/tests/fixtures/hybrid-pages.html');
  await page.evaluate(async () => {
    // Consumer-facing imports remain independent of internal measurement and writer entry points.
    const modulePath = '/src/index.ts';
    // Dynamic URLs are resolved by Vite while TypeScript checks the actual public contract.
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    // Only two licensed fixture faces are needed for ordinary and emphasized Czech text.
    const fonts = await Promise.all(
      ['Regular', 'Bold'].map(async (face) => {
        // Fetch fixture bytes before conversion, rather than invoking any system font discovery.
        const response = await fetch(`/fonts/NotoSans-${face}.ttf`);
        return api.registerFont({
          family: 'Hybrid Sans',
          weight: face === 'Bold' ? 700 : 400,
          data: await response.arrayBuffer(),
        });
      }),
    );
    // Explicit handles survive only in this browser document for subsequent public API calls.
    (window as unknown as { hybridFonts: RegisteredFont[] }).hybridFonts = fonts;
    await document.fonts.ready;
  });
}

/** Independently render and extract output through development-only PDF.js.
 * @param page Browser context that owns the independent PDF inspector worker.
 * @param bytes Complete serialized bytes returned by the public output API.
 */
async function inspect(page: Page, bytes: number[]): Promise<InspectedPage[]> {
  return page.evaluate(async (serializedBytes) => {
    // The runtime converter never imports this independent parsing and rendering module.
    const modulePath = '/tests/browser/pdf-inspector.ts';
    // Browser module loading is checked against the real inspector interface.
    const inspector = (await import(
      /* @vite-ignore */ modulePath
    )) as typeof import('./pdf-inspector');
    return inspector.inspectPdf(serializedBytes);
  }, bytes);
}

/** Compare equal-scale pixels at their original coordinates without alignment or blur.
 * @param actual PDF.js-rendered pixels at 96 DPI.
 * @param expected Chromium pixels at the same 96 DPI reference scale.
 */
function difference(actual: PNG, expected: PNG): number {
  expect(actual.width).toBe(expected.width);
  expect(actual.height).toBe(expected.height);
  return (
    pixelmatch(actual.data, expected.data, null, actual.width, actual.height, {
      threshold: 0.1,
      includeAA: false,
    }) /
    (actual.width * actual.height)
  );
}

/** Extract exactly one fixed source/PDF rectangle without inventing a fitted alignment.
 * @param image Full browser or PDF bitmap at 96 DPI.
 * @param x Left edge in whole CSS pixels.
 * @param y Top edge in whole CSS pixels.
 * @param width Region width in whole CSS pixels.
 * @param height Region height in whole CSS pixels.
 */
function crop(image: PNG, x: number, y: number, width: number, height: number): PNG {
  // Geometry is deliberately authored as integer pixels in the synthetic fixture.
  const result = new PNG({ width, height });
  PNG.bitblt(image, result, x, y, width, height, 0, 0);
  return result;
}

test('automatic local fallbacks preserve native text, nested paint ownership and browser pixels', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await loadFixture(page);
  // The original document has no explicit raster markers; both effect boundaries must be planned.
  const source = page.locator('#hybrid');
  expect(await source.locator('[data-raster]').count()).toBe(0);
  // Preserve the caller-owned DOM and Chromium pixels before either export or evidence measurement.
  const markup = await source.evaluate((element) => element.outerHTML);
  // Browser pixels remain the independent visual reference at the exact root origin.
  const browserImage = PNG.sync.read(await source.screenshot());
  // Positive generation goes through the public library entry rather than an experiment runner.
  const evidence = await page.evaluate(async () => {
    // Public API imports are resolved as browser URLs by the development server.
    const modulePath = '/src/index.ts';
    // This cast checks the options/result contract used by ordinary consumers.
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    // Source geometry stays owned by the browser and is never reconstructed from CSS declarations.
    const root = document.querySelector<HTMLElement>('#hybrid')!;
    // Exact registration handles are shared across vector text and local raster serialization.
    const fonts = (window as unknown as { hybridFonts: RegisteredFont[] }).hybridFonts;
    // Fixed custom paper leaves 460 by 360 CSS pixels after the 20px margins.
    const result = await api.renderPDF(root, {
      fonts,
      format: { width: 500, height: 400 },
      margin: 20,
    });
    // Only independently browser-measured crop rectangles are needed for visible raster checks.
    const origin = root.getBoundingClientRect();
    return {
      bytes: Array.from(await result.toUint8Array()),
      pageCount: result.pageCount,
      warnings: result.warnings,
      text: root.innerText,
      regions: ['auto-card', 'auto-inset'].map((id) => {
        // These bounds are the actual live browser boxes, never writer-supplied placement values.
        const bounds = document.getElementById(id)!.getBoundingClientRect();
        return {
          id,
          x: bounds.left - origin.left,
          y: bounds.top - origin.top,
          width: bounds.width,
          height: bounds.height,
        };
      }),
    };
  });
  // The independent PDF graphics list catches whole-page rasterization or nested duplicate captures.
  const pages = await inspect(page, evidence.bytes);
  expect(pages).toHaveLength(1);
  expect(evidence.pageCount).toBe(1);
  expect(pages[0]!.width).toBe(500);
  expect(pages[0]!.height).toBe(400);
  expect(pages[0]!.imagePaints).toBe(2);
  expect(pages[0]!.imageSizes).toEqual([
    { width: 840, height: 200 },
    { width: 840, height: 128 },
  ]);
  expect(evidence.warnings.filter((warning) => warning.code === 'RASTER_FALLBACK')).toHaveLength(2);
  // Extraction-only text inside each bitmap must appear exactly once alongside native text.
  const extracted = pages[0]!.text
    .map((item) => item.text)
    .join('')
    .replace(/\s+/g, '');
  expect(extracted).toBe(evidence.text.replace(/\s+/g, ''));
  expect(extracted).toContain('\u00e1\u010d\u010f');
  // Native text before and after the images prevents a bitmap-only PDF from satisfying the check.
  expect(pages[0]!.text.some((item) => item.text.includes('Native'))).toBe(true);
  // White custom paper frames the unmodified browser root at its exact 20px page offset.
  const reference = new PNG({ width: 500, height: 400 });
  reference.data.fill(255);
  PNG.bitblt(browserImage, reference, 0, 0, browserImage.width, browserImage.height, 20, 20);
  // The PDF decoder uses the same 96 DPI scale as Chromium's original screenshot.
  const pdfImage = PNG.sync.read(Buffer.from(pages[0]!.png.split(',')[1]!, 'base64'));
  // Local region gates prevent the mostly white page from hiding a missing effect or duplicate text.
  const rasterDifferences = evidence.regions.map((bounds) =>
    difference(
      crop(pdfImage, 20 + bounds.x, 20 + bounds.y, bounds.width, bounds.height),
      crop(browserImage, bounds.x, bounds.y, bounds.width, bounds.height),
    ),
  );
  // Retain objective evidence even if a visual gate fails.
  const pageDifference = difference(pdfImage, reference);
  await writeFile(testInfo.outputPath('hybrid-pdf-page.png'), PNG.sync.write(pdfImage));
  await writeFile(testInfo.outputPath('hybrid-browser-page.png'), PNG.sync.write(reference));
  await writeFile(
    testInfo.outputPath('hybrid-metrics.json'),
    JSON.stringify({ pageDifference, rasterDifferences, warnings: evidence.warnings }, null, 2),
  );
  expect(pageDifference).toBeLessThan(0.02);
  for (const ratio of rasterDifferences) expect(ratio).toBeLessThan(0.05);
  expect(await source.evaluate((element) => element.outerHTML)).toBe(markup);
});

test('CSS page breaks preserve avoid cards, wrapped lines and rowspan table intervals', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await loadFixture(page);
  // Configure a real multi-page browser document with only synthetic stable extraction markers.
  const sourceText = await page.evaluate(() => {
    // Replace the independent automatic-fallback fixture before taking any rendering evidence.
    const root = document.querySelector<HTMLElement>('#hybrid')!;
    // This paragraph is one DOM text node; browser wrapping must fragment it across PDF pages.
    const paragraph = Array.from(
      { length: 90 },
      (_, index) => `WORD${String(index + 1).padStart(3, '0')} variation`,
    ).join(' ');
    // A spanning cell covers three adjacent rows and must move together with all their text.
    const rows = Array.from({ length: 18 }, (_, index) => {
      // Stable markers expose both row splitting and missing or duplicated table text.
      const identifier = String(index + 1).padStart(3, '0');
      // Rows 10 and 11 share row 9's first cell rather than overlapping independent cells.
      const group =
        index === 8
          ? '<td id="rowspan-cell" rowspan="3"><p>SPAN A</p><p>SPAN B</p></td>'
          : index === 9 || index === 10
            ? ''
            : `<td>GROUP ${identifier}</td>`;
      return `<tr data-row="${identifier}">${group}<td>ROW ${identifier} A</td><td>ROW ${identifier} B</td></tr>`;
    }).join('');
    root.innerHTML = `
      <p>The first page contains native text.</p>
      <div style="height: 220px"></div>
      <section id="avoid-card" class="keep-together atomic-card"><p>KEEP A start</p><div style="height: 76px"></div><p>KEEP B end</p></section>
      <p id="forced-after" class="break-after">Forced end of the page.</p>
      <h2>After the forced ending</h2>
      <p id="long-paragraph">${paragraph}</p>
      <section id="forced-before" class="break-before"><p>The next page is forced.</p></section>
      <table><thead><tr><th>Group</th><th>Start</th><th>End</th></tr></thead><tbody>${rows}</tbody></table>
      <p>The final Unicode line is complete.</p>`;
    return root.innerText;
  });
  // Preserve the original browser source and its exact first interval for visual evidence.
  const source = page.locator('#hybrid');
  // Source mutation during conversion would invalidate both the page map and extraction checks.
  const markup = await source.evaluate((element) => element.outerHTML);
  // This screenshot is Chromium's full original layout, independent of any PDF reconstruction.
  const browserImage = PNG.sync.read(await source.screenshot());
  // Public CSS-mode and geometry-only exports expose the observable difference in pagination policy.
  const evidence = await page.evaluate(async () => {
    // Public generation remains the subject under test for both page-break modes.
    const modulePath = '/src/index.ts';
    // Browser URL imports preserve the compiled public method signatures.
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    // Measurement evidence uses the same connected source after both public exports finish.
    const root = document.querySelector<HTMLElement>('#hybrid')!;
    // Registered handles select matching static normal/bold font bytes.
    const fonts = (window as unknown as { hybridFonts: RegisteredFont[] }).hybridFonts;
    // Custom paper gives a compact 360px source interval on each page.
    const options = { fonts, format: { width: 500, height: 400 }, margin: 20 };
    // Default CSS policy must honor both forced and avoided cuts.
    const css = await api.renderPDF(root, options);
    // Automatic policy ignores authored break hints while preserving required atomic objects.
    const auto = await api.renderPDF(root, { ...options, pageBreak: 'auto' });
    // Internal evidence is used only to inspect measured source intervals, never as positive output.
    const measurementPath = '/src/render-pdf.ts';
    // The mapping is evidence for interpreting PDF pixels rather than another PDF implementation.
    const measurement = (await import(
      /* @vite-ignore */ measurementPath
    )) as typeof import('../../src/render-pdf');
    // Record the renderer's measured map after the public API has already produced both documents.
    const measured = await measurement.renderDocument(root, options);
    // Independent DOM rectangles relate table rows, forced boundaries and source pixels to the map.
    const origin = root.getBoundingClientRect();
    /** Read browser geometry in root-relative CSS pixels.
     * @param element Browser-laid-out element whose page ownership is independently checked.
     */
    function interval(element: Element) {
      // No CSS sizes or text advances are recomputed by the test.
      const bounds = element.getBoundingClientRect();
      return { top: bounds.top - origin.top, bottom: bounds.bottom - origin.top };
    }
    return {
      cssBytes: Array.from(await css.toUint8Array()),
      autoBytes: Array.from(await auto.toUint8Array()),
      slices: measured.slices,
      forcedAfter: interval(document.getElementById('forced-after')!).bottom,
      forcedBefore: interval(document.getElementById('forced-before')!).top,
      avoid: interval(document.getElementById('avoid-card')!),
      paragraph: interval(document.getElementById('long-paragraph')!),
      rowspan: interval(document.getElementById('rowspan-cell')!),
      rows: Array.from(root.querySelectorAll('[data-row]'), (row) => ({
        identifier: row.getAttribute('data-row')!,
        ...interval(row),
      })),
    };
  });
  // Independent PDF extraction checks complete source text before any geometry-only evidence.
  const cssPages = await inspect(page, evidence.cssBytes);
  // The automatic export provides a behavioral control for break-inside: avoid.
  const autoPages = await inspect(page, evidence.autoBytes);
  // Whitespace may be synthesized between separately positioned PDF words.
  const cssTexts = cssPages.map((pdfPage) =>
    pdfPage.text
      .map((item) => item.text)
      .join('')
      .replace(/\s+/g, ''),
  );
  // Preserve page boundaries while normalizing only extraction whitespace.
  const autoTexts = autoPages.map((pdfPage) =>
    pdfPage.text
      .map((item) => item.text)
      .join('')
      .replace(/\s+/g, ''),
  );
  expect(cssTexts.join('')).toBe(sourceText.replace(/\s+/g, ''));
  expect(autoTexts.join('')).toBe(sourceText.replace(/\s+/g, ''));
  expect(cssPages).toHaveLength(evidence.slices.length);
  expect(cssPages.length).toBeGreaterThanOrEqual(4);
  expect(cssPages.every((pdfPage) => pdfPage.imagePaints === 0)).toBe(true);
  expect(evidence.slices.some((slice) => Math.abs(slice.end - evidence.forcedAfter) < 0.01)).toBe(
    true,
  );
  expect(
    evidence.slices.some((slice) => Math.abs(slice.start - evidence.forcedBefore) < 0.01),
  ).toBe(true);
  expect(cssTexts.findIndex((text) => text.includes('KEEPA'))).toBe(
    cssTexts.findIndex((text) => text.includes('KEEPB')),
  );
  expect(autoTexts.findIndex((text) => text.includes('KEEPA'))).not.toBe(
    autoTexts.findIndex((text) => text.includes('KEEPB')),
  );
  // One paragraph must cross page boundaries as native line fragments rather than an atomic bitmap.
  expect(cssTexts.filter((text) => /WORD\d{3}/.test(text)).length).toBeGreaterThanOrEqual(2);
  for (const row of evidence.rows) {
    // Row endpoints must remain together in the physical PDF page containing the measured interval.
    const pageIndex = evidence.slices.findIndex(
      (slice) => row.top >= slice.start - 0.01 && row.bottom <= slice.end + 0.01,
    );
    expect(
      pageIndex,
      `Browser row ${row.identifier} has one source interval`,
    ).toBeGreaterThanOrEqual(0);
    expect(cssTexts[pageIndex]).toContain(`ROW${row.identifier}A`);
    expect(cssTexts[pageIndex]).toContain(`ROW${row.identifier}B`);
  }
  // The spanning cell and all three covered rows need one common ownership interval.
  const spanningPage = evidence.slices.findIndex(
    (slice) =>
      evidence.rowspan.top >= slice.start - 0.01 && evidence.rowspan.bottom <= slice.end + 0.01,
  );
  expect(spanningPage).toBeGreaterThanOrEqual(0);
  for (const marker of ['SPANA', 'SPANB', 'ROW009A', 'ROW010A', 'ROW011B'])
    expect(cssTexts[spanningPage]).toContain(marker);
  // Compare every physical page at equal scale with exactly its measured source interval.
  const pageDifferences: number[] = [];
  for (let index = 0; index < cssPages.length; index += 1) {
    // CSS page boundaries may leave intentionally blank paper after a forced cut.
    const slice = evidence.slices[index]!;
    // Rendered PDF and source pixels are kept at their original measured positions.
    const actual = PNG.sync.read(Buffer.from(cssPages[index]!.png.split(',')[1]!, 'base64'));
    // White page margins and the blank tail after a forced cut are explicit reference pixels.
    const reference = new PNG({ width: 500, height: 400 });
    reference.data.fill(255);
    // All authored line/row geometry is integral apart from browser border-spacing rounding.
    const start = Math.round(slice.start);
    // Copy only the original interval owned by this physical page.
    const height = Math.min(Math.round(slice.end - slice.start), browserImage.height - start);
    PNG.bitblt(browserImage, reference, 0, start, browserImage.width, height, 20, 20);
    pageDifferences.push(difference(actual, reference));
    await writeFile(testInfo.outputPath(`pagination-pdf-${index + 1}.png`), PNG.sync.write(actual));
    await writeFile(
      testInfo.outputPath(`pagination-browser-${index + 1}.png`),
      PNG.sync.write(reference),
    );
  }
  await writeFile(
    testInfo.outputPath('pagination-metrics.json'),
    JSON.stringify(
      { pageDifferences, ...evidence, cssBytes: undefined, autoBytes: undefined },
      null,
      2,
    ),
  );
  for (const ratio of pageDifferences) expect(ratio).toBeLessThan(0.02);
  expect(await source.evaluate((element) => element.outerHTML)).toBe(markup);
});

test('strict mode and unsafe effects fail explicitly while oversized avoid boxes report relaxation', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await loadFixture(page);
  // Every case exercises an actual connected browser element through the public API.
  const evidence = await page.evaluate(async () => {
    // The package entry is the only conversion API used for diagnostics and successful output.
    const modulePath = '/src/index.ts';
    // Typed dynamic import makes supported options and stable diagnostic codes compile-time checked.
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    // Each probe replaces source content before an export begins, preserving source-ownership rules.
    const root = document.querySelector<HTMLElement>('#hybrid')!;
    // Exact regular and bold faces remain shared by all probes in this one document.
    const fonts = (window as unknown as { hybridFonts: RegisteredFont[] }).hybridFonts;
    // Tiny paper keeps all negative cases bounded and makes the oversized avoid case meaningful.
    const options = { fonts, format: { width: 500, height: 400 }, margin: 20 };
    // Stable machine-readable codes distinguish an explicit rejection from a silently partial PDF.
    const errors: Record<string, string> = {};
    /** Record a public failure without allowing successful exports to masquerade as rejection.
     * @param label Identifier of the independent unsupported capability.
     * @param operation Browser export expected to reject.
     */
    async function rejection(label: string, operation: () => Promise<unknown>): Promise<void> {
      try {
        await operation();
        errors[label] = 'NO_ERROR';
      } catch (error) {
        errors[label] = error instanceof api.RenderPDFError ? error.code : String(error);
      }
    }
    await rejection('strict', () => api.renderPDF(root, { ...options, fallback: 'strict' }));
    // Strict mode retains the deliberate explicit-marker workflow for safe local subtrees.
    root.innerHTML = '<div class="card" data-raster><p>Explicit raster in strict mode.</p></div>';
    // This successful output later receives an independent image-paint check.
    const explicit = await api.renderPDF(root, { ...options, fallback: 'strict' });
    root.innerHTML =
      '<div style="box-shadow: 0 2px 8px #345; padding: 12px">The outer shadow extends beyond the box.</div>';
    await rejection('outerShadow', () => api.renderPDF(root, { ...options, strictCss: true }));
    root.innerHTML =
      '<div style="backdrop-filter: blur(2px); padding: 12px">The effect depends on the backdrop.</div>';
    await rejection('backdrop', () => api.renderPDF(root, options));
    root.innerHTML =
      '<div style="display: grid"><div style="grid-area: 1 / 1">First overlap</div><div style="grid-area: 1 / 1">Second overlap</div></div>';
    await rejection('overlap', () => api.renderPDF(root, options));
    // An automatic owner cannot conceal a descendant whose CSS order needs a different paint plan.
    root.innerHTML =
      '<div style="display: flex; background: linear-gradient(90deg, #eee, #ddd)"><div style="order: 1">Unsupported descendant order.</div></div>';
    await rejection('nestedOrder', () => api.renderPDF(root, options));
    // Overlap remains unsafe even when an ancestor otherwise qualifies as one local raster boundary.
    root.innerHTML =
      '<div style="display: grid; background: linear-gradient(90deg, #eee, #ddd)"><p style="grid-area: 1 / 1">First nested overlap</p><p style="grid-area: 1 / 1">Second nested overlap</p></div>';
    await rejection('nestedOverlap', () => api.renderPDF(root, options));
    // Fragmented inline boxes have multiple paint rectangles, not one independently captured region.
    root.innerHTML = `<p><span style="background: linear-gradient(90deg, #eee, #ddd)">${'Fragmented colored Unicode text '.repeat(12)}</span></p>`;
    // Confirm the fixture actually exercises line fragmentation before expecting the specific rejection.
    const fragmentedRects = root.querySelector('span')!.getClientRects().length;
    await rejection('fragmentedInline', () => api.renderPDF(root, options));
    // Native inline backgrounds have separate line fragments rather than one filled union rectangle.
    root.innerHTML = `<p style="width: 120px"><span style="background: red">${'Several wrapped words '.repeat(8)}</span></p>`;
    await rejection('fragmentedSolid', () => api.renderPDF(root, options));
    // Direct text and a later block can overlap even when there are no sibling element pairs.
    const originalLineHeight = root.style.lineHeight;
    root.style.lineHeight = '0px';
    root.innerHTML = 'MMMM<div style="height: 40px; background: red"></div>';
    try {
      await rejection('textPaintOrder', () => api.renderPDF(root, options));
    } finally {
      root.style.lineHeight = originalLineHeight;
    }
    // Empty generated content can still paint a colored box and must never disappear silently.
    const pseudoStyle = document.createElement('style');
    pseudoStyle.textContent =
      '.native-empty-pseudo::before { content: ""; display: inline-block; width: 8px; height: 8px; background: red; }';
    document.head.append(pseudoStyle);
    root.innerHTML =
      '<p class="native-empty-pseudo">An empty pseudo-element has a visible background.</p>';
    try {
      await rejection('generatedBox', () => api.renderPDF(root, options));
    } finally {
      pseudoStyle.remove();
    }
    root.innerHTML =
      '<table><tbody><tr><td><p>Start of an atomic row.</p><p class="break-before">Forced break inside a row.</p></td></tr></tbody></table>';
    await rejection('atomicBreak', () => api.renderPDF(root, options));
    // An avoid hint cannot make an arbitrarily tall normal-flow paragraph indivisible.
    root.innerHTML = `<section class="keep-together"><p>${Array.from({ length: 100 }, (_, index) => `LARGE${String(index + 1).padStart(3, '0')} sample`).join(' ')}</p></section>`;
    // Relaxing an impossible soft constraint is observable, while native paragraph lines still export.
    const oversized = await api.renderPDF(root, options);
    return {
      errors,
      fragmentedRects,
      explicitBytes: Array.from(await explicit.toUint8Array()),
      oversizedBytes: Array.from(await oversized.toUint8Array()),
      oversizedText: root.innerText,
      oversizedWarnings: oversized.warnings,
      oversizedPages: oversized.pageCount,
    };
  });
  expect(evidence.errors).toEqual({
    strict: 'UNSUPPORTED_CSS',
    outerShadow: 'UNSUPPORTED_CSS',
    backdrop: 'UNSUPPORTED_CSS',
    overlap: 'UNSUPPORTED_CSS',
    nestedOrder: 'UNSUPPORTED_CSS',
    nestedOverlap: 'UNSUPPORTED_CSS',
    fragmentedInline: 'UNSUPPORTED_CSS',
    fragmentedSolid: 'UNSUPPORTED_CSS',
    textPaintOrder: 'UNSUPPORTED_CSS',
    generatedBox: 'UNSUPPORTED_CSS',
    atomicBreak: 'PAGINATION_FAILED',
  });
  expect(evidence.fragmentedRects).toBeGreaterThan(1);
  // Explicit strict-mode fallback must remain local instead of rasterizing the entire paper.
  const explicitPages = await inspect(page, evidence.explicitBytes);
  expect(explicitPages).toHaveLength(1);
  expect(explicitPages[0]!.imagePaints).toBe(1);
  expect(explicitPages[0]!.imageSizes).toEqual([{ width: 840, height: 200 }]);
  expect(evidence.oversizedWarnings.some((warning) => warning.code === 'BREAK_AVOID_RELAXED')).toBe(
    true,
  );
  expect(evidence.oversizedPages).toBeGreaterThan(1);
  // A warning must accompany complete output, never a successful document with silently lost text.
  const oversizedPages = await inspect(page, evidence.oversizedBytes);
  expect(oversizedPages.every((pdfPage) => pdfPage.imagePaints === 0)).toBe(true);
  expect(
    oversizedPages
      .flatMap((pdfPage) => pdfPage.text.map((item) => item.text))
      .join('')
      .replace(/\s+/g, ''),
  ).toBe(evidence.oversizedText.replace(/\s+/g, ''));
});

test('default CSS omission preserves content while strictCss rejects unsupported decoration', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await loadFixture(page);
  const evidence = await page.evaluate(async () => {
    // Public options must behave consistently for native tables and local gradient rasters.
    const modulePath = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const root = document.querySelector<HTMLElement>('#hybrid')!;
    const fonts = (window as unknown as { hybridFonts: RegisteredFont[] }).hybridFonts;
    root.innerHTML = `
      <div style="background: linear-gradient(90deg, #dceefe, #e6f6e7); box-shadow: 0 4px 8px #345; padding: 12px">
        <small>Smaller Unicode text remains.</small>
      </div>
      <table style="border-collapse: collapse; box-shadow: 0 4px 8px #345">
        <tbody><tr style="background: #edf3fa"><td>First row.</td></tr>
        <tr><td>Second row.</td></tr></tbody>
      </table>`;
    const markup = root.innerHTML;
    const result = await api.renderPDF(root, { fonts, format: 'A4', margin: 24 });
    let strictError = 'NO_ERROR';
    try {
      await api.renderPDF(root, { fonts, format: 'A4', margin: 24, strictCss: true });
    } catch (error) {
      strictError = error instanceof api.RenderPDFError ? error.code : String(error);
    }
    return {
      bytes: Array.from(await result.toUint8Array()),
      markup,
      unchanged: root.innerHTML === markup,
      strictError,
    };
  });
  expect(evidence.unchanged).toBe(true);
  expect(evidence.strictError).toBe('UNSUPPORTED_CSS');
  const pages = await inspect(page, evidence.bytes);
  expect(pages).toHaveLength(1);
  expect(pages[0]!.imagePaints).toBe(1);
  const text = pages[0]!.text.map((item) => item.text).join('');
  for (const phrase of ['Smaller Unicode text remains.', 'First row.', 'Second row.']) {
    expect(text).toContain(phrase);
  }
});

test('the hybrid demo downloads a complete mixed PDF through its actual button', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  // Capture uncaught browser errors throughout font setup and the actual asynchronous UI flow.
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto('/tests/fixtures/hybrid.html');
  // The demo enables its action only after exact browser/PDF font registration is complete.
  const button = page.locator('#hybrid-export');
  await expect(button).toBeEnabled();
  // The real document stays caller-owned while controls and status update outside its root.
  const source = page.locator('#hybrid-source');
  // Preserve both authored markup and complete visible text before the user-facing action begins.
  const markup = await source.evaluate((element) => element.outerHTML);
  // Independent extraction must contain exactly the visible source, including automatic raster text.
  const sourceText = await source.innerText();
  // Register the event before clicking so the locally generated Blob download cannot be missed.
  const downloadPromise = page.waitForEvent('download');
  await button.click();
  // Inspect the user's real downloaded bytes rather than invoking a second rendering test hook.
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('renderpdf-hybrid-pages.pdf');
  await download.saveAs(testInfo.outputPath('hybrid-demo-download.pdf'));
  // A PDF header rejects accidentally returning HTML, an empty file or a displayed error message.
  const bytes = await readFile(testInfo.outputPath('hybrid-demo-download.pdf'));
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  // The independent parser verifies multipage text completeness and exactly two local captures.
  const pages = await inspect(page, Array.from(bytes));
  expect(pages.length).toBeGreaterThanOrEqual(3);
  expect(pages.reduce((sum, pdfPage) => sum + pdfPage.imagePaints, 0)).toBe(2);
  expect(
    pages
      .flatMap((pdfPage) => pdfPage.text.map((item) => item.text))
      .join('')
      .replace(/\s+/g, ''),
  ).toBe(sourceText.replace(/\s+/g, ''));
  await expect(page.locator('#hybrid-status')).toContainText('2 local raster regions');
  await expect(button).toBeEnabled();
  expect(await source.evaluate((element) => element.outerHTML)).toBe(markup);
  expect(browserErrors).toEqual([]);
});
