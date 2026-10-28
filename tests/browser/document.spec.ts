import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { ExperimentResult } from '../../experiments/pdf';
import type { RegisteredFont } from '../../src/index';
import type { InspectedPage } from './pdf-inspector';

/** Browser hooks belong to the local document experiment, not a published API. */
interface DocumentExperimentApi {
  /** Return the connected source inside the preview's style-isolated shadow root. */
  getSource: () => HTMLElement | null;
  /** Generate through the same RenderPDF path as the actual download button. */
  export: () => Promise<ExperimentResult>;
  /** Explicit font programs shared by DOM measurement and PDF text. */
  fonts: RegisteredFont[];
}

/** Decode independent PDF.js pixels without introducing another rendering implementation.
 * @param page Evidence produced from the downloaded PDF by PDF.js.
 */
function decodedPage(page: InspectedPage): PNG {
  return PNG.sync.read(Buffer.from(page.png.split(',')[1]!, 'base64'));
}

test('uploaded legacy tables download as selectable multipage PDF without split or lost rows', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  // This fixture is synthetic, so no real statement data enters versioned tests or evidence.
  const fixturePath = fileURLToPath(new URL('../fixtures/legacy-statement.html', import.meta.url));
  // A small static template keeps the tracked fixture readable while generating enough pages.
  const fixtureTemplate = await readFile(fixturePath, 'utf8');
  // Stable markers at both ends of each row expose duplication, loss, or page fragmentation.
  const fixtureRows = Array.from({ length: 180 }, (_, index) => {
    // Fixed-width identifiers prevent one row's marker from matching a different row.
    const identifier = String(index + 1).padStart(3, '0');
    return `<tr data-fixture-row="${identifier}"><td width="90"><font class="normal">ROW ${identifier} A</font></td><td width="85"><font class="normal">01.01.2020</font></td><td width="85"><font class="normal">31.12.2020</font></td><td width="45" align="right"><font class="normal">365</font></td><td><font class="normal">pojištění, česká diakritika</font></td><td width="90" align="right"><font class="normal">ROW ${identifier} B</font></td></tr>`;
  }).join('\n');
  // Uncaught exceptions and print invocations indicate a broken browser-only export flow.
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.addInitScript(() => {
    // Observe printing without opening a modal system dialog during integration tests.
    const state = window as unknown as { documentPrintCalls: number };
    state.documentPrintCalls = 0;
    window.print = () => {
      state.documentPrintCalls += 1;
    };
  });
  // Empty mode deliberately avoids loading a private default document on another machine.
  await page.goto('/tests/fixtures/document.html?empty=1');
  await page.waitForFunction(() =>
    Boolean(
      (window as unknown as { documentExperiment?: DocumentExperimentApi }).documentExperiment,
    ),
  );
  await page.locator('#document-file').setInputFiles({
    name: 'legacy-statement.html',
    mimeType: 'text/html',
    buffer: Buffer.from(fixtureTemplate.replace('<!-- SYNTHETIC_ROWS -->', fixtureRows)),
  });
  await page.waitForFunction(() => {
    // File loading and exact font registration finish before the source becomes exportable.
    const api = (window as unknown as { documentExperiment?: DocumentExperimentApi })
      .documentExperiment;
    return api?.getSource()?.textContent?.includes('Konec zkušebního výpisu.');
  });
  // The public-facing button must export the selected file rather than the Phase 0 demo.
  const button = page.getByRole('button', { name: 'Stáhnout PDF', exact: true });
  await expect(button).toBeEnabled();
  // Playwright's CSS locator traverses the preview's open shadow root.
  const source = page.locator('#document-source');
  // Preserve markup and browser pixels before either export path reads the source.
  const originalMarkup = await source.evaluate((element) => element.outerHTML);
  // This is Chromium's original table layout, not a reconstructed rendering reference.
  const sourceImage = PNG.sync.read(await source.screenshot());
  // Independent geometry evidence links every table row to one PDF source interval.
  const mapping = await page.evaluate(async () => {
    // The runner exposes original measured coordinates, not parsed PDF internals.
    const api = (window as unknown as { documentExperiment: DocumentExperimentApi })
      .documentExperiment;
    // The same immutable source is used again by the actual download button below.
    const result = await api.export();
    // Access the connected source through its owner instead of crossing shadow DOM manually.
    const source = api.getSource()!;
    // All row rectangles use the same root-relative CSS pixel origin as the writer.
    const origin = source.getBoundingClientRect();
    return {
      sourceText: source.innerText,
      slices: result.slices,
      textOperations: result.snapshot.operations.filter((operation) => operation.kind === 'text')
        .length,
      rows: Array.from(source.querySelectorAll<HTMLElement>('[data-fixture-row]'), (row) => {
        // The browser owns table/rowspan geometry; tests only inspect its result.
        const bounds = row.getBoundingClientRect();
        return {
          identifier: row.dataset.fixtureRow!,
          top: bounds.top - origin.top,
          bottom: bounds.bottom - origin.top,
        };
      }),
    };
  });
  // Listening precedes the click so the asynchronous Blob download cannot be missed.
  const downloadPromise = page.waitForEvent('download');
  await button.click();
  // Inspect the file the user receives, rather than accepting only a runner return value.
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
  await download.saveAs(testInfo.outputPath('legacy-statement.pdf'));
  // A real PDF header also rejects accidentally downloading the original HTML file.
  const bytes = await readFile(testInfo.outputPath('legacy-statement.pdf'));
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  // PDF.js is an independent development-only parser and renderer.
  const pages = await page.evaluate(async (serializedBytes) => {
    // The verification module is separate from the runtime conversion dependency graph.
    const inspectorPath = '/tests/browser/pdf-inspector.ts';
    // A browser URL is resolved by Vite, not TypeScript's filesystem module resolver.
    const inspector = (await import(
      /* @vite-ignore */ inspectorPath
    )) as typeof import('./pdf-inspector');
    return inspector.inspectPdf(serializedBytes);
  }, Array.from(bytes));
  // Preserve failure evidence before assertions about row placement or visual tolerance.
  await writeFile(testInfo.outputPath('legacy-source.png'), PNG.sync.write(sourceImage));
  await writeFile(testInfo.outputPath('legacy-mapping.json'), JSON.stringify(mapping, null, 2));
  expect(pages.length).toBeGreaterThanOrEqual(3);
  expect(pages).toHaveLength(mapping.slices.length);
  expect(mapping.rows).toHaveLength(180);
  expect(mapping.textOperations).toBeGreaterThan(180 * 2);
  expect(pages.reduce((sum, pdfPage) => sum + pdfPage.imagePaints, 0)).toBe(0);
  // Text extraction may contain generated space items between separately positioned words.
  const pageTexts = pages.map((pdfPage) =>
    pdfPage.text
      .map((item) => item.text)
      .join('')
      .replace(/\s+/g, ' '),
  );
  // These sentinels also verify diacritics and the final page after all table rows.
  const fullText = pageTexts.join('\n');
  expect(fullText.replace(/\s+/g, '')).toBe(mapping.sourceText.replace(/\s+/g, ''));
  expect(fullText.split('Příliš žluťoučký kůň úpěl ďábelské ódy.')).toHaveLength(2);
  expect(fullText.split('Konec zkušebního výpisu.')).toHaveLength(2);
  expect(pageTexts.at(-1)).toContain('Konec zkušebního výpisu.');
  for (const row of mapping.rows) {
    // Two unique markers at opposite ends expose both lost rows and row splitting.
    const firstMarker = `ROW ${row.identifier} A`;
    const lastMarker = `ROW ${row.identifier} B`;
    expect(fullText.split(firstMarker), firstMarker).toHaveLength(2);
    expect(fullText.split(lastMarker), lastMarker).toHaveLength(2);
    // Each browser row must fit wholly within one source-to-page interval.
    const pageIndex = mapping.slices.findIndex(
      (slice) => row.top >= slice.start - 0.01 && row.bottom <= slice.end + 0.01,
    );
    expect(pageIndex, `Atomic source interval for row ${row.identifier}`).toBeGreaterThanOrEqual(0);
    expect(pageTexts[pageIndex], firstMarker).toContain(firstMarker);
    expect(pageTexts[pageIndex], lastMarker).toContain(lastMarker);
  }
  // Visual comparison covers the table's borders, columns, font faces, and row geometry.
  const firstPage = decodedPage(pages[0]!);
  // White PDF margins frame the unmodified browser screenshot at the writer's 24px offset.
  const reference = new PNG({ width: firstPage.width, height: firstPage.height });
  reference.data.fill(255);
  PNG.bitblt(
    sourceImage,
    reference,
    0,
    0,
    sourceImage.width,
    Math.round(mapping.slices[0]!.end),
    24,
    24,
  );
  // Keep fixed antialias detection; no image alignment, blur, or font-specific masking is used.
  const mismatch =
    pixelmatch(firstPage.data, reference.data, null, firstPage.width, firstPage.height, {
      threshold: 0.1,
      includeAA: false,
    }) /
    (firstPage.width * firstPage.height);
  await writeFile(testInfo.outputPath('legacy-pdf-page-1.png'), PNG.sync.write(firstPage));
  await writeFile(testInfo.outputPath('legacy-browser-page-1.png'), PNG.sync.write(reference));
  await writeFile(
    testInfo.outputPath('legacy-metrics.json'),
    JSON.stringify(
      { pages: pages.length, rows: mapping.rows.length, firstPageMismatch: mismatch },
      null,
      2,
    ),
  );
  expect(mismatch).toBeLessThan(0.02);
  expect(await source.evaluate((element) => element.outerHTML)).toBe(originalMarkup);
  expect(
    await page.evaluate(
      () => (window as unknown as { documentPrintCalls: number }).documentPrintCalls,
    ),
  ).toBe(0);
  expect(browserErrors).toEqual([]);
  await expect(button).toBeEnabled();
});

test('active HTML is rejected without replacing the current local preview', async ({ page }) => {
  // Empty mode keeps the test independent of ignored user files and system fonts.
  await page.goto('/tests/fixtures/document.html?empty=1');
  await page.waitForFunction(() =>
    Boolean(
      (window as unknown as { documentExperiment?: DocumentExperimentApi }).documentExperiment,
    ),
  );
  // Start with an allowed local file so a rejected replacement cannot erase useful content.
  const input = page.locator('#document-file');
  await input.setInputFiles({
    name: 'static.html',
    mimeType: 'text/html',
    buffer: Buffer.from('<p>Bezpečný zkušební dokument.</p>'),
  });
  // The connected source is exposed only after validation and font loading succeed.
  const source = page.locator('#document-source');
  await expect(source).toContainText('Bezpečný zkušební dokument.');
  // Preserve the previous source to prove that rejecting an import is non-destructive.
  const originalMarkup = await source.evaluate((element) => element.outerHTML);
  await input.setInputFiles({
    name: 'active.html',
    mimeType: 'text/html',
    buffer: Buffer.from(
      '<script>window.documentPreviewExecuted = true;</script><p>Replacement</p>',
    ),
  });
  await expect(page.getByRole('status')).toContainText('pouze statické HTML');
  expect(await source.evaluate((element) => element.outerHTML)).toBe(originalMarkup);
  expect(
    await page.evaluate(
      () => (window as unknown as { documentPreviewExecuted?: boolean }).documentPreviewExecuted,
    ),
  ).toBeUndefined();
});
