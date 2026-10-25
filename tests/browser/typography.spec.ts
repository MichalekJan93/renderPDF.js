import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { RenderPDFResult } from '../../src/index';
import type { InspectedPage } from './pdf-inspector';

/** Tight browser-measured text bounds keep blank page area out of the visual gate. */
interface Sample {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  page: number;
  text: string;
}

/** Copy exactly the same fixed-position CSS pixel interval from either renderer. */
function crop(image: PNG, x: number, y: number, width: number, height: number): PNG {
  const result = new PNG({ width, height });
  PNG.bitblt(image, result, x, y, width, height, 0, 0);
  return result;
}

/** Exclude antialias edges only; never translate, blur, or rescale either image. */
function differenceRatio(actual: PNG, expected: PNG, difference?: PNG): number {
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

test('multiple exact font faces retain kerning, ligatures, accents and wrapped text across pages', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.goto('/tests/fixtures/typography.html');
  await page.waitForFunction(() =>
    Boolean((window as unknown as { typography?: unknown }).typography),
  );
  const source = page.locator('#source');
  const browserImage = PNG.sync.read(await source.screenshot());
  const evidence = await page.evaluate(async () => {
    const root = document.querySelector<HTMLElement>('#source')!;
    const origin = root.getBoundingClientRect();
    const secondPageStart = document.querySelector('#second-page')!.getBoundingClientRect().top;
    const samples: Sample[] = Array.from(root.querySelectorAll('.sample')).map((element) => {
      // Range bounds cover text fragments, rather than the block's unused full width.
      const range = document.createRange();
      range.selectNodeContents(element);
      const bounds = range.getBoundingClientRect();
      const x = Math.max(0, Math.floor(bounds.left - origin.left) - 2);
      const y = Math.max(0, Math.floor(bounds.top - origin.top) - 2);
      return {
        id: element.id,
        x,
        y,
        width: Math.ceil(bounds.right - origin.left) + 2 - x,
        height: Math.ceil(bounds.bottom - origin.top) + 2 - y,
        page: bounds.top >= secondPageStart ? 1 : 0,
        text: element.textContent!.replace(/\s+/g, ' ').trim(),
      };
    });
    const api = (window as unknown as { typography: { export(): Promise<RenderPDFResult> } })
      .typography;
    const result = await api.export();
    const bytes = Array.from(await result.toUint8Array());
    const inspectorPath = '/tests/browser/pdf-inspector.ts';
    const inspector = (await import(
      /* @vite-ignore */ inspectorPath
    )) as typeof import('./pdf-inspector');
    return {
      bytes,
      pages: await inspector.inspectPdf(bytes),
      samples,
      secondPageStart: secondPageStart - origin.top,
    };
  });
  await writeFile(testInfo.outputPath('typography.pdf'), Buffer.from(evidence.bytes));
  await writeFile(testInfo.outputPath('browser-source.png'), PNG.sync.write(browserImage));
  const renderedPages = evidence.pages.map((pdfPage: InspectedPage) =>
    PNG.sync.read(Buffer.from(pdfPage.png.split(',')[1]!, 'base64')),
  );
  const measurements = [];
  for (const sample of evidence.samples) {
    const expected = crop(browserImage, sample.x, sample.y, sample.width, sample.height);
    const actual = crop(
      renderedPages[sample.page]!,
      24 + sample.x,
      Math.round(24 + sample.y - (sample.page === 1 ? evidence.secondPageStart : 0)),
      sample.width,
      sample.height,
    );
    const difference = new PNG({ width: sample.width, height: sample.height });
    const ratio = differenceRatio(actual, expected, difference);
    // These corruptions prove dense crops still expose displacement or missing glyphs.
    const shifted = new PNG({ width: sample.width, height: sample.height });
    shifted.data.fill(255);
    PNG.bitblt(expected, shifted, 0, 0, sample.width - 2, sample.height, 2, 0);
    const missing = new PNG({ width: sample.width, height: sample.height });
    missing.data.fill(255);
    measurements.push({
      id: sample.id,
      ratio,
      shiftedRatio: differenceRatio(shifted, expected),
      missingRatio: differenceRatio(missing, expected),
    });
    for (const [name, image] of [
      ['browser', expected],
      ['pdf', actual],
      ['difference', difference],
    ] as const)
      await writeFile(testInfo.outputPath(`${sample.id}-${name}.png`), PNG.sync.write(image));
  }
  await writeFile(
    testInfo.outputPath('metrics.json'),
    JSON.stringify(
      { chromium: browser.version(), measurements, samples: evidence.samples },
      null,
      2,
    ),
  );
  expect(evidence.pages).toHaveLength(2);
  const extractedText = evidence.pages.map((pdfPage) =>
    pdfPage.text
      .map((item) => item.text)
      .join('')
      .replace(/\s+/g, '')
      .normalize('NFC'),
  );
  for (const sample of evidence.samples)
    expect(extractedText[sample.page]).toContain(sample.text.replace(/\s+/g, '').normalize('NFC'));
  expect(
    new Set(evidence.pages.flatMap((pdfPage) => pdfPage.text.map((item) => item.fontName))).size,
  ).toBeGreaterThanOrEqual(4);
  expect(evidence.pages.flatMap((pdfPage) => pdfPage.imageSizes)).toEqual([]);
  for (const measurement of measurements) {
    expect(measurement.ratio, measurement.id).toBeLessThan(0.02);
    expect(measurement.shiftedRatio, `${measurement.id}: displacement sentinel`).toBeGreaterThan(
      0.05,
    );
    expect(measurement.missingRatio, `${measurement.id}: missing-text sentinel`).toBeGreaterThan(
      0.05,
    );
  }
});

test('unimplemented shaping controls reject explicitly instead of silently changing text', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/typography.html');
  await page.waitForFunction(() =>
    Boolean((window as unknown as { typography?: unknown }).typography),
  );
  const failures = await page.evaluate(async () => {
    const element = document.querySelector<HTMLElement>('#sans-kerning')!;
    const api = (window as unknown as { typography: { export(): Promise<RenderPDFResult> } })
      .typography;
    const controls = [
      ['font-feature-settings', '"liga" 0'],
      ['font-variant-ligatures', 'none'],
      ['font-variant-alternates', 'historical-forms'],
      ['hyphens', 'auto'],
      ['font-stretch', 'expanded'],
      ['font-size-adjust', '0.6'],
      ['text-rendering', 'optimizeSpeed'],
    ];
    const results = [];
    for (const [property, value] of controls) {
      element.style.setProperty(property!, value!);
      try {
        await api.export();
        results.push({ property, code: 'NO_ERROR', message: '' });
      } catch (error) {
        const failure = error as Error & { code: string };
        results.push({ property, code: failure.code, message: failure.message });
      } finally {
        element.style.removeProperty(property!);
      }
    }
    const original = element.textContent;
    try {
      element.textContent = 'Pří\u00adliš';
      await api.export();
      results.push({ property: 'soft hyphen', code: 'NO_ERROR', message: '' });
    } catch (error) {
      const failure = error as Error & { code: string };
      results.push({ property: 'soft hyphen', code: failure.code, message: failure.message });
    } finally {
      element.textContent = original;
    }
    try {
      element.innerHTML = 'of<span>fi</span>ce';
      await api.export();
      results.push({ property: 'split ligature', code: 'NO_ERROR', message: '' });
    } catch (error) {
      const failure = error as Error & { code: string };
      results.push({ property: 'split ligature', code: failure.code, message: failure.message });
    } finally {
      element.textContent = original;
    }
    return results;
  });
  for (const failure of failures) {
    expect(failure.code, `${failure.property}: ${failure.message}`).toBe('UNSUPPORTED_CSS');
    expect(failure.message).toMatch(/text|font|shaping/i);
  }
});
