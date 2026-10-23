import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { RenderPDFResult } from '../../src/index';

test('public API exports a mixed invoice with explicit fonts, custom pages and a real download', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.goto('/tests/fixtures/invoice.html');
  // Registering fonts is explicit setup; export itself must not require HTTP requests.
  const setup = await page.evaluate(async () => {
    // Vite resolves this public source entry without importing experiment internals.
    const modulePath = '/src/index.ts';
    // The contract is checked by TypeScript even though the browser owns module loading.
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    // Each family, weight and style selects its exact supplied font program.
    const faces = [
      { family: 'Invoice Sans', file: 'Regular', weight: 400, style: 'normal' as const },
      { family: 'Invoice Sans', file: 'Bold', weight: 700, style: 'normal' as const },
      { family: 'Invoice Accent', file: 'Italic', weight: 400, style: 'italic' as const },
    ];
    // Fetch each bundled licensed fixture asset before invoking runtime conversion.
    const fonts = await Promise.all(
      faces.map(async (face) => {
        // ArrayBuffer and Uint8Array are both part of the public registration boundary.
        const response = await fetch(`/fonts/NotoSans-${face.file}.ttf`);
        // Keep a caller-owned copy so the test can expose accidental byte aliasing.
        const bytes = new Uint8Array(await response.arrayBuffer());
        // The registered font must retain an independent snapshot of caller-supplied bytes.
        const registered = await api.registerFont({
          family: face.family,
          weight: face.weight,
          style: face.style,
          data: face.file === 'Regular' ? bytes.buffer : bytes,
        });
        bytes.fill(0);
        return registered;
      }),
    );
    // Stable markers at opposite row ends expose lost, duplicated or split rows.
    const rows = document.querySelector<HTMLTableSectionElement>('#invoice-rows')!;
    rows.innerHTML = Array.from({ length: 52 }, (_, index) => {
      // Fixed-width numbers ensure one row marker cannot match another row's identifier.
      const identifier = String(index + 1).padStart(3, '0');
      return `<tr><td>ITEM ${identifier} A</td><td>Česká položka, měření a ověření</td><td>ITEM ${identifier} B</td></tr>`;
    }).join('');
    // This inline PNG is a real native bitmap, independent from the explicit raster boundary.
    const canvas = document.createElement('canvas');
    canvas.width = 48;
    canvas.height = 32;
    // Distinct colors make a missing native image visible in retained PDF evidence.
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#1256a0';
    context.fillRect(0, 0, 48, 32);
    context.fillStyle = '#e59b31';
    context.fillRect(8, 8, 24, 16);
    // The local image requires no export-time network access.
    const image = document.querySelector<HTMLImageElement>('#invoice-logo')!;
    image.src = canvas.toDataURL('image/png');
    await image.decode();
    await document.fonts.ready;
    // The result is kept in this browser only for exercising its actual download method.
    (window as unknown as { invoiceFonts: typeof fonts }).invoiceFonts = fonts;
    return { expectedText: document.querySelector<HTMLElement>('#invoice')!.innerText };
  });
  // Preserve source markup after fixture setup and before library code measures it.
  const source = page.locator('#invoice');
  // Source ownership belongs to the caller, so export must preserve all authored nodes.
  const originalMarkup = await source.evaluate((element) => element.outerHTML);
  // Chromium's original pixels independently verify the public API's text and geometry output.
  const sourceImage = PNG.sync.read(await source.screenshot());
  // Only runtime conversion is observed; PDF.js and initial font setup use development HTTP.
  const requests: string[] = [];
  page.on('request', (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  // Generate through the same public entry consumers will import from the built library.
  const evidence = await page.evaluate(async () => {
    // Browser import paths deliberately remain independent of TypeScript's filesystem resolver.
    const modulePath = '/src/index.ts';
    // This cast checks every public method used by the integration test.
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    // Registered fonts are opaque tokens returned by the public registration function.
    const fonts = (
      window as unknown as { invoiceFonts: Parameters<typeof api.renderPDF>[1]['fonts'] }
    ).invoiceFonts;
    // Callback diagnostics and retained result diagnostics must agree for the same export.
    const callbackWarnings: string[] = [];
    // Non-default dimensions and asymmetric margins catch geometry options ignored by the writer.
    const result = await api.renderPDF(document.querySelector<HTMLElement>('#invoice')!, {
      fonts,
      format: 'Letter',
      orientation: 'landscape',
      margin: { top: 30, right: 28, bottom: 34, left: 40 },
      onWarning: (warning) => callbackWarnings.push(warning.code),
    });
    // A caller's byte edits cannot corrupt the stored PDF or later downloads.
    const firstBytes = await result.toUint8Array();
    firstBytes.fill(0);
    // Both output forms must retain a valid independent PDF payload.
    const bytes = await result.toUint8Array();
    // Reading the Blob verifies MIME type and the same exact generated document.
    const blob = await result.toBlob();
    // The window holds only local output, never private or external source data.
    (window as unknown as { invoiceResult: RenderPDFResult }).invoiceResult = result;
    return {
      bytes: Array.from(bytes),
      blobBytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
      blobType: blob.type,
      pageCount: result.pageCount,
      warnings: result.warnings,
      callbackWarnings,
    };
  });
  expect(requests).toEqual([]);
  expect(Buffer.from(evidence.bytes).subarray(0, 5).toString()).toBe('%PDF-');
  expect(evidence.blobType).toBe('application/pdf');
  expect(evidence.blobBytes).toEqual(evidence.bytes);
  expect(evidence.pageCount).toBeGreaterThanOrEqual(2);
  expect(
    evidence.warnings.some((warning) => /baseline|kerning|shaping/i.test(warning.message)),
  ).toBe(true);
  expect(evidence.callbackWarnings).toEqual(evidence.warnings.map((warning) => warning.code));
  // Inspect independent PDF text, page dimensions and local image paints after export completed.
  const pages = await page.evaluate(async (bytes) => {
    // PDF.js stays entirely inside development tests and never enters the runtime dependency graph.
    const inspectorPath = '/tests/browser/pdf-inspector.ts';
    // Vite serves this independent parser without exposing writer implementation details.
    const inspector = (await import(
      /* @vite-ignore */ inspectorPath
    )) as typeof import('./pdf-inspector');
    return inspector.inspectPdf(bytes);
  }, evidence.bytes);
  expect(pages).toHaveLength(evidence.pageCount);
  // Compare a fixed first-page region containing Flexbox, Grid, fonts, tables and the native PNG.
  const actual = new PNG({ width: sourceImage.width, height: 450 });
  // The browser reference uses equal scale, original coordinates and no alignment correction.
  const reference = new PNG({ width: sourceImage.width, height: 450 });
  // Decode the independent PDF.js image at 96 DPI, matching the browser screenshot's scale.
  const firstPage = PNG.sync.read(Buffer.from(pages[0]!.png.split(',')[1]!, 'base64'));
  PNG.bitblt(firstPage, actual, 40, 30, actual.width, actual.height, 0, 0);
  PNG.bitblt(sourceImage, reference, 0, 0, reference.width, reference.height, 0, 0);
  // Keep the existing antialias-aware gate so mostly blank margins cannot hide layout drift.
  const mismatch =
    pixelmatch(actual.data, reference.data, null, actual.width, actual.height, {
      threshold: 0.1,
      includeAA: false,
    }) /
    (actual.width * actual.height);
  await writeFile(testInfo.outputPath('api-pdf-region.png'), PNG.sync.write(actual));
  await writeFile(testInfo.outputPath('api-browser-region.png'), PNG.sync.write(reference));
  await writeFile(
    testInfo.outputPath('api-metrics.json'),
    JSON.stringify({ pages: pages.length, firstPageRegionMismatch: mismatch }, null, 2),
  );
  expect(mismatch).toBeLessThan(0.02);
  for (const pdfPage of pages) {
    // Letter landscape is 792 by 612 points, or 1056 by 816 CSS pixels at 96 DPI.
    expect(pdfPage.width).toBe(1056);
    expect(pdfPage.height).toBe(816);
    expect(pdfPage.text.length).toBeGreaterThan(0);
  }
  // Positioned PDF words may introduce extraction spaces, so compare all authored nonspaces.
  const fullText = pages.flatMap((pdfPage) => pdfPage.text.map((item) => item.text)).join('');
  expect(fullText.replace(/\s+/g, '')).toBe(setup.expectedText.replace(/\s+/g, ''));
  expect(fullText).toContain('žluťoučký');
  expect(fullText.split('Rastrové').length).toBe(2);
  expect(pages.reduce((sum, pdfPage) => sum + pdfPage.imagePaints, 0)).toBe(2);
  // Local raster output must stay substantially smaller than one complete page bitmap.
  for (const image of pages.flatMap((pdfPage) => pdfPage.imageSizes)) {
    expect(image.width).toBeLessThan(1056);
    expect(image.height).toBeLessThan(816);
  }
  // A third registered face must survive PDF font selection instead of matching only weight/style.
  expect(new Set(pages.flatMap((pdfPage) => pdfPage.text.map((item) => item.fontName))).size).toBe(
    3,
  );
  // The first heading begins 12px inside the root plus the custom 40px left PDF margin.
  const heading = pages[0]!.text.find((item) => item.text.includes('Zkušební'))!;
  expect(heading).toBeDefined();
  expect(heading.transform[4]).toBeCloseTo((40 + 12) * 0.75, 2);
  for (let index = 1; index <= 52; index += 1) {
    // Both ends must occur exactly once and remain together on the same physical PDF page.
    const identifier = String(index).padStart(3, '0');
    // Ignore PDF.js inserted spaces while retaining all unique row identifiers.
    const firstMarker = `ITEM${identifier}A`;
    // The final column's marker exposes a page cut crossing an otherwise intact row.
    const lastMarker = `ITEM${identifier}B`;
    // Per-page strings let the assertion catch rows fragmented between adjacent pages.
    const texts = pages.map((pdfPage) =>
      pdfPage.text
        .map((item) => item.text)
        .join('')
        .replace(/\s+/g, ''),
    );
    expect(
      texts.filter((text) => text.includes(firstMarker) && text.includes(lastMarker)),
    ).toHaveLength(1);
  }
  // Listen first because the public download method creates a local Blob URL asynchronously.
  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(async () => {
    await (window as unknown as { invoiceResult: RenderPDFResult }).invoiceResult.download(
      'synthetic-invoice.pdf',
    );
  });
  // The actual browser download must contain the same immutable PDF returned by both output methods.
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('synthetic-invoice.pdf');
  await download.saveAs(testInfo.outputPath('synthetic-invoice.pdf'));
  expect(Array.from(await readFile(testInfo.outputPath('synthetic-invoice.pdf')))).toEqual(
    evidence.bytes,
  );
  await writeFile(
    testInfo.outputPath('api-warnings.json'),
    JSON.stringify(evidence.warnings, null, 2),
  );
  expect(await source.evaluate((element) => element.outerHTML)).toBe(originalMarkup);
});

test('public diagnostics reject unavailable fonts, missing glyphs, overflow, cancellation and source mutation', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/invoice.html');
  // Each failure uses a bounded connected source rather than simulating internal renderer errors.
  const evidence = await page.evaluate(async () => {
    // Load only the public package entry; diagnostics must remain available to ordinary callers.
    const modulePath = '/src/index.ts';
    // Compile-time checking ensures these diagnostics exercise the actual exported contract.
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    // One real exact face is enough to distinguish missing glyphs from missing registrations.
    const response = await fetch('/fonts/NotoSans-Regular.ttf');
    // Explicit registration also waits until the matching browser FontFace is usable.
    const font = await api.registerFont({
      family: 'Diagnostic Sans',
      data: await response.arrayBuffer(),
    });
    // Replace the unrelated large invoice with a deterministic one-line browser source.
    const source = document.querySelector<HTMLElement>('#invoice')!;
    source.style.width = '600px';
    source.style.fontFamily = 'Diagnostic Sans';
    source.replaceChildren(document.createTextNode('Český kontrolní text.'));
    // Return structured evidence so failures cannot masquerade as a successful empty export.
    const errors: Record<string, { name: string; code: string; message: string }> = {};
    /** Capture the public diagnostic of a rejected asynchronous export.
     * @param label Identifier for the independently exercised failure condition.
     * @param operation Caller-visible operation expected to reject.
     */
    async function rejection(label: string, operation: () => Promise<unknown>): Promise<void> {
      try {
        await operation();
        errors[label] = { name: 'NO_ERROR', code: '', message: '' };
      } catch (error) {
        // Generic thrown values remain visible rather than crashing the evidence collector.
        errors[label] = {
          name: error instanceof Error ? error.name : '',
          code: error instanceof api.RenderPDFError ? error.code : '',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    // Browser fallback typography must never silently select a different PDF font program.
    source.style.fontFamily = 'Unregistered Invoice Face';
    await rejection('family', () => api.renderPDF(source, { fonts: [font] }));
    source.style.fontFamily = 'Diagnostic Sans';
    source.style.fontWeight = '700';
    await rejection('face', () => api.renderPDF(source, { fonts: [font] }));
    source.style.fontWeight = '400';
    // Noto Sans Latin does not contain this CJK glyph, although browser fallback may display it.
    source.textContent = 'Missing glyph 漢';
    await rejection('glyph', () => api.renderPDF(source, { fonts: [font] }));
    // A single unbroken word can visibly overflow even when the source border box fits the page.
    source.style.width = '100px';
    source.textContent = 'A'.repeat(180);
    await rejection('textOverflow', () => api.renderPDF(source, { fonts: [font] }));
    source.style.width = '600px';
    source.textContent = 'Český kontrolní text.';
    // Cancellation must be caller-visible before expensive layout or PDF construction begins.
    const controller = new AbortController();
    controller.abort();
    await rejection('aborted', () =>
      api.renderPDF(source, { fonts: [font], signal: controller.signal }),
    );
    await rejection('mutation', async () => {
      // The export snapshots asynchronously; a concurrent application edit invalidates its source.
      const pending = api.renderPDF(source, { fonts: [font] });
      source.textContent = 'Concurrent source change.';
      return pending;
    });
    // CSSOM edits have no MutationObserver record but can invalidate already measured paint styles.
    const stylesheet = document.styleSheets[0]!;
    await rejection('stylesheet', () =>
      api.renderPDF(source, {
        fonts: [font],
        onWarning: () => {
          stylesheet.insertRule(
            '#invoice { color: rgb(101, 22, 17); }',
            stylesheet.cssRules.length,
          );
        },
      }),
    );
    // Creating an empty pseudo box changes paint state without adding DOM nodes or visible text.
    const pseudoRuleIndex = stylesheet.cssRules.length;
    await rejection('pseudoStylesheet', () =>
      api.renderPDF(source, {
        fonts: [font],
        onWarning: () => {
          stylesheet.insertRule(
            '#invoice::before { content: ""; display: inline-block; width: 8px; height: 8px; background: rgb(31, 70, 103); }',
            pseudoRuleIndex,
          );
        },
      }),
    );
    stylesheet.deleteRule(pseudoRuleIndex);
    // Cancellation from the warning callback happens after preparation, before output is committed.
    const callbackController = new AbortController();
    await rejection('callbackAbort', () =>
      api.renderPDF(source, {
        fonts: [font],
        signal: callbackController.signal,
        onWarning: () => callbackController.abort(),
      }),
    );
    return errors;
  });
  expect(evidence.family!.name).toBe('RenderPDFError');
  expect(evidence.family!.code).toBe('MISSING_FONT');
  expect(evidence.family!.message).toContain('Unregistered Invoice Face');
  expect(evidence.face!.code).toBe('MISSING_FONT');
  expect(evidence.face!.message).toContain('700');
  expect(evidence.glyph!.code).toBe('MISSING_GLYPH');
  expect(evidence.glyph!.message).toMatch(/漢|U\+6F22/i);
  expect(evidence.textOverflow!.code).toBe('SOURCE_OVERFLOW');
  expect(evidence.aborted!.name).toBe('AbortError');
  expect(evidence.mutation!.code).toBe('SOURCE_CHANGED');
  expect(evidence.stylesheet!.code).toBe('SOURCE_CHANGED');
  expect(evidence.pseudoStylesheet!.code).toBe('SOURCE_CHANGED');
  expect(evidence.callbackAbort!.name).toBe('AbortError');
});

test('native JPEG resources preserve selectable text and require readable same-origin or CORS bytes', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/invoice.html');
  // Generate fixture bytes locally so this test neither contacts an image service nor tracks a binary.
  const jpegData = await page.evaluate(() => {
    // Canvas generates an ordinary orientation-free JPEG with deterministic bounded dimensions.
    const canvas = document.createElement('canvas');
    canvas.width = 48;
    canvas.height = 32;
    // Two colors expose missing image content without depending on a private fixture asset.
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#2672a1';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#f6b835';
    context.fillRect(12, 8, 24, 16);
    return canvas.toDataURL('image/jpeg').split(',')[1]!;
  });
  // The same-origin fixture stays local; cross-origin policies are exercised by a real loopback server.
  const jpegBytes = Buffer.from(jpegData, 'base64');
  await page.route('**/native-fixture.jpg', (route) =>
    route.fulfill({ status: 200, contentType: 'image/jpeg', body: jpegBytes }),
  );
  // CDP-fulfilled responses can bypass Chromium CORS checks, so use a genuine HTTP origin here.
  const imageServer = createServer((request, response) => {
    response.setHeader('Content-Type', 'image/jpeg');
    if (request.url === '/allowed.jpg') response.setHeader('Access-Control-Allow-Origin', '*');
    response.end(jpegBytes);
  });
  await new Promise<void>((resolve, reject) => {
    imageServer.once('error', reject);
    imageServer.listen(0, '127.0.0.1', () => {
      imageServer.off('error', reject);
      resolve();
    });
  });
  try {
    // The OS chooses an unused local port; the server is unreachable from external network interfaces.
    const address = imageServer.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected a loopback TCP address.');
    // A distinct port is a real cross-origin boundary even though both servers use the same loopback IP.
    const imageOrigin = `http://127.0.0.1:${address.port}`;
    // The public image pipeline must fetch original compressed bytes rather than rasterizing the page.
    const evidence = await page.evaluate(async (imageOrigin) => {
      // Vite serves the public entry while preserving strict compile-time API checks.
      const modulePath = '/src/index.ts';
      // No experiment internals participate in source preparation or output validation.
      const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
      // The source uses one supplied exact program for its native selectable text.
      const response = await fetch('/fonts/NotoSans-Regular.ttf');
      // Registration is shared by all resource cases in this one browser document.
      const font = await api.registerFont({
        family: 'Resource Sans',
        data: await response.arrayBuffer(),
      });
      // A narrow connected source fits default A4 without introducing unrelated page geometry errors.
      const source = document.querySelector<HTMLElement>('#invoice')!;
      source.style.width = '600px';
      source.style.fontFamily = 'Resource Sans';
      // Use only ordinary text plus one bitmap, with no explicit raster fallback boundary.
      const paragraph = document.createElement('p');
      paragraph.textContent = 'Český obrázek JPEG.';
      // Fixed CSS geometry makes the expected native image paint size independently measurable.
      const image = document.createElement('img');
      image.width = 48;
      image.height = 32;
      image.style.display = 'block';
      source.replaceChildren(paragraph, image);
      // Preserve output bytes from both readable resource policies for independent PDF.js inspection.
      const successful: number[][] = [];
      for (const url of ['/native-fixture.jpg', `${imageOrigin}/allowed.jpg`]) {
        image.src = url;
        await image.decode();
        // Loading succeeds before export, so the read policy is tested independently of DOM decoding.
        const result = await api.renderPDF(source, { fonts: [font] });
        successful.push(Array.from(await result.toUint8Array()));
      }
      // Browser display of a no-CORS image does not authorize reading its compressed bytes for PDF.
      image.src = `${imageOrigin}/blocked.jpg`;
      await image.decode();
      try {
        await api.renderPDF(source, { fonts: [font] });
        return { successful, rejectedCode: 'NO_ERROR', rejectedMessage: '' };
      } catch (error) {
        return {
          successful,
          rejectedCode: error instanceof api.RenderPDFError ? error.code : '',
          rejectedMessage: error instanceof Error ? error.message : String(error),
        };
      }
    }, imageOrigin);
    expect(evidence.successful).toHaveLength(2);
    for (const bytes of evidence.successful) {
      // Independent parsing checks that bitmap support does not replace the selectable text layer.
      const pages = await page.evaluate(async (serializedBytes) => {
        // PDF.js remains a development-only consumer of the complete public PDF output.
        const inspectorPath = '/tests/browser/pdf-inspector.ts';
        // Vite resolves this test module without coupling the inspector to renderer internals.
        const inspector = (await import(
          /* @vite-ignore */ inspectorPath
        )) as typeof import('./pdf-inspector');
        return inspector.inspectPdf(serializedBytes);
      }, bytes);
      expect(pages).toHaveLength(1);
      expect(
        pages[0]!.text
          .map((item) => item.text)
          .join('')
          .replace(/\s+/g, ''),
      ).toBe('ČeskýobrázekJPEG.');
      expect(pages[0]!.imagePaints).toBe(1);
      expect(pages[0]!.imageSizes).toEqual([{ width: 48, height: 32 }]);
    }
    expect(evidence.rejectedCode).toBe('RESOURCE_LOAD_FAILED');
    expect(evidence.rejectedMessage).toMatch(/CORS|readable/i);
  } finally {
    // Release the ephemeral listener after both success and any failed browser assertion.
    await new Promise<void>((resolve, reject) => {
      imageServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
