import { expect, test, type Download } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Ignore only whitespace synthesized between independently positioned PDF words.
 * @param text Original Unicode text from the browser or PDF extraction.
 */
function compact(text: string): string {
  return text.replace(/\s+/g, '');
}

/** Give synthetic snippets an explicit bundled face without changing tested HTML behavior. */
function withSampleFont(
  /** Static HTML fragment supplied through the public editor or upload control. */
  html: string,
): string {
  return `<style>body { font-family: 'Playground Sans'; }</style>${html}`;
}

/** Independently inspect the actual download without importing the converter source.
 * @param bytes Complete bytes written by the browser's download action.
 */
async function inspectPdf(
  bytes: Uint8Array,
  /** Skip graphics decoding for large text-only extraction checks. */
  inspectGraphics = true,
): Promise<{
  texts: string[];
  imagePaints: number;
  /** Encoded bitmap dimensions in physical pixels, independent of page size. */
  imageSizes: { width: number; height: number }[];
  /** First text origin on page one, in PDF points. */
  firstTextX: number;
}> {
  // PDF.js owns parser resources; no font fetching or browser-side test hooks are needed.
  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    disableFontFace: true,
    stopAtErrors: true,
  });
  // Preserve page boundaries so a correct text stream cannot hide broken pagination.
  const texts: string[] = [];
  // Count actual paints rather than image resources or alpha masks.
  let imagePaints = 0;
  // Retain image dimensions to reject replacing the whole page with one screenshot.
  const imageSizes: { width: number; height: number }[] = [];
  // The first origin checks that both libraries use one 18pt margin, not two.
  let firstTextX = Number.NaN;
  try {
    // The public document lifecycle is released even when parsing fails.
    const document = await loadingTask.promise;
    // Page numbers in PDF.js are one based.
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      // Text and graphics operations provide independent evidence of hybrid output.
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      if (pageNumber === 1) {
        const firstText = content.items.find((item) => 'str' in item && item.str.trim());
        if (firstText && 'transform' in firstText) firstTextX = firstText.transform[4]!;
      }
      // Marked-content entries do not contribute printable Unicode characters.
      texts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(''));
      if (inspectGraphics) {
        const operators = await page.getOperatorList();
        // Inline and named images both represent visible local raster paints.
        imagePaints += operators.fnArray.filter(
          (operation) =>
            operation === OPS.paintImageXObject || operation === OPS.paintInlineImageXObject,
        ).length;
        for (const [index, operation] of operators.fnArray.entries()) {
          if (operation === OPS.paintImageXObject || operation === OPS.paintInlineImageXObject) {
            // Named image operands provide their encoded width and height after the object identifier.
            const operands = operators.argsArray[index] as unknown[];
            imageSizes.push({ width: Number(operands[1]), height: Number(operands[2]) });
          }
        }
      }
      page.cleanup();
    }
    return { texts, imagePaints, imageSizes, firstTextX };
  } finally {
    await loadingTask.destroy();
  }
}

// The browser and output directory are Playwright-owned resources for the full consumer flow.
test('fresh full HTML compares two downloads while preserving RenderPDF.js text and local raster', async ({
  page,
}, testInfo) => {
  // Capture uncaught errors before loading fonts and the production application.
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto('/', { waitUntil: 'networkidle' });
  // The initial authored example has matching bundled faces and can export immediately.
  const downloadButton = page.locator('#export-pdfs');
  await expect(downloadButton).toBeEnabled();
  // The initial example must not leak into an immediately requested replacement export.
  const firstPage =
    'Fresh document output Unicode sample: \u011B\u0161\u010D\u0159\u017E\u00FD\u00E1\u00ED\u00E9\u016F\u00FA\u010F\u0165\u0148\u00F3\u010C. Exact bold line. Italic text line. A local gradient preserves this text exactly once.';
  const secondPage =
    'Second page Final line: \u011B\u0161\u010D\u0159\u017E\u00FD\u00E1\u00ED\u00E9\u016F\u00FA\u010F\u0165\u0148\u00F3\u010C.';
  // Complete documents exercise head styles and body mapping inside the isolated preview.
  const html = `<!doctype html>
    <html lang="en"><head><title>Private title outside the PDF</title><style>
      :root { --accent: #5b2158; }
      body { margin: 0; color: #274257; font: 16px/1.5 'Playground Sans'; }
      [data-note="my body content"] { color: var(--accent); }
      main { padding: 16px; }
      h1 { font-size: 24px; }
      #test-card { background: linear-gradient(90deg, #e0f2fe, #d1fae5); padding: 16px; }
      #test-second { break-before: page; }
    </style></head><body><main>
      <section><h1 data-note="my body content">Fresh document output</h1>
      <p id="test-first">Unicode sample: \u011B\u0161\u010D\u0159\u017E\u00FD\u00E1\u00ED\u00E9\u016F\u00FA\u010F\u0165\u0148\u00F3\u010C.</p>
      <p><strong>Exact bold line.</strong> <em>Italic text line.</em></p>
      <div id="test-card">A local gradient preserves this text exactly once.</div></section>
      <section id="test-second"><h2>Second page</h2>
      <p>Final line: \u011B\u0161\u010D\u0159\u017E\u00FD\u00E1\u00ED\u00E9\u016F\u00FA\u010F\u0165\u0148\u00F3\u010C.</p></section>
    </main></body></html>`;
  // All resources are already local and registered; conversion must not upload the input.
  const exportRequests: string[] = [];
  page.on('request', (request) => {
    if (/^https?:/.test(request.url())) exportRequests.push(`${request.method()} ${request.url()}`);
  });
  await page.locator('#html-input').fill(html);
  // Register before clicking and deliberately avoid waiting for the preview debounce.
  const downloads: Download[] = [];
  page.on('download', (download) => downloads.push(download));
  await downloadButton.click();
  await expect.poll(() => downloads.length).toBe(2);
  // Inspect the same file the user receives rather than a separate programmatic export.
  const download = downloads.find((item) => item.suggestedFilename() === 'renderpdf.pdf')!;
  const jsPdfDownload = downloads.find((item) => item.suggestedFilename() === 'jspdf.pdf')!;
  const outputPath = testInfo.outputPath('consumer-download.pdf');
  await download.saveAs(outputPath);
  const jsPdfPath = testInfo.outputPath('jspdf-download.pdf');
  await jsPdfDownload.saveAs(jsPdfPath);
  // The PDF header rejects a failed HTML response or an accidentally empty download.
  const bytes = await readFile(outputPath);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  const jsPdfBytes = await readFile(jsPdfPath);
  expect(jsPdfBytes.subarray(0, 5).toString()).toBe('%PDF-');
  const jsPdfEvidence = await inspectPdf(jsPdfBytes);
  expect(jsPdfEvidence.texts.join('')).toContain(
    '\u011B\u0161\u010D\u0159\u017E\u00FD\u00E1\u00ED\u00E9\u016F\u00FA\u010F\u0165\u0148\u00F3\u010C',
  );
  // Independent extraction proves exact page ownership and local raster composition.
  const evidence = await inspectPdf(bytes);
  expect(jsPdfEvidence.firstTextX).toBeCloseTo(evidence.firstTextX, 0);
  expect(evidence.texts.map(compact)).toEqual([compact(firstPage), compact(secondPage)]);
  expect(evidence.imagePaints).toBe(1);
  expect(evidence.texts.join('')).not.toContain('Export and compare PDFs');
  // Playwright traverses the open shadow root without exposing application internals.
  const preview = page.locator('#preview-host').locator('[data-preview-body]');
  // Raster scale is two; at most one CSS pixel carries fractional-origin capture padding.
  const rasterBounds = await preview.locator('#test-card').boundingBox();
  expect(rasterBounds).not.toBeNull();
  expect(evidence.imageSizes[0]!.width).toBeGreaterThanOrEqual(Math.floor(rasterBounds!.width * 2));
  expect(evidence.imageSizes[0]!.width).toBeLessThanOrEqual(Math.ceil(rasterBounds!.width + 1) * 2);
  expect(evidence.imageSizes[0]!.height).toBeGreaterThanOrEqual(
    Math.floor(rasterBounds!.height * 2),
  );
  expect(evidence.imageSizes[0]!.height).toBeLessThanOrEqual(
    Math.ceil(rasterBounds!.height + 1) * 2,
  );
  await expect(preview.locator('#test-first')).toHaveCSS('color', 'rgb(39, 66, 87)');
  await expect(preview.locator('h1')).toHaveCSS('color', 'rgb(91, 33, 88)');
  await expect(preview.locator('#test-second')).toContainText('Second page');
  await expect(page.locator('#warnings li')).not.toHaveCount(0);
  await expect(downloadButton).toBeEnabled();
  // Both measured sizes must match the bytes delivered to the browser.
  await expect(page.locator('#render-result')).toContainText(bytes.length.toLocaleString('en-US'));
  await expect(page.locator('#jspdf-result')).toContainText(
    jsPdfBytes.length.toLocaleString('en-US'),
  );
  await expect(page.locator('#render-result')).toContainText(/\d+\.\d{2} s/);
  await expect(page.locator('#jspdf-result')).toContainText(/\d+\.\d{2} s/);
  await expect(page.locator('#winner')).toContainText('Smaller file:');
  await expect(page.getByRole('status')).toContainText('Both PDFs have been downloaded');
  // Dynamic jsPDF chunks and local fonts may be fetched, but no document request leaves this app.
  expect(exportRequests.every((request) => request.startsWith('GET http://127.0.0.1:5181/'))).toBe(
    true,
  );
  expect(browserErrors).toEqual([]);
});

// The bundled directory guards against turning every rounded row marker into a bitmap.
test('bundled 200-row directory keeps every ID and bounds raster captures', async ({
  page,
}, testInfo) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  // The live preview owns the complete synthetic fixture before either export starts.
  const preview = page.locator('#preview-host').locator('[data-preview-body]');
  await expect(preview.locator('tbody tr')).toHaveCount(200);
  const downloadButton = page.locator('#export-pdfs');
  await expect(downloadButton).toBeEnabled();
  // Inspect the package consumer's actual download, not an internal rendering shortcut.
  const downloadPromise = page.waitForEvent('download', {
    predicate: (download) => download.suggestedFilename() === 'renderpdf.pdf',
  });
  await downloadButton.click();
  const download = await downloadPromise;
  const outputPath = testInfo.outputPath('directory-renderpdf.pdf');
  await download.saveAs(outputPath);
  const evidence = await inspectPdf(await readFile(outputPath));
  // Every table marker must remain selectable exactly once and in source order.
  const actualIds = evidence.texts
    .map(compact)
    .join('')
    .match(/#USR-\d{3}/g);
  const expectedIds = Array.from(
    { length: 200 },
    (_, index) => `#USR-${String(index + 1).padStart(3, '0')}`,
  );
  expect(actualIds).toEqual(expectedIds);
  // The header and four metric cards retain their local raster effects; rows stay vector.
  expect(evidence.imagePaints).toBe(5);
  await expect(page.locator('#warnings li').filter({ hasText: 'RASTER_FALLBACK' })).toHaveCount(5);
  await expect(page.locator('#warnings')).not.toContainText('Automatic raster fallback on SPAN');
  await expect(page.locator('#render-result')).toContainText('Done');
});

// Both bundled sources must follow the selected example through preview, export, edits and reset.
test('example selector loads and resets each authored source', async ({ page }, testInfo) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  // Public controls and the shadow-root preview are the same surfaces a user sees.
  const select = page.locator('#example-select');
  const input = page.locator('#html-input');
  const preview = page.locator('#preview-host').locator('[data-preview-body]');
  const exportButton = page.locator('#export-pdfs');
  const results = page.locator('#results');
  await expect(select.locator('option')).toHaveText([/Example 1/, /Example 2/]);
  await expect(select).toHaveValue('example-1');
  await expect(input).toHaveValue(/Global User Directory/);
  await expect(preview.locator('h1')).toContainText('User Profiles & Global Statistics');
  await expect(preview.locator('tbody tr')).toHaveCount(200);
  // A completed export gives the switch a stale result to clear.
  await input.fill(withSampleFont('<p>Temporary comparison before switching examples.</p>'));
  await exportButton.click();
  await expect(page.locator('#render-result')).toContainText('Done');
  await expect(results).toBeVisible();

  await select.selectOption('example-2');
  await expect(input).toHaveValue(/Product Inventory List/);
  await expect(preview.locator('h2')).toHaveText('Product Inventory List');
  await expect(preview.locator('tbody tr')).toHaveCount(1000);
  await expect(results).toBeHidden();
  await expect(exportButton).toBeEnabled();

  await input.fill(withSampleFont('<p>Edited inventory source.</p>'));
  await page.locator('#reset-example').click();
  await expect(select).toHaveValue('example-2');
  await expect(input).toHaveValue(/Product Inventory List/);
  await expect(preview.locator('tbody tr')).toHaveCount(1000);

  // Times stays in the authored CSS; no matching font is uploaded or passed to RenderPDF.js.
  await expect(exportButton).toBeEnabled();
  await expect(page.locator('#font-mismatch')).toHaveValue('fallback');
  await expect(page.locator('#font-requirements')).toContainText('Times New Roman');
  await expect(page.locator('#registered-fonts')).not.toContainText('Times New Roman');
  await expect(page.locator('#status')).toContainText('report any font substitutions');
  const productNames = await preview.locator('tbody tr td:nth-child(2)').allTextContents();
  expect(productNames).toHaveLength(1000);
  const downloadPromise = page.waitForEvent('download', {
    predicate: (download) => download.suggestedFilename() === 'renderpdf.pdf',
  });
  await exportButton.click();
  await expect(page.locator('#render-result')).toContainText('Done');
  await expect(page.locator('#warnings')).toContainText('FONT_SUBSTITUTED');
  await expect(page.locator('#warnings')).toContainText('RenderPDF Base');
  const download = await downloadPromise;
  const outputPath = testInfo.outputPath('example-2-renderpdf.pdf');
  await download.saveAs(outputPath);
  const extracted = compact((await inspectPdf(await readFile(outputPath), false)).texts.join(''));
  // One scan catches omitted, split, reordered or duplicated labels without quadratic matching.
  const expectedNames = productNames.map(compact);
  expect(expectedNames.every((name) => /Model\d+$/.test(name))).toBe(true);
  const prefixes = [...new Set(expectedNames.map((name) => name.replace(/Model\d+$/, '')))];
  const escapedPrefixes = prefixes.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const actualNames =
    extracted.match(new RegExp(`(?:${escapedPrefixes.join('|')})Model\\d+`, 'g')) ?? [];
  expect(actualNames).toEqual(expectedNames);

  // The same no-font source is rejected when the public mismatch option requires exact faces.
  await page.locator('#font-mismatch').selectOption('error');
  await expect(exportButton).toBeEnabled();
  await exportButton.click();
  await expect(page.locator('#render-result')).toContainText('Error');
  await expect(page.locator('#render-result')).toContainText('Times New Roman');

  await select.selectOption('example-1');
  await expect(input).toHaveValue(/Global User Directory/);
  await expect(preview.locator('tbody tr')).toHaveCount(200);
  await expect(results).toBeHidden();
  await expect(exportButton).toBeEnabled();
});

// The comparison must expose font substitutions while allowing optional exact TTF registration.
test('font mismatch can fail RenderPDF.js, then exact uploaded faces remove the mismatch', async ({
  page,
}, testInfo) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const input = page.locator('#html-input');
  const exportButton = page.locator('#export-pdfs');
  // Browser default serif cannot identify one exact PDF program, but fallback stays available.
  await input.fill('<p>Default serif must be reported.</p>');
  await page.locator('#refresh-preview').click();
  await expect(exportButton).toBeEnabled();
  await expect(page.locator('#font-requirements')).toContainText('Generic font family serif');

  // A custom family with normal and bold text needs both exact programs.
  const text = 'Registered Unicode sample: \u011B\u0161\u010D\u0159\u017E\u00FD.';
  await input.fill(
    `<style>body{font-family:'Fixture Face'}</style><p>${text} <strong>Bold face.</strong></p>`,
  );
  await page.locator('#refresh-preview').click();
  await expect(page.locator('#font-requirements')).toContainText('Fixture Face · 400 normal');
  await expect(page.locator('#font-requirements')).toContainText('Fixture Face · 700 normal');
  await expect(exportButton).toBeEnabled();
  await page.locator('#font-mismatch').selectOption('error');
  await exportButton.click();
  await expect(page.locator('#render-result')).toContainText('Error');
  await expect(page.locator('#render-result')).toContainText('Fixture Face');
  await expect(page.locator('#jspdf-result')).toContainText('Done');
  const fontFile = page.locator('#font-file');
  for (const face of [
    { file: 'Regular', weight: 400 },
    { file: 'Bold', weight: 700 },
  ]) {
    const bytes = await readFile(
      new URL(`../public/fonts/NotoSans-${face.file}.ttf`, import.meta.url),
    );
    await page.locator('#font-family').fill('Fixture Face');
    await page.locator('#font-weight').fill(String(face.weight));
    await fontFile.setInputFiles({
      name: `Fixture-${face.file}.ttf`,
      mimeType: 'font/ttf',
      buffer: bytes,
    });
    await page.locator('#register-font').click();
    await expect(page.locator('#font-status')).toContainText(
      `Registered Fixture Face ${face.weight} normal`,
    );
    if (face.weight === 400) {
      await expect(page.locator('#font-requirements')).toContainText('Fixture Face · 700 normal');
      await expect(exportButton).toBeEnabled();
    }
  }
  await expect(page.locator('#font-requirements')).toBeHidden();
  await expect(exportButton).toBeEnabled();
  await expect(page.locator('#preview-host').locator('p')).toHaveCSS(
    'font-family',
    '"Fixture Face"',
  );

  const downloads: Download[] = [];
  page.on('download', (download) => downloads.push(download));
  await exportButton.click();
  await expect.poll(() => downloads.length).toBe(2);
  for (const [name, filename] of [
    ['renderpdf.pdf', 'registered-renderpdf.pdf'],
    ['jspdf.pdf', 'registered-jspdf.pdf'],
  ] as const) {
    const download = downloads.find((item) => item.suggestedFilename() === name)!;
    const path = testInfo.outputPath(filename);
    await download.saveAs(path);
    const extracted = compact((await inspectPdf(await readFile(path))).texts.join(''));
    expect(extracted).toContain(compact(`${text} Bold face.`));
  }
  await expect(page.locator('#render-result')).toContainText('Done');
  await expect(page.locator('#jspdf-result')).toContainText('Done');
});

// A text-free document needs no matching CSS face; the app can pass its minimal base handle.
test('image-only source exports with the application base font handle', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page
    .locator('#html-input')
    .fill('<div style="width: 72px; height: 72px; background: #1264a3"></div>');
  await page.locator('#refresh-preview').click();
  await expect(page.locator('#font-requirements')).toBeHidden();
  await expect(page.locator('#export-pdfs')).toBeEnabled();
  await page.locator('#export-pdfs').click();
  await expect(page.locator('#render-result')).toContainText('Done');
  await expect(page.locator('#jspdf-result')).toContainText('Done');
});

// Optional profiling must account for the displayed total without changing the normal export path.
test('stage profiling is opt-in and accounts for the measured RenderPDF.js total', async ({
  page,
}) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  // The short synthetic document keeps this check about measurement, not renderer throughput.
  const input = page.locator('#html-input');
  const profile = page.locator('#profile-stages');
  const verification = page.locator('#source-verification');
  const details = page.locator('#render-profile');
  const exportButton = page.locator('#export-pdfs');
  await expect(profile).not.toBeChecked();
  await expect(verification).toHaveValue('mutations');
  await expect(details).toBeHidden();
  await input.fill(withSampleFont('<p>Profiled Unicode sample: &#269;.</p>'));
  await profile.check();
  await exportButton.click();
  await expect(page.locator('#render-result')).toContainText('Done');
  await expect(page.locator('#jspdf-result')).toContainText('Done');
  await expect(page.locator('#render-label')).toContainText('Fast static HTML');
  await expect(page.locator('#warnings')).toContainText('SOURCE_VERIFICATION_REDUCED');
  await expect(details).toBeVisible();
  // Every public work stage appears once, followed by unreported work and Blob creation.
  const labels = await details.locator('dt').allTextContents();
  expect(labels).toEqual([
    'Preparing',
    'Layout',
    'Pagination',
    'Resources',
    'Pages',
    'Saving',
    'Other / handoffs',
    'Blob creation',
  ]);
  const values = await details.locator('dd').allTextContents();
  expect(values).toHaveLength(labels.length);
  for (const value of values) expect(value).toMatch(/^\d+\.\d ms$/);
  // The table rounds to hundredths of a second and each detail to one millisecond decimal.
  const detailedTotalMs = values.reduce((sumMs, value) => sumMs + Number.parseFloat(value), 0);
  const totalText = await page.locator('#render-result td').first().textContent();
  const displayedTotalMs = Number.parseFloat(totalText ?? '') * 1_000;
  expect(Math.abs(detailedTotalMs - displayedTotalMs)).toBeLessThan(10);
  // Turning profiling off removes its prior measurements and leaves the default export usable.
  await profile.uncheck();
  await expect(details).toBeHidden();
  await expect(page.locator('#results')).toBeHidden();
  await exportButton.click();
  await expect(page.locator('#render-result')).toContainText('Done');
  await expect(page.locator('#jspdf-result')).toContainText('Done');
  await expect(details).toBeHidden();
  // Full mode restores the stronger guard and clears the reduced-verification diagnostic.
  await verification.selectOption('full');
  await expect(page.locator('#results')).toBeHidden();
  await exportButton.click();
  await expect(page.locator('#render-result')).toContainText('Done');
  await expect(page.locator('#render-label')).toContainText('Full CSS guard');
  await expect(page.locator('#warnings')).not.toContainText('SOURCE_VERIFICATION_REDUCED');
});

// A complete legacy document exercises harmless metadata and discarded fonts through the public UI.
test('legacy metadata and document font declarations preserve preview and Czech PDF text', async ({
  page,
}, testInfo) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  // User font sources must never be requested when the preview substitutes its registered Noto faces.
  const rejectedRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('example.invalid')) rejectedRequests.push(request.url());
  });
  // Mixed-case metadata and a source-less Office-style font rule reproduce common legacy markup.
  const text =
    'Legacy document: Unicode sample: \u011B\u0161\u010D\u0159\u017E\u00FD\u00E1\u00ED\u00E9\u016F\u00FA\u010F\u0165\u0148\u00F3\u010C.';
  const html = `<html lang="en"><head>
    <meta http-equiv="Content-Language" content="en">
    <meta http-equiv="CONTENT-TYPE" content="text/html; charset=windows-1250">
    <style>
      @font-face { font-family: "Legacy Face"; panose-1: 2 11 6 4 3 5 4 4 2 4; }
      @media screen {
        @supports (display: block) {
          @font-face {
            font-family: "Ignored Remote Face";
            src: url('https://example.invalid/ignored.woff2') format('woff2');
          }
        }
        body { color: #274257; }
      }
      body { margin: 0; font-family: "Playground Sans"; }
      .normal { font-size: 14px; }
    </style></head><body><p><font class="normal">${text}</font></p></body></html>`;
  // Refreshing explicitly makes the expected preview independent of debounce timing.
  const downloadButton = page.locator('#export-pdfs');
  const preview = page.locator('#preview-host').locator('[data-preview-body]');
  await expect(downloadButton).toBeEnabled();
  await page.locator('#html-input').fill(html);
  await page.locator('#refresh-preview').click();
  await expect(preview).toHaveText(text);
  await expect(preview.locator('font')).toHaveCSS('font-size', '14px');
  await expect(preview.locator('font')).toHaveCSS('color', 'rgb(39, 66, 87)');
  await expect(page.locator('#warnings')).toContainText('document @font-face declaration');
  await expect(downloadButton).toBeEnabled();
  // Inspect the user's downloaded bytes rather than treating a visible preview as proof of export.
  const downloadPromise = page.waitForEvent('download');
  await downloadButton.click();
  const download = await downloadPromise;
  const outputPath = testInfo.outputPath('legacy-metadata-download.pdf');
  await download.saveAs(outputPath);
  const bytes = await readFile(outputPath);
  const evidence = await inspectPdf(bytes);
  expect(evidence.texts.map(compact)).toEqual([compact(text)]);
  expect(evidence.imagePaints).toBe(0);
  expect(rejectedRequests).toEqual([]);
});

// Uploading a file must feed the same isolated preview and both PDF paths.
test('uploaded HTML becomes the preview and produces both measured PDFs', async ({
  page,
}, testInfo) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  // A synthetic UTF-8 file checks the browser File API without touching private documents.
  const text =
    'Uploaded Unicode sample: \u011B\u0161\u010D\u0159\u017E\u00FD\u00E1\u00ED\u00E9\u016F\u00FA\u010F\u0165\u0148\u00F3\u010C.';
  await page.locator('#html-file').setInputFiles({
    name: 'comparison.html',
    mimeType: 'text/html',
    buffer: Buffer.from(
      `<html><head><style>body{font-family:'Playground Sans'}</style></head><body><p>${text}</p></body></html>`,
      'utf8',
    ),
  });
  await expect(page.locator('#preview-host').locator('[data-preview-body]')).toHaveText(text);
  const downloads: Download[] = [];
  page.on('download', (download) => downloads.push(download));
  await page.locator('#export-pdfs').click();
  await expect.poll(() => downloads.length).toBe(2);
  const renderDownload = downloads.find((item) => item.suggestedFilename() === 'renderpdf.pdf')!;
  const renderPath = testInfo.outputPath('uploaded-renderpdf.pdf');
  await renderDownload.saveAs(renderPath);
  const evidence = await inspectPdf(await readFile(renderPath));
  expect(compact(evidence.texts.join(''))).toBe(compact(text));
  await expect(page.locator('#render-result')).toContainText('Done');
  await expect(page.locator('#jspdf-result')).toContainText('Done');
  // A rejected replacement must keep the last valid HTML and export control intact.
  await page.locator('#html-file').setInputFiles({
    name: 'invalid.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Ignored', 'utf8'),
  });
  await expect(page.getByRole('status')).toContainText('Choose an .html');
  await expect(page.locator('#preview-host').locator('[data-preview-body]')).toHaveText(text);
  await expect(page.locator('#export-pdfs')).toBeEnabled();
});

// The comparison UI exposes the library's optional CSS rejection policy.
test('CSS checkbox switches between a completed export and strict rejection', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page
    .locator('#html-input')
    .fill(withSampleFont('<p style="box-shadow: 0 3px 6px #345">Shadow.</p>'));
  await page.locator('#export-pdfs').click();
  await expect(page.locator('#render-result')).toContainText('Done');
  await page.locator('#strict-css').check();
  await page.locator('#export-pdfs').click();
  await expect(page.locator('#render-result')).toContainText('Error');
  await expect(page.locator('#render-result')).toContainText('outer shadows');
});

// Authored forced breaks can be ignored explicitly without changing or losing source text.
test('page-break checkbox fills the first page when authored breaks are disabled', async ({
  page,
}, testInfo) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  // Two short sections fit together, so a second page can only come from the authored rule.
  const firstSection = 'First short section.';
  const secondSection = 'Second section. The content continues.';
  await page.locator('#html-input').fill(
    withSampleFont(`<p>${firstSection}</p>
    <h2 style="break-before: page; page-break-before: always">Second section.</h2>
    <p>The content continues.</p>`),
  );
  // Default CSS mode must remain available for documents that deliberately start a new chapter.
  const respectPageBreaks = page.locator('#respect-page-breaks');
  await expect(respectPageBreaks).toBeChecked();
  for (const respect of [true, false]) {
    await respectPageBreaks.setChecked(respect);
    // Filter the real browser event so the subsequent jsPDF download cannot replace this evidence.
    const downloadPromise = page.waitForEvent('download', {
      predicate: (download) => download.suggestedFilename() === 'renderpdf.pdf',
    });
    await page.locator('#export-pdfs').click();
    const download = await downloadPromise;
    const outputPath = testInfo.outputPath(respect ? 'authored-break.pdf' : 'automatic-break.pdf');
    await download.saveAs(outputPath);
    const evidence = await inspectPdf(await readFile(outputPath));
    expect(evidence.texts.map(compact)).toEqual(
      respect
        ? [compact(firstSection), compact(secondSection)]
        : [compact(firstSection + secondSection)],
    );
  }
});

// The page fixture exercises validation solely through the controls available to a user.
test('active markup clears preview while missing images remain visible until corrected', async ({
  page,
}) => {
  await page.goto('/');
  // Stable public controls expose validity without calling an internal sanitizer or renderer.
  const input = page.locator('#html-input');
  const refreshButton = page.locator('#refresh-preview');
  const downloadButton = page.locator('#export-pdfs');
  const preview = page.locator('#preview-host').locator('[data-preview-body]');
  const status = page.getByRole('status');
  await expect(downloadButton).toBeEnabled();
  await input.fill('<p>Invalid document</p><script>document.title = "EXECUTED"</script>');
  await refreshButton.click();
  await expect(downloadButton).toBeDisabled();
  await expect(preview).toHaveCount(0);
  await expect(status).not.toBeEmpty();
  await expect(page).not.toHaveTitle('EXECUTED');
  // Rejected external URLs must never start a network request, including in the preview.
  const rejectedRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('example.invalid')) rejectedRequests.push(request.url());
  });
  await input.fill('<p>External image</p><img src="https://example.invalid/private.png">');
  await refreshButton.click();
  await expect(downloadButton).toBeDisabled();
  await expect(preview).toContainText('External image');
  await expect(preview.locator('[data-preview-missing-image]')).toContainText(
    'https://example.invalid/private.png',
  );
  await expect(page.locator('#warnings')).toBeVisible();
  await expect(page.locator('#warnings')).toContainText('PNG/JPEG');
  await expect(status).not.toBeEmpty();
  // Missing relative files and unsupported formats also expose a placeholder without hiding the text.
  for (const imageSource of ['missing.gif', 'data:image/gif;base64,R0lGODlhAQABAAAAACw=']) {
    await input.fill(`<p>Document with an unavailable image.</p><img src="${imageSource}">`);
    await refreshButton.click();
    await expect(preview).toContainText('Document with an unavailable image.');
    await expect(preview.locator('[data-preview-missing-image]')).toHaveCount(1);
    await expect(downloadButton).toBeDisabled();
  }
  // Passive metadata allowances cannot permit navigation, executable attributes or CSS requests.
  for (const forbiddenHtml of [
    '<style>@scope (:host) { p { color: red; } }</style><p>Scope escape</p>',
    '<meta http-equiv="Refresh" content="0;url=https://example.invalid/redirect"><p>Redirection</p>',
    '<p onclick="document.title = &quot;EXECUTED&quot;">Event handler</p>',
    '<style>p { background-image: url("https://example.invalid/background.png"); }</style><p>Background</p>',
  ]) {
    await input.fill(forbiddenHtml);
    await refreshButton.click();
    await expect(downloadButton).toBeDisabled();
    await expect(preview).toHaveCount(0);
    await expect(status).not.toBeEmpty();
  }
  expect(rejectedRequests).toEqual([]);
  // Empty input cannot leave a stale valid preview available for downloading.
  await input.fill('   ');
  await refreshButton.click();
  await expect(downloadButton).toBeDisabled();
  await expect(preview).toHaveCount(0);
  // A valid body fragment restores both the isolated preview and the real download action.
  await input.fill(withSampleFont('<p>Corrected document.</p>'));
  await refreshButton.click();
  await expect(preview).toHaveText('Corrected document.');
  await expect(downloadButton).toBeEnabled();
  // Reset remains a normal user action and restores the bundled sample after custom input.
  await page.locator('#reset-example').click();
  await expect(input).not.toHaveValue(withSampleFont('<p>Corrected document.</p>'));
  await expect(downloadButton).toBeEnabled();
});
