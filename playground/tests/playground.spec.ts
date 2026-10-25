import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Ignore only whitespace synthesized between independently positioned PDF words.
 * @param text Original Unicode text from the browser or PDF extraction.
 */
function compact(text: string): string {
  return text.replace(/\s+/g, '');
}

/** Independently inspect the actual download without importing the converter source.
 * @param bytes Complete bytes written by the browser's download action.
 */
async function inspectPdf(bytes: Uint8Array): Promise<{
  texts: string[];
  imagePaints: number;
  /** Encoded bitmap dimensions in physical pixels, independent of page size. */
  imageSizes: { width: number; height: number }[];
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
  try {
    // The public document lifecycle is released even when parsing fails.
    const document = await loadingTask.promise;
    // Page numbers in PDF.js are one based.
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      // Text and graphics operations provide independent evidence of hybrid output.
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const operators = await page.getOperatorList();
      // Marked-content entries do not contribute printable Unicode characters.
      texts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(''));
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
      page.cleanup();
    }
    return { texts, imagePaints, imageSizes };
  } finally {
    await loadingTask.destroy();
  }
}

// The browser and output directory are Playwright-owned resources for the full consumer flow.
test('fresh full HTML downloads with Czech text, page breaks and one local raster', async ({
  page,
}, testInfo) => {
  // Capture uncaught errors before loading fonts and the production application.
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto('/', { waitUntil: 'networkidle' });
  // Export becomes available only after all exact font programs are registered.
  const downloadButton = page.locator('#download-pdf');
  await expect(downloadButton).toBeEnabled();
  // The initial example must not leak into an immediately requested replacement export.
  const firstPage =
    'Čerstvý český výstup Příliš žluťoučký kůň úpěl ďábelské ódy. Tučný přesný řádek. Kurzíva české řeči. Lokální přechod zachová text právě jednou.';
  const secondPage = 'Druhá stránka Poslední řádek: ěščřžýáíéůúďťň.';
  // Complete documents exercise head styles and body mapping inside the isolated preview.
  const html = `<!doctype html>
    <html lang="cs"><head><title>Soukromý titulek mimo PDF</title><style>
      :root { --accent: #5b2158; }
      body { margin: 0; color: #274257; font: 16px/1.5 Georgia; }
      [data-note="my body content"] { color: var(--accent); }
      main { padding: 16px; }
      h1 { font-size: 24px; }
      #test-card { background: linear-gradient(90deg, #e0f2fe, #d1fae5); padding: 16px; }
      #test-second { break-before: page; }
    </style></head><body><main>
      <section><h1 data-note="my body content">Čerstvý český výstup</h1>
      <p id="test-first">Příliš žluťoučký kůň úpěl ďábelské ódy.</p>
      <p><strong>Tučný přesný řádek.</strong> <em>Kurzíva české řeči.</em></p>
      <div id="test-card">Lokální přechod zachová text právě jednou.</div></section>
      <section id="test-second"><h2>Druhá stránka</h2>
      <p>Poslední řádek: ěščřžýáíéůúďťň.</p></section>
    </main></body></html>`;
  // All resources are already local and registered; conversion must not upload the input.
  const exportRequests: string[] = [];
  page.on('request', (request) => {
    if (/^https?:/.test(request.url())) exportRequests.push(`${request.method()} ${request.url()}`);
  });
  await page.locator('#html-input').fill(html);
  // Register before clicking and deliberately avoid waiting for the preview debounce.
  const downloadPromise = page.waitForEvent('download');
  await downloadButton.click();
  // Inspect the same file the user receives rather than a separate programmatic export.
  const download = await downloadPromise;
  const outputPath = testInfo.outputPath('consumer-download.pdf');
  await download.saveAs(outputPath);
  // The PDF header rejects a failed HTML response or an accidentally empty download.
  const bytes = await readFile(outputPath);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  // Independent extraction proves exact page ownership and local raster composition.
  const evidence = await inspectPdf(bytes);
  expect(evidence.texts.map(compact)).toEqual([compact(firstPage), compact(secondPage)]);
  expect(evidence.imagePaints).toBe(1);
  expect(evidence.texts.join('')).not.toContain('Stáhnout PDF');
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
  await expect(preview.locator('#test-second')).toContainText('Druhá stránka');
  await expect(page.locator('#warnings li')).not.toHaveCount(0);
  await expect(downloadButton).toBeEnabled();
  // The browser reports the completed click-to-download processing time rather than a benchmark estimate.
  await expect(page.getByRole('status')).toContainText(/Čas exportu: \d+\.\d{2} s\./);
  expect(exportRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
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
  const text = 'Český starší dokument: Příliš žluťoučký kůň úpěl ďábelské ódy.';
  const html = `<html lang="cs"><head>
    <meta http-equiv="Content-Language" content="cs">
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
      body { margin: 0; font-family: "Legacy Face"; }
      .normal { font-size: 14px; }
    </style></head><body><p><font class="normal">${text}</font></p></body></html>`;
  // Refreshing explicitly makes the expected preview independent of debounce timing.
  const downloadButton = page.locator('#download-pdf');
  const preview = page.locator('#preview-host').locator('[data-preview-body]');
  await expect(downloadButton).toBeEnabled();
  await page.locator('#html-input').fill(html);
  await page.locator('#refresh-preview').click();
  await expect(preview).toHaveText(text);
  await expect(preview.locator('font')).toHaveCSS('font-size', '14px');
  await expect(preview.locator('font')).toHaveCSS('color', 'rgb(39, 66, 87)');
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

// The page fixture exercises validation solely through the controls available to a user.
test('active markup clears preview while missing images remain visible until corrected', async ({
  page,
}) => {
  await page.goto('/');
  // Stable public controls expose validity without calling an internal sanitizer or renderer.
  const input = page.locator('#html-input');
  const refreshButton = page.locator('#refresh-preview');
  const downloadButton = page.locator('#download-pdf');
  const preview = page.locator('#preview-host').locator('[data-preview-body]');
  const status = page.getByRole('status');
  await expect(downloadButton).toBeEnabled();
  await input.fill('<p>Neplatný dokument</p><script>document.title = "EXECUTED"</script>');
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
  await input.fill('<p>Externí obrázek</p><img src="https://example.invalid/private.png">');
  await refreshButton.click();
  await expect(downloadButton).toBeDisabled();
  await expect(preview).toContainText('Externí obrázek');
  await expect(preview.locator('[data-preview-missing-image]')).toContainText(
    'https://example.invalid/private.png',
  );
  await expect(page.locator('#warnings')).toBeVisible();
  await expect(page.locator('#warnings')).toContainText('PNG/JPEG');
  await expect(status).not.toBeEmpty();
  // Missing relative files and unsupported formats also expose a placeholder without hiding the text.
  for (const imageSource of ['missing.gif', 'data:image/gif;base64,R0lGODlhAQABAAAAACw=']) {
    await input.fill(`<p>Dokument bez dostupného obrázku.</p><img src="${imageSource}">`);
    await refreshButton.click();
    await expect(preview).toContainText('Dokument bez dostupného obrázku.');
    await expect(preview.locator('[data-preview-missing-image]')).toHaveCount(1);
    await expect(downloadButton).toBeDisabled();
  }
  // Passive metadata allowances cannot permit navigation, executable attributes or CSS requests.
  for (const forbiddenHtml of [
    '<meta http-equiv="Refresh" content="0;url=https://example.invalid/redirect"><p>Přesměrování</p>',
    '<p onclick="document.title = &quot;EXECUTED&quot;">Obsluha události</p>',
    '<style>p { background-image: url("https://example.invalid/background.png"); }</style><p>Pozadí</p>',
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
  await input.fill('<p>Opravený český dokument.</p>');
  await refreshButton.click();
  await expect(preview).toHaveText('Opravený český dokument.');
  await expect(downloadButton).toBeEnabled();
  // Reset remains a normal user action and restores the bundled sample after custom input.
  await page.locator('#reset-example').click();
  await expect(input).not.toHaveValue('<p>Opravený český dokument.</p>');
  await expect(downloadButton).toBeEnabled();
});
