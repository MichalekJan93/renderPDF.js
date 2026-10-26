import { describe, expect, it } from 'vite-plus/test';
import { readFile } from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
import { PNG } from 'pngjs';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  StandardFonts,
} from 'pdf-lib';
import type { PDFFont } from 'pdf-lib';
import { PDFPageBuilder } from '../src/document-page';
import { parseDocumentColor } from '../src/document-colors';

/** Real backend documents keep these checks independent of mocked drawing calls. */
async function fixture(
  scale = 1,
  unicode = false,
  geometry?: { origin: readonly [number, number]; userUnit: number },
) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const noto = unicode
    ? await pdf.embedFont(
        await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)),
        { subset: true },
      )
    : regular;
  const fonts: Record<string, PDFFont> = { Helvetica: regular, Noto: noto };
  const native = pdf.addPage([200, 300]);
  if (geometry) {
    native.setMediaBox(geometry.origin[0], geometry.origin[1], 200, 300);
    native.node.set(PDFName.of('UserUnit'), PDFNumber.of(geometry.userUnit));
  }
  let active = true;
  const page = new PDFPageBuilder(native, {
    pdf,
    scale,
    resolveFont: (options) => {
      const font = fonts[options?.font ?? 'Helvetica'];
      if (!font) throw new Error('Unknown fixture font.');
      return font;
    },
    assertActive: () => {
      if (!active) throw new DOMException('Stopped.', 'AbortError');
    },
  });
  return {
    pdf,
    page,
    native,
    regular,
    stop: () => {
      active = false;
    },
  };
}

/** Decode saved content streams instead of depending on private writer buffers. */
async function saved(pdf: PDFDocument) {
  const bytes = await pdf.save({ updateFieldAppearances: false });
  const loaded = await PDFDocument.load(bytes);
  const page = loaded.getPage(0);
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  const text = streams
    .map((entry) => {
      const stream = loaded.context.lookup(entry);
      if (!(stream instanceof PDFRawStream)) throw new Error('Missing native content stream.');
      return new TextDecoder().decode(decodePDFRawStream(stream).decode());
    })
    .join('\n');
  return { bytes, loaded, text };
}

/** Two visible colors expose byte corruption while remaining a tiny synthetic bitmap. */
function image(): Uint8Array {
  const png = new PNG({ width: 2, height: 1 });
  png.data.set([255, 0, 0, 255, 0, 0, 255, 255]);
  return Uint8Array.from(PNG.sync.write(png));
}

describe('native document drawing', () => {
  it('normalizes imported MediaBox origins and UserUnit for text, vectors, images, links and fields', async () => {
    const { pdf, page } = await fixture(1, false, { origin: [20, 30], userUnit: 2 });
    expect([page.width, page.height]).toEqual([400, 600]);
    page.saveGraphicsState().transform([1, 0, 0, 1, 10, 20]);
    page.drawText('Translated', { x: 0, y: 20, fontSize: 12 });
    page.drawRectangle({ x: 0, y: 40, width: 20, height: 10, fill: 'red' });
    page.addLink('https://example.test/scaled', { x: 0, y: 40, width: 20, height: 10 });
    page.restoreGraphicsState();
    page.drawText('Linked', { x: 40, y: 25, fontSize: 12, link: 'https://example.test/text' });
    await page.drawImage(image(), { x: 40, y: 40, width: 20, height: 10 });
    page.saveGraphicsState().transform([2, 0, 0, 3, 0, 0]);
    page.drawText('Matrix', { x: 80, y: 140, fontSize: 12 });
    page.restoreGraphicsState();
    page.addTextField(
      'scaled',
      { x: 10, y: 90, width: 100, height: 30 },
      {
        value: 'Scaled',
        fontSize: 12,
        borderWidth: 0,
      },
    );
    page.assertComplete();
    const { bytes, text, loaded } = await saved(pdf);
    expect(text).toContain('1 0 0 1 5 -10 cm');
    expect(text).toContain('1 0 0 1 20 305 cm');
    expect(text).toContain('10 0 0 5 0 0 cm');
    expect(loaded.getForm().getTextField('scaled').acroField.getDefaultAppearance()).toContain(
      '6 Tf',
    );
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: bytes, useSystemFonts: true });
    try {
      const reader = await task.promise;
      const inspected = await reader.getPage(1);
      const viewport = inspected.getViewport({ scale: 1 });
      const viewportRectangle = (bounds: readonly number[]) => {
        const first = viewport.convertToViewportPoint(bounds[0]!, bounds[1]!);
        const last = viewport.convertToViewportPoint(bounds[2]!, bounds[3]!);
        return [first[0]!, first[1]!, last[0]!, last[1]!] as const;
      };
      expect([viewport.width, viewport.height]).toEqual([400, 600]);
      const content = await inspected.getTextContent();
      const translated = content.items.find((item) => 'str' in item && item.str === 'Translated');
      if (!translated || !('str' in translated))
        throw new Error('Missing selectable translated text.');
      expect(
        viewport.convertToViewportPoint(translated.transform[4], translated.transform[5]),
      ).toEqual([10, 40]);
      expect(translated.transform[0] * viewport.transform[0]!).toBeCloseTo(12);
      const matrixText = content.items.find((item) => 'str' in item && item.str === 'Matrix');
      if (!matrixText || !('str' in matrixText))
        throw new Error('Missing transformed matrix text.');
      expect(
        viewport.convertToViewportPoint(matrixText.transform[4], matrixText.transform[5]),
      ).toEqual([160, 420]);
      const annotations = await inspected.getAnnotations();
      const link = annotations.find(
        (annotation) => annotation.url === 'https://example.test/scaled',
      );
      const corners = viewportRectangle(link.rect);
      expect([
        Math.min(corners[0], corners[2]),
        Math.min(corners[1], corners[3]),
        Math.abs(corners[2] - corners[0]),
        Math.abs(corners[3] - corners[1]),
      ]).toEqual([10, 60, 20, 10]);
      const field = annotations.find((annotation) => annotation.fieldName === 'scaled');
      const fieldCorners = viewportRectangle(field.rect);
      expect([
        Math.min(fieldCorners[0], fieldCorners[2]),
        Math.min(fieldCorners[1], fieldCorners[3]),
      ]).toEqual([10, 90]);
      const textLink = annotations.find(
        (annotation) => annotation.url === 'https://example.test/text',
      );
      const textCorners = viewportRectangle(textLink.rect);
      expect(Math.min(textCorners[0], textCorners[2])).toBeCloseTo(40);
      expect(Math.min(textCorners[1], textCorners[3])).toBeLessThan(25);
      expect(Math.max(textCorners[1], textCorners[3])).toBeGreaterThan(25);
    } finally {
      await task.destroy();
    }
  });

  it('keeps selectable text, baseline coordinates and point-sized fonts across document units', async () => {
    const { pdf, page, regular } = await fixture(2);
    expect([page.width, page.height]).toEqual([100, 150]);
    page.drawText('Hello', { x: 10, y: 20, fontSize: 12 });
    page.drawText('Right', { x: 80, y: 40, align: 'right', fontSize: 12 });
    page.drawText('first\nsecond', { x: 5, y: 60, fontSize: 10, lineHeight: 1.5 });
    page.assertComplete();
    const { bytes, text } = await saved(pdf);
    expect(text).toContain('1 0 0 1 20 260 Tm');
    expect(text).toContain('/Helvetica-');
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: bytes, useSystemFonts: true });
    try {
      const reader = await task.promise;
      const content = await (await reader.getPage(1)).getTextContent();
      const items = content.items.filter((item) => 'str' in item);
      const hello = items.find((item) => item.str === 'Hello')!;
      expect(hello.transform[4]).toBeCloseTo(20);
      expect(hello.transform[5]).toBeCloseTo(260);
      expect(hello.transform[0]).toBeCloseTo(12);
      const right = items.find((item) => item.str === 'Right')!;
      expect(right.transform[4]).toBeCloseTo(160 - regular.widthOfTextAtSize('Right', 12));
      expect(items.find((item) => item.str === 'second')!.transform[5]).toBeCloseTo(165);
    } finally {
      await task.destroy();
    }
  });

  it('writes native clipping, transforms, curves and transparent vector paint', async () => {
    const { pdf, page } = await fixture(2);
    page.saveGraphicsState().transform([1, 0, 0, 1, 3, 4]);
    page.clipRectangle({ x: 0, y: 0, width: 50, height: 50 });
    page
      .moveTo(1, 2)
      .lineTo(10, 2)
      .curveTo(12, 3, 14, 8, 10, 10)
      .closePath()
      .fillAndStroke({ fill: '#f008', stroke: 'blue', strokeWidth: 0.5 });
    page.restoreGraphicsState();
    page.drawEllipse({ x: 10, y: 10, width: 25, height: 15, fill: 'rgba(0, 128, 0, 0.5)' });
    page.drawCircle({ x: 50, y: 60, radius: 5, stroke: '#333' });
    page.drawSvgPath('M 0 0 L 10 0 L 5 10 Z', { x: 10, y: 80, fill: '#123456' });
    page.assertComplete();
    const { text, loaded } = await saved(pdf);
    expect(text).toContain('1 0 0 1 6 -8 cm');
    expect(text).toContain('0 200 100 100 re\nW\nn');
    expect(text).toContain('2 296 m');
    expect(text).toContain('24 294 28 284 20 280 c');
    expect(text).toContain('B');
    const states = loaded.getPage(0).node.Resources()!.lookup(PDFName.of('ExtGState'), PDFDict);
    const dictionaries = states
      .values()
      .map((entry) => loaded.context.lookup(entry, PDFDict).toString())
      .join('\n');
    expect(dictionaries).toContain('/ca 0.5333333333333333');
    expect(dictionaries).toContain('/CA 1');
  });

  it('requires complete paths and balanced graphics state without poisoning later drawing', async () => {
    const { page } = await fixture();
    expect(() => page.restoreGraphicsState()).toThrow(/No saved/);
    expect(() => page.lineTo(1, 2)).toThrow(/Start a path/);
    expect(() => page.transform([1, 1, 1, 1, 0, 0])).toThrow(/invertible/);
    page.saveGraphicsState();
    expect(() => page.assertComplete()).toThrow(/Restore every/);
    page.restoreGraphicsState().moveTo(0, 0).lineTo(10, 10).clip();
    expect(() => page.drawText('blocked', { x: 5, y: 5 })).toThrow(/current path/);
    page.discardPath().drawText('valid', { x: 10, y: 20 });
    expect(() => page.setRotation(45)).toThrow(/multiple of 90/);
    page.setRotation(-90);
    expect(page.rotation).toBe(270);
    expect(() => page.assertComplete()).not.toThrow();
  });

  it('snapshots image bytes and options and rejects interleaved drawing while awaiting embedding', async () => {
    const { page, pdf } = await fixture();
    const bytes = image();
    const options = { x: 10, y: 20, width: 40, height: 30 };
    const drawing = page.drawImage(bytes, options);
    bytes.fill(0);
    options.x = 100;
    expect(() => page.drawText('race', { x: 1, y: 1 })).toThrow(/Await drawImage/);
    expect(() => page.assertComplete()).toThrow(/Await drawImage/);
    await drawing;
    page.assertComplete();
    const { text, loaded } = await saved(pdf);
    expect(text).toContain('1 0 0 1 10 280 cm');
    expect(text).toContain('40 0 0 30 0 0 cm');
    const resources = loaded.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    expect(resources.keys()).toHaveLength(1);
    const embedded = loaded.context.lookup(resources.values()[0]!);
    expect(embedded).toBeInstanceOf(PDFRawStream);
    if (!(embedded instanceof PDFRawStream)) throw new Error('Missing image stream.');
    expect(embedded.dict.lookup(PDFName.of('Width'), PDFNumber).asNumber()).toBe(2);
  });

  it('uses base64 data URLs without network requests and rejects unsupported URLs and malformed PNGs', async () => {
    const { page } = await fixture();
    await page.drawImage(`data:image/png;base64,${Buffer.from(image()).toString('base64')}`, {
      x: 0,
      y: 0,
      width: 20,
      height: 20,
    });
    await expect(
      page.drawImage('https://example.test/image.png', { x: 0, y: 0, width: 1, height: 1 }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE' });
    await expect(
      page.drawImage(new Uint8Array([137, 80, 78, 71]), { x: 0, y: 0, width: 1, height: 1 }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_IMAGE' });
    page.assertComplete();
  });

  it('stores transformed link bounds and Unicode notes as native annotations', async () => {
    const { page, pdf } = await fixture(2);
    page.saveGraphicsState().transform([1, 0, 0, 1, 3, 4]);
    page.addLink('https://example.test/článek', { x: 10, y: 20, width: 30, height: 10 });
    page
      .restoreGraphicsState()
      .addNote('Česká poznámka', { x: 60, y: 10, width: 12, height: 12 }, { title: 'Autor' });
    expect(() => page.addLink('javascript:alert(1)', { x: 1, y: 1, width: 1, height: 1 })).toThrow(
      /Links support/,
    );
    const { loaded } = await saved(pdf);
    const annotations = loaded.getPage(0).node.Annots()!;
    expect(annotations.size()).toBe(2);
    const first = annotations.lookup(0, PDFDict),
      second = annotations.lookup(1, PDFDict);
    expect(
      first
        .lookup(PDFName.of('Rect'), PDFArray)
        .asArray()
        .map((part) => part.toString()),
    ).toEqual(['26', '232', '86', '252']);
    expect(first.lookup(PDFName.of('A'), PDFDict).toString()).toContain(
      'https://example.test/%C4%8Dl%C3%A1nek',
    );
    expect(second.lookup(PDFName.of('Contents'), PDFHexString).decodeText()).toBe('Česká poznámka');
  });

  it('saves ASCII and Unicode text, checkbox and dropdown fields with clean appearances', async () => {
    const { page, pdf } = await fixture(1, true);
    expect(() => page.drawText('中文', { x: 10, y: 10, font: 'Noto' })).toThrow(/cannot encode/);
    expect(() =>
      page.addTextField(
        'unsupported',
        { x: 10, y: 10, width: 100, height: 20 },
        { font: 'Noto', value: '中文' },
      ),
    ).toThrow(/cannot encode/);
    page.addTextField(
      'ascii',
      { x: 10, y: 10, width: 100, height: 20 },
      { value: 'Ready', fontSize: 12 },
    );
    page.addTextField(
      'name',
      { x: 10, y: 40, width: 140, height: 25 },
      { value: 'Český žluťoučký', font: 'Noto', readOnly: true, required: true, maxLength: 40 },
    );
    page.addCheckBox('accepted', { x: 10, y: 80, width: 16, height: 16 }, { checked: true });
    page.addDropdown('country', { x: 10, y: 110, width: 140, height: 25 }, ['Česko', 'Slovensko'], {
      font: 'Noto',
      value: 'Česko',
    });
    page.drawText('Český žluťoučký office ffi', { x: 10, y: 160, font: 'Noto', fontSize: 12 });
    page.assertComplete();
    const { bytes, loaded } = await saved(pdf);
    const form = loaded.getForm();
    expect(form.getTextField('ascii').getText()).toBe('Ready');
    expect(form.getTextField('name').getText()).toBe('Český žluťoučký');
    expect(form.getTextField('name').isReadOnly()).toBe(true);
    expect(form.getTextField('name').isRequired()).toBe(true);
    expect(form.getCheckBox('accepted').isChecked()).toBe(true);
    expect(form.getDropdown('country').getSelected()).toEqual(['Česko']);
    for (const field of form.getFields()) {
      const widgets = field.acroField.getWidgets();
      expect(widgets[0]!.getAppearances()?.normal).toBeDefined();
    }
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: bytes, useSystemFonts: true });
    try {
      const reader = await task.promise;
      const annotations = await (await reader.getPage(1)).getAnnotations();
      const content = await (await reader.getPage(1)).getTextContent();
      expect(content.items.flatMap((item) => ('str' in item ? [item.str] : [])).join('')).toContain(
        'Český žluťoučký office ffi',
      );
      expect(annotations.find((annotation) => annotation.fieldName === 'name')?.fieldValue).toBe(
        'Český žluťoučký',
      );
      expect(
        annotations.find((annotation) => annotation.fieldName === 'country')?.fieldValue,
      ).toEqual(['Česko']);
    } finally {
      await task.destroy();
    }
  });

  it('rejects invalid field values and missing glyphs before creating fields', async () => {
    const { page, pdf, stop } = await fixture();
    const bounds = { x: 10, y: 10, width: 80, height: 20 };
    expect(() => page.addTextField('missing', bounds, { value: 'Česko' })).toThrow(/cannot encode/);
    expect(() => page.addDropdown('invalid', bounds, ['A'], { value: 'B' })).toThrow(/selection/);
    expect(() => page.addCheckBox('alpha', bounds, { backgroundColor: '#fff8' })).toThrow(/opaque/);
    expect(pdf.getForm().getFields()).toHaveLength(0);
    page.addTextField('valid', bounds, { value: 'A' });
    expect(() => page.addTextField('valid', bounds)).toThrow(/already exists/);
    page.saveGraphicsState().transform([1, 0, 0, 1, 2, 0]);
    expect(() => page.addCheckBox('transformed', bounds)).toThrow(/outside transformed/);
    page.restoreGraphicsState();
    stop();
    expect(() => page.drawRectangle({ ...bounds, fill: 'red' })).toThrow(/Stopped/);
  });

  it('validates portable CSS colors including alpha without a DOM', () => {
    expect(parseDocumentColor('#1234').opacity).toBeCloseTo(0x44 / 255);
    expect(parseDocumentColor('rgb(100% 0% 50% / 25%)')).toMatchObject({
      color: { red: 1, green: 0, blue: 0.5 },
      opacity: 0.25,
    });
    expect(parseDocumentColor('navy').color.blue).toBeCloseTo(128 / 255);
    expect(parseDocumentColor('transparent').opacity).toBe(0);
    expect(() => parseDocumentColor('rgba(0, 0, 0, 2)')).toThrow(/CSS hex/);
    expect(() => parseDocumentColor('url(https://example.test)')).toThrow(/CSS hex/);
  });
});
