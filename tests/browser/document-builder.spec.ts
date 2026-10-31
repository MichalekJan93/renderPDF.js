// Unicode regression samples use explicit escapes to preserve the tested glyphs.
import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';

/** Accept a one-level RGB rounding difference between independent canvas and PDF decoders. */
function expectRgbNear(actual: number[], expected: readonly [number, number, number]): void {
  expect(actual).toHaveLength(expected.length);
  // Every channel retains a tight bound, so a missing or wrong-colored drawing still fails.
  for (let channel = 0; channel < expected.length; channel += 1)
    expect(Math.abs(actual[channel]! - expected[channel]!)).toBeLessThanOrEqual(1);
}

test('adapter snapshots loaded browser images and matches jsPDF text rotation directions', async ({
  page,
}, testInfo) => {
  await page.goto('/tests/fixtures/invoice.html');
  const bytes = await page.evaluate(async () => {
    const path = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ path)) as typeof import('../../src/index');
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 4;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#ff00ff';
    context.fillRect(0, 0, 8, 4);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((value) =>
        value ? resolve(value) : reject(new Error('Canvas encoding failed.')),
      ),
    );
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.src = url;
    await image.decode();
    const doc = await api.createJsPDFAdapter({ unit: 'pt', format: { width: 120, height: 90 } });
    doc.addImage(image, 'PNG', 10, 10, 20, 10);
    context.fillStyle = '#00ffff';
    context.fillRect(0, 0, 8, 4);
    image.src = canvas.toDataURL();
    URL.revokeObjectURL(url);
    doc.setFontSize(9);
    doc.text('CCW', 55, 65, { angle: 90 });
    doc.text('CW', 85, 35, { angle: 90, rotationDirection: 0 });
    return Array.from(await doc.toUint8Array());
  });
  const [output] = await page.evaluate(async (data) => {
    const path = '/tests/browser/pdf-inspector.ts';
    const { inspectPdf } = (await import(
      /* @vite-ignore */ path
    )) as typeof import('./pdf-inspector');
    return inspectPdf(data);
  }, bytes);
  expect(output!.imagePaints).toBe(1);
  expect(output!.text.find((item) => item.text === 'CCW')!.transform[1]).toBeGreaterThan(0);
  expect(output!.text.find((item) => item.text === 'CW')!.transform[1]).toBeLessThan(0);
  const png = PNG.sync.read(Buffer.from(output!.png.split(',')[1]!, 'base64'));
  const offset = (20 * png.width + 20) * 4;
  expectRgbNear(Array.from(png.data.slice(offset, offset + 3)), [255, 0, 255]);
  await writeFile(testInfo.outputPath('adapter-image-rotation.pdf'), Uint8Array.from(bytes));
});

test('document drawing, clipped vectors, bitmap placement and flattened Czech forms render together', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.goto('/tests/fixtures/invoice.html');
  const bytes = await page.evaluate(async () => {
    const path = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ path)) as typeof import('../../src/index');
    const font = await (await fetch('/fonts/NotoSans-Regular.ttf')).arrayBuffer();
    const doc = await api.createDocument({
      unit: 'px',
      format: { width: 240, height: 200 },
      fonts: [{ family: 'Report Sans', data: font }],
    });
    const first = doc.addPage();
    first.drawRectangle({ x: 0, y: 0, width: 240, height: 200, fill: '#ffffff' });
    first.drawText('\u010cesk\u00fd dokument', { x: 10, y: 35, font: 'Report Sans', fontSize: 16 });
    first.saveGraphicsState().clipRectangle({ x: 10, y: 60, width: 30, height: 30 });
    first.drawRectangle({ x: 0, y: 40, width: 90, height: 90, fill: '#ff0000' });
    first.restoreGraphicsState();
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 4;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#0000ff';
    context.fillRect(0, 0, 4, 4);
    context.fillStyle = '#00ff00';
    context.fillRect(4, 0, 4, 4);
    await first.drawImage(canvas, { x: 100, y: 60, width: 80, height: 40 });
    first.addTextField(
      'documentName',
      { x: 10, y: 120, width: 200, height: 25 },
      {
        value: 'P\u0159\u00edli\u0161 \u017elu\u0165ou\u010dk\u00fd',
        font: 'Report Sans',
        fontSize: 12,
      },
    );
    first.addLink('https://example.test/report', { x: 10, y: 10, width: 150, height: 30 });
    const second = doc.addPage({ format: { width: 120, height: 160 } });
    second.drawText('Second page', { x: 10, y: 25 });
    doc.addBookmark('P\u0159ehled', { pageNumber: 1 });
    for (const [index, output] of doc.getPages().entries()) {
      output.drawText('Printed by: test', { x: 10, y: output.height - 8, fontSize: 6 });
      output.drawText(`Page ${index + 1} of ${doc.pageCount}`, {
        x: output.width - 10,
        y: output.height - 8,
        fontSize: 6,
        align: 'right',
      });
    }
    doc.flattenForms();
    return Array.from(await (await doc.toResult()).toUint8Array());
  });
  await writeFile(testInfo.outputPath('document-api.pdf'), Uint8Array.from(bytes));
  const pages = await page.evaluate(async (data) => {
    const path = '/tests/browser/pdf-inspector.ts';
    const { inspectPdf } = (await import(
      /* @vite-ignore */ path
    )) as typeof import('./pdf-inspector');
    return inspectPdf(data);
  }, bytes);
  expect(pages).toHaveLength(2);
  expect(pages[0]!.width).toBe(240);
  expect(pages[1]!.width).toBe(120);
  expect(pages[0]!.text.map((item) => item.text).join(' ')).toContain('\u010cesk\u00fd dokument');
  expect(pages[0]!.text.map((item) => item.text).join(' ')).toContain(
    'P\u0159\u00edli\u0161 \u017elu\u0165ou\u010dk\u00fd',
  );
  expect(pages[0]!.text.map((item) => item.text).join(' ')).toContain('Page 1 of 2');
  expect(pages[1]!.text.map((item) => item.text).join(' ')).toContain('Page 2 of 2');
  expect(pages[0]!.imagePaints).toBe(1);
  const png = PNG.sync.read(Buffer.from(pages[0]!.png.split(',')[1]!, 'base64'));
  const sample = (x: number, y: number) =>
    Array.from(png.data.slice((y * png.width + x) * 4, (y * png.width + x) * 4 + 3));
  expectRgbNear(sample(20, 70), [255, 0, 0]);
  expectRgbNear(sample(50, 70), [255, 255, 255]);
  expectRgbNear(sample(110, 80), [0, 0, 255]);
  expectRgbNear(sample(170, 80), [0, 255, 0]);
  await writeFile(testInfo.outputPath('document-api.png'), PNG.sync.write(png));
});
