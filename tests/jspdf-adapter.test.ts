import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vite-plus/test';
import { decodePDFRawStream, PDFArray, PDFDocument, PDFRawStream } from 'pdf-lib';
import { PNG } from 'pngjs';
import { createJsPDFAdapter } from '../src/jspdf-adapter.js';

/** Read actual page operators so ordering and clipping checks exercise the written PDF. */
function pageOperators(pdf: PDFDocument, pageNumber = 0): string {
  const contents = pdf.getPage(pageNumber).node.Contents();
  const references = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  return references
    .map((reference) => {
      const stream = pdf.context.lookup(reference);
      if (!(stream instanceof PDFRawStream)) throw new Error('Expected a saved PDF stream.');
      return new TextDecoder().decode(decodePDFRawStream(stream).decode());
    })
    .join('\n');
}

/** Generate a public synthetic image rather than importing private example documents. */
function whitePixel(): Uint8Array {
  const image = new PNG({ width: 1, height: 1 });
  image.data.fill(255);
  return Uint8Array.from(PNG.sync.write(image));
}

describe('prepared DevExtreme PDF facade', () => {
  it('preserves units, current-page selection and mixed page dimensions', async () => {
    const doc = await createJsPDFAdapter({ unit: 'mm', format: 'A4', orientation: 'landscape' });
    expect(doc.internal.scaleFactor).toBeCloseTo(72 / 25.4, 10);
    expect(doc.internal.pageSize.getWidth()).toBeCloseTo(297, 1);
    expect(doc.internal.pageSize.getHeight()).toBeCloseTo(210, 1);
    doc.setFontSize(8).text('Page one', 10, 20);
    doc.addPage([100, 200], 'p').text('Page two', 10, 20);
    doc.addPage().text('Page three', 10, 20);
    expect(doc.getNumberOfPages()).toBe(3);
    expect(doc.internal.pageSize.getWidth()).toBeCloseTo(100, 10);
    expect(doc.internal.pageSize.getHeight()).toBeCloseTo(200, 10);
    doc.setPage(1).text('Footer 1 / 3', 287, 203, { align: 'right' });
    const blobPromise = doc.output('blob');
    expect(blobPromise).toBeInstanceOf(Promise);
    const blob = await blobPromise;
    expect(blob.type).toBe('application/pdf');
    const pdf = await PDFDocument.load(await blob.arrayBuffer());
    expect(pdf.getPageCount()).toBe(3);
    expect(pdf.getPage(0).getWidth()).toBeCloseTo(841.89, 2);
    expect(pdf.getPage(1).getWidth()).toBeCloseTo((100 * 72) / 25.4, 8);
    expect(pdf.getPage(2).getHeight()).toBeCloseTo((200 * 72) / 25.4, 8);
    expect((pageOperators(pdf).match(/\bBT\b/g) ?? []).length).toBe(2);
    expect(() => doc.text('Late mutation', 0, 0)).toThrow(/finalized/);
    await expect(doc.output('arraybuffer')).resolves.toBeInstanceOf(ArrayBuffer);
  });

  it('preloads exact custom fonts and measures/wraps synchronously without a DOM', async () => {
    const font = await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url));
    const doc = await createJsPDFAdapter({
      unit: 'pt',
      fonts: [{ family: 'Test Sans', data: font }],
    });
    doc.setFont('Test Sans').setFontSize(12);
    const metrics = doc.getTextDimensions('Žluťoučký kůň');
    expect(metrics.w).toBeGreaterThan(50);
    expect(metrics.h).toBe(12);
    expect(metrics).not.toBeInstanceOf(Promise);
    expect(doc.getTextDimensions('')).toEqual({ w: 0, h: 0 });
    const width = doc.getTextWidth('one two');
    expect(doc.splitTextToSize('one two three', width + 0.01)).toEqual(['one two', 'three']);
    const fragments = doc.splitTextToSize('abcdefghij', doc.getTextWidth('abc') + 0.01);
    expect(fragments.join('')).toBe('abcdefghij');
    expect(
      fragments.every((line) => doc.getTextWidth(line) <= doc.getTextWidth('abc') + 0.01),
    ).toBe(true);
    expect(doc.getTextDimensions(['one', 'two']).h).toBeCloseTo(25.8);
    doc.text('Žluťoučký kůň', 10, 30);
    expect((await doc.toResult()).pageCount).toBe(1);
    expect(() => doc.setFont('Missing')).toThrow();
  });

  it('normalizes DevExtreme color arguments and restores font/color/line state', async () => {
    const doc = await createJsPDFAdapter();
    expect(doc.internal.scaleFactor).toBeCloseTo(72 / 25.4, 10);
    const bridge = doc.__private__;
    doc.setTextColor('#7f3300').setDrawColor(30, 60, 90).setFillColor(0, 1, 1, 0);
    expect(doc.getTextColor()).toBe(
      bridge.decodeColorString(bridge.encodeColorString({ ch1: '#7f3300', precision: 3 })),
    );
    expect(doc.getDrawColor()).toBe(
      bridge.decodeColorString(
        bridge.encodeColorString({ ch1: 30, ch2: 60, ch3: 90, precision: 2 }),
      ),
    );
    expect(doc.getFillColor()).toBe('#ff0000');
    const previousColor = doc.getTextColor();
    doc.setFont('Helvetica', 'bold').setFontSize(11).setLineWidth(0.5).saveGraphicsState();
    doc.setFont('Courier').setFontSize(25).setLineWidth(8).setTextColor('blue');
    doc.restoreGraphicsState();
    expect(doc.getFont()).toMatchObject({
      fontName: 'Helvetica',
      fontStyle: 'bold',
      fontWeight: 700,
    });
    expect(doc.getFontSize()).toBe(11);
    expect(doc.getLineWidth()).toBe(0.5);
    expect(doc.getTextColor()).toBe(previousColor);
    doc.text('State restored', 10, 30);
    await expect(doc.toResult()).resolves.toMatchObject({ pageCount: 1 });
  });

  it('writes a balanced clipping path and baseline-aligned cell text', async () => {
    const doc = await createJsPDFAdapter({ unit: 'pt', format: { width: 200, height: 200 } });
    doc.setFontSize(10).setFillColor('#eeeeee').rect(10, 20, 80, 20, 'F');
    doc
      .saveGraphicsState()
      .moveTo(10, 20)
      .lineTo(90, 20)
      .lineTo(90, 40)
      .lineTo(10, 40)
      .close()
      .clip()
      .discardPath();
    doc.text('Clipped cell', 50, 30, { align: 'center', baseline: 'middle' });
    doc.restoreGraphicsState().setLineWidth(1).rect(10, 20, 80, 20);
    const pdf = await PDFDocument.load(await doc.toUint8Array());
    const operators = pageOperators(pdf);
    expect(operators).toMatch(/\bW\b/);
    expect(operators).toMatch(/\bn\b/);
    expect(operators.indexOf('W')).toBeLessThan(operators.indexOf('BT'));
    expect((operators.match(/\bq\b/g) ?? []).length).toBe((operators.match(/\bQ\b/g) ?? []).length);
    expect(() => doc.restoreGraphicsState()).toThrow();
  });

  it('keeps queued image paint before later text and owns the input bytes', async () => {
    const bytes = whitePixel();
    const doc = await createJsPDFAdapter({ unit: 'pt' });
    doc.addImage(bytes, 'PNG', 10, 10, 40, 40).text('Over image', 15, 30);
    bytes.fill(0);
    const result = await doc.toResult();
    expect(await doc.toResult()).toBe(result);
    const pdf = await PDFDocument.load(await result.toUint8Array());
    const operators = pageOperators(pdf);
    expect(operators.indexOf('Do')).toBeGreaterThan(-1);
    expect(operators.indexOf('Do')).toBeLessThan(operators.indexOf('BT'));
  });

  it('keeps jsPDF counterclockwise angles and explicit clockwise rotations in actual PDF text matrices', async () => {
    const doc = await createJsPDFAdapter({ unit: 'pt', format: { width: 240, height: 240 } });
    doc.text('ccw45', 30, 100, { angle: 45 });
    doc.text('ccw90', 80, 100, { angle: 90 });
    doc.text('cw90', 130, 100, { angle: 90, rotationDirection: 0 });
    doc.text('explicitCCW', 180, 100, { angle: 90, rotationDirection: 1 });
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: await doc.toUint8Array(), useSystemFonts: true });
    try {
      const reader = await task.promise;
      const content = await (await reader.getPage(1)).getTextContent();
      const matrices = new Map(
        content.items.flatMap((item) =>
          'str' in item ? [[item.str, item.transform] as const] : [],
        ),
      );
      const diagonal = matrices.get('ccw45');
      const counterclockwise = matrices.get('ccw90');
      const clockwise = matrices.get('cw90');
      const explicit = matrices.get('explicitCCW');
      if (!diagonal || !counterclockwise || !clockwise || !explicit)
        throw new Error('Rotated PDF text was not preserved.');
      expect(diagonal[0]).toBeCloseTo(16 / Math.SQRT2, 6);
      expect(diagonal[1]).toBeCloseTo(16 / Math.SQRT2, 6);
      expect(counterclockwise[0]).toBeCloseTo(0, 6);
      expect(counterclockwise[1]).toBeCloseTo(16, 6);
      expect(clockwise[0]).toBeCloseTo(0, 6);
      expect(clockwise[1]).toBeCloseTo(-16, 6);
      expect(explicit[1]).toBeCloseTo(16, 6);
    } finally {
      await task.destroy();
    }
  });

  it('rejects invalid faces, colors, state and unsupported text explicitly', async () => {
    const doc = await createJsPDFAdapter();
    expect(() => doc.setFont('Unavailable')).toThrow();
    expect(() => doc.setFont('Helvetica', 'small-caps')).toThrow();
    expect(() => doc.setFontSize(0)).toThrow();
    expect(() => doc.setTextColor(999, 0, 0)).toThrow();
    expect(() => doc.setFillColor('invalid-color')).toThrow();
    expect(() => doc.restoreGraphicsState()).toThrow();
    expect(() => doc.splitTextToSize('hello', 0)).toThrow();
    expect(() => doc.text('abc', 10, 10, { isInputRtl: true })).toThrow();
    expect(() => doc.text('abc', 10, 10, { angle: 90, rotationDirection: 2 as 1 })).toThrow(
      /rotationDirection/,
    );
    expect(() => doc.addImage(whitePixel(), 'TIFF', 0, 0, 20, 20)).toThrow();
    expect(() => doc.setPage(2)).toThrow();
    doc.text('Still valid', 10, 20);
    await expect(doc.toResult()).resolves.toMatchObject({ pageCount: 1 });
  });
});
