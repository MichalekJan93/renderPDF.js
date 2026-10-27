import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { RenderPDFResult } from '../../src/index';
import type { InspectedPage } from './pdf-inspector';

/** Browser text range used as the pixel reference for one PDF crop. */
interface Sample {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  lineCount: number;
}

/** Copy the same fixed CSS-pixel rectangle from both renderers. */
function crop(image: PNG, x: number, y: number, width: number, height: number): PNG {
  const result = new PNG({ width, height });
  PNG.bitblt(image, result, x, y, width, height, 0, 0);
  return result;
}

/** Ignore only antialiasing differences, without moving or scaling either image. */
function differenceRatio(actual: PNG, expected: PNG): number {
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

/** PDF.js normalizes spaces between individually positioned glyphs. */
function compact(text: string): string {
  return text.replace(/\s+/g, '').normalize('NFC');
}

test('Latin, Cyrillic, simplified and traditional Chinese, and Arabic match browser pixels', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.goto('/tests/fixtures/multilingual.html');
  await page.waitForFunction(() =>
    Boolean((window as unknown as { multilingual?: unknown }).multilingual),
  );
  const source = page.locator('#source');
  const originalMarkup = await source.evaluate((element) => element.outerHTML);
  const browserImage = PNG.sync.read(await source.screenshot());
  const evidence = await page.evaluate(async () => {
    const root = document.querySelector<HTMLElement>('#source')!;
    const origin = root.getBoundingClientRect();
    const samples: Sample[] = Array.from(root.querySelectorAll<HTMLElement>('.sample')).map(
      (element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const bounds = range.getBoundingClientRect();
        const lines = new Set(
          Array.from(range.getClientRects(), (rect) => Math.round(rect.top * 2) / 2),
        );
        const x = Math.max(0, Math.floor(bounds.left - origin.left) - 2);
        const y = Math.max(0, Math.floor(bounds.top - origin.top) - 2);
        return {
          id: element.id,
          x,
          y,
          width: Math.ceil(bounds.right - origin.left) + 2 - x,
          height: Math.ceil(bounds.bottom - origin.top) + 2 - y,
          text: element.textContent!.trim(),
          lineCount: lines.size,
        };
      },
    );
    const api = (window as unknown as { multilingual: { export(): Promise<RenderPDFResult> } })
      .multilingual;
    const result = await api.export();
    const bytes = Array.from(await result.toUint8Array());
    const inspectorPath = '/tests/browser/pdf-inspector.ts';
    const inspector = (await import(
      /* @vite-ignore */ inspectorPath
    )) as typeof import('./pdf-inspector');
    return { bytes, pages: await inspector.inspectPdf(bytes), samples };
  });
  await writeFile(testInfo.outputPath('multilingual.pdf'), Buffer.from(evidence.bytes));
  await writeFile(testInfo.outputPath('browser-source.png'), PNG.sync.write(browserImage));
  expect(await source.evaluate((element) => element.outerHTML)).toBe(originalMarkup);
  expect(evidence.pages).toHaveLength(1);
  expect(evidence.pages[0]!.imagePaints).toBe(0);
  expect(evidence.samples.find((sample) => sample.id === 'chinese')!.lineCount).toBeGreaterThan(1);

  const pdfPage = evidence.pages[0]!;
  const extracted = compact(pdfPage.text.map((item) => item.text).join(''));
  for (const id of ['latin', 'cyrillic', 'chinese', 'traditional', 'arabic', 'arabic-digits']) {
    const sample = evidence.samples.find((item) => item.id === id)!;
    expect(extracted, `${id}: selectable Unicode text`).toContain(compact(sample.text));
  }
  // Mixed-direction text may be returned in visual item order; each logical run remains selectable.
  for (const run of ['تقرير رقم', 'Report 42', 'لعام', '2026'])
    expect(extracted, `mixed run ${run}`).toContain(compact(run));
  expect(new Set(pdfPage.text.map((item) => item.fontName)).size).toBeGreaterThanOrEqual(3);

  const rendered = PNG.sync.read(Buffer.from(pdfPage.png.split(',')[1]!, 'base64'));
  const measurements = [];
  for (const sample of evidence.samples) {
    const expected = crop(browserImage, sample.x, sample.y, sample.width, sample.height);
    const actual = crop(rendered, 24 + sample.x, 24 + sample.y, sample.width, sample.height);
    const ratio = differenceRatio(actual, expected);
    const blank = new PNG({ width: sample.width, height: sample.height });
    blank.data.fill(255);
    const missingRatio = differenceRatio(blank, expected);
    measurements.push({
      id: sample.id,
      mismatch: ratio,
      missingRatio,
      lineCount: sample.lineCount,
    });
    await writeFile(testInfo.outputPath(`${sample.id}-browser.png`), PNG.sync.write(expected));
    await writeFile(testInfo.outputPath(`${sample.id}-pdf.png`), PNG.sync.write(actual));
    expect(ratio, `${sample.id}: browser/PDF pixels`).toBeLessThan(0.04);
    expect(missingRatio, `${sample.id}: nonblank browser glyphs`).toBeGreaterThan(0.02);
  }
  await writeFile(
    testInfo.outputPath('metrics.json'),
    JSON.stringify({ chromium: browser.version(), measurements }, null, 2),
  );
});

test('Chinese header and Arabic footer stay native text on every page', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/tests/fixtures/multilingual.html');
  await page.waitForFunction(() =>
    Boolean((window as unknown as { multilingual?: unknown }).multilingual),
  );
  const pages = await page.evaluate(async (): Promise<InspectedPage[]> => {
    const api = (
      window as unknown as { multilingual: { exportWithBands(): Promise<RenderPDFResult> } }
    ).multilingual;
    const bytes = Array.from(await (await api.exportWithBands()).toUint8Array());
    const inspectorPath = '/tests/browser/pdf-inspector.ts';
    const inspector = (await import(
      /* @vite-ignore */ inspectorPath
    )) as typeof import('./pdf-inspector');
    return inspector.inspectPdf(bytes);
  });
  expect(pages).toHaveLength(1);
  for (const pdfPage of pages) {
    const text = compact(pdfPage.text.map((item) => item.text).join(''));
    expect(text).toContain('中文测试');
    expect(text).toContain('مرحبا');
    expect(pdfPage.imagePaints).toBe(0);
  }
});
