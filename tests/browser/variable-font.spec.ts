import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { RenderPDFResult } from '../../src/index';
import type { InspectedPage } from './pdf-inspector';

/** Default Roboto axes must remain selectable and visually close to browser paint. */
test('default variable Roboto retains Czech text and browser-aligned pixels', async ({
  page,
}, testInfo) => {
  await page.goto('/tests/fixtures/variable-font.html');
  await page.waitForFunction(() =>
    Boolean((window as unknown as { variableFontProbe?: unknown }).variableFontProbe),
  );
  // Capture browser pixels only after the exact registered face finished loading.
  const source = page.locator('#source');
  const browserImage = PNG.sync.read(await source.screenshot());
  const evidence = await page.evaluate(async () => {
    // The fixture's public renderer and PDF.js inspector run in the same browser context.
    const probe = (
      window as unknown as { variableFontProbe: { export(): Promise<RenderPDFResult> } }
    ).variableFontProbe;
    const result = await probe.export();
    const bytes = Array.from(await result.toUint8Array());
    const inspectorPath = '/tests/browser/pdf-inspector.ts';
    const inspector = (await import(
      /* @vite-ignore */ inspectorPath
    )) as typeof import('./pdf-inspector');
    return { pages: await inspector.inspectPdf(bytes), warnings: result.warnings };
  });
  expect(evidence.pages).toHaveLength(1);
  const inspected = evidence.pages[0] as InspectedPage;
  const extracted = inspected.text
    .map((item) => item.text)
    .join('')
    .replace(/\s+/g, '')
    .normalize('NFC');
  expect(extracted).toContain('Přílišžluťoučkýkůňúpělďábelskéódy.');
  expect(extracted).toContain('Vědeckázprávaměříčitelnéznakyazalomenítextu.');
  const pdfImage = PNG.sync.read(Buffer.from(inspected.png.split(',')[1]!, 'base64'));
  const pdfCrop = new PNG({ width: browserImage.width, height: browserImage.height });
  PNG.bitblt(pdfImage, pdfCrop, 24, 24, browserImage.width, browserImage.height, 0, 0);
  const changedPixels = pixelmatch(
    pdfCrop.data,
    browserImage.data,
    null,
    browserImage.width,
    browserImage.height,
    { threshold: 0.1, includeAA: false },
  );
  const differenceRatio = changedPixels / (browserImage.width * browserImage.height);
  await writeFile(
    testInfo.outputPath('variable-font-metrics.json'),
    JSON.stringify(
      { differenceRatio, width: browserImage.width, height: browserImage.height },
      null,
      2,
    ),
  );
  expect(differenceRatio).toBeLessThan(0.03);
  expect(evidence.warnings.some((warning) => warning.code === 'TEXT_METRICS_APPROXIMATED')).toBe(
    true,
  );
});
