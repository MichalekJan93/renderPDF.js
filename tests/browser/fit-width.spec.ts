import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { RegisteredFont } from '../../src/index';

test('wide HTML fits uniformly with automatic landscape while retaining text and native image locality', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/tests/fixtures/invoice.html');
  // A synthetic wide document exposes scaling, page cuts, and image placement independently.
  const setup = await page.evaluate(async () => {
    const modulePath = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    // The same licensed fixture program controls browser layout and PDF text.
    const response = await fetch('/fonts/NotoSans-Regular.ttf');
    const font = await api.registerFont({ family: 'Fit Sans', data: await response.arrayBuffer() });
    const source = document.createElement('div');
    source.id = 'fit-source';
    source.style.cssText =
      "box-sizing:border-box;width:1500px;padding:12px;background:white;color:#203040;font:16px/28px 'Fit Sans'";
    // A small real PNG must remain local after scaling instead of becoming a full-page bitmap.
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 32;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#1a6fb0';
    context.fillRect(0, 0, 64, 32);
    context.fillStyle = '#f0a53c';
    context.fillRect(12, 6, 40, 20);
    const image = document.createElement('img');
    image.src = canvas.toDataURL('image/png');
    image.style.cssText = 'display:block;width:64px;height:32px';
    source.append(image);
    const stripe = document.createElement('div');
    stripe.style.cssText = 'height:32px;background:#dceaf5';
    source.append(stripe);
    // Distinct Czech rows show whether scaling loses, duplicates, or splits selectable text.
    for (let index = 1; index <= 65; index += 1) {
      const row = document.createElement('p');
      row.style.margin = '0';
      row.textContent = `Řádek ${String(index).padStart(3, '0')} – Příliš žluťoučký kůň.`;
      source.append(row);
    }
    document.body.append(source);
    await image.decode();
    await document.fonts.ready;
    (window as unknown as { fitFont: RegisteredFont }).fitFont = font;
    return { markup: source.outerHTML, text: source.innerText };
  });
  const evidence = await page.evaluate(async () => {
    const modulePath = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const source = document.querySelector<HTMLElement>('#fit-source')!;
    const font = (window as unknown as { fitFont: RegisteredFont }).fitFont;
    // Default behavior remains an explicit overflow rather than an implicit change in layout.
    let overflowCode = '';
    try {
      await api.renderPDF(source, { fonts: [font], format: 'A4', margin: 24 });
    } catch (error) {
      overflowCode = error instanceof api.RenderPDFError ? error.code : '';
    }
    const result = await api.renderPDF(source, {
      fonts: [font],
      format: 'A4',
      margin: 24,
      fit: 'width',
      orientation: 'auto',
    });
    return {
      overflowCode,
      bytes: Array.from(await result.toUint8Array()),
      pageCount: result.pageCount,
      markup: source.outerHTML,
    };
  });
  expect(evidence.overflowCode).toBe('SOURCE_OVERFLOW');
  expect(evidence.markup).toBe(setup.markup);
  const pages = await page.evaluate(async (bytes) => {
    const modulePath = '/tests/browser/pdf-inspector.ts';
    const inspector = (await import(
      /* @vite-ignore */ modulePath
    )) as typeof import('./pdf-inspector');
    return inspector.inspectPdf(bytes);
  }, evidence.bytes);
  expect(pages).toHaveLength(evidence.pageCount);
  expect(pages.length).toBeGreaterThan(1);
  // A4 landscape uses the original physical paper dimensions at 96 DPI.
  expect(pages[0]!.width).toBe(1123);
  expect(pages[0]!.height).toBe(794);
  const extracted = pages.flatMap((output) => output.text.map((item) => item.text)).join('');
  expect(extracted.replace(/\s+/g, '')).toBe(setup.text.replace(/\s+/g, ''));
  expect(extracted).toContain('žluťoučký');
  expect(pages.reduce((count, output) => count + output.imagePaints, 0)).toBe(1);
  expect(pages[0]!.imageSizes[0]).toEqual({ width: 64, height: 32 });
  for (let index = 1; index <= 65; index += 1) {
    const marker = `Řádek${String(index).padStart(3, '0')}`;
    expect(extracted.replace(/\s+/g, '').split(marker).length).toBe(2);
  }
  // Chromium paints a transformed reference at the exact physical scale used by the PDF.
  const scale = (1122.52 - 48) / 1500;
  await page.evaluate((sourceScale) => {
    const source = document.querySelector<HTMLElement>('#fit-source')!;
    const reference = source.cloneNode(true) as HTMLElement;
    reference.id = 'fit-reference';
    reference.style.position = 'absolute';
    reference.style.left = '0';
    reference.style.top = '2200px';
    reference.style.transformOrigin = 'top left';
    reference.style.transform = `scale(${sourceScale})`;
    document.body.append(reference);
  }, scale);
  const referenceImage = PNG.sync.read(await page.locator('#fit-reference').screenshot());
  const outputImage = PNG.sync.read(Buffer.from(pages[0]!.png.split(',')[1]!, 'base64'));
  const regionHeight = Math.min(220, referenceImage.height);
  const actual = new PNG({ width: referenceImage.width, height: regionHeight });
  const expected = new PNG({ width: referenceImage.width, height: regionHeight });
  PNG.bitblt(outputImage, actual, 24, 24, actual.width, actual.height, 0, 0);
  PNG.bitblt(referenceImage, expected, 0, 0, expected.width, expected.height, 0, 0);
  const mismatch =
    pixelmatch(actual.data, expected.data, null, actual.width, actual.height, {
      threshold: 0.1,
      includeAA: false,
    }) /
    (actual.width * actual.height);
  await writeFile(
    testInfo.outputPath('fit-width-metrics.json'),
    JSON.stringify(
      { pages: pages.length, sourceScale: scale, firstPageMismatch: mismatch },
      null,
      2,
    ),
  );
  expect(mismatch).toBeLessThan(0.06);
  await page.locator('#fit-reference').evaluate((element) => element.remove());
  expect(await page.locator('#fit-source').evaluate((element) => element.outerHTML)).toBe(
    setup.markup,
  );
});
