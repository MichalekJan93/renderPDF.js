import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vite-plus/test';
import { PDFDocument } from 'pdf-lib';
import { createDocument } from '../src/document';
import { mergePDFs } from '../src/compose-pdf';

/** Use an independent PDF parser to verify text and page destinations. */
async function inspect(bytes: Uint8Array) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: true });
  return { pdf: await task.promise, close: () => task.destroy() };
}

describe('document builder', () => {
  it('creates and revisits mixed paper sizes with selectable Czech text without a DOM', async () => {
    const bytes = await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url));
    const doc = await createDocument({
      unit: 'mm',
      fonts: [{ family: 'Document Sans', data: bytes }],
      metadata: { title: 'Přehled' },
    });
    const first = doc.addPage({ format: 'A4', orientation: 'landscape' });
    first.drawText('Příliš žluťoučký kůň', { x: 10, y: 20, font: 'Document Sans', fontSize: 12 });
    const second = doc.addPage({ format: { width: 100, height: 150 } });
    second.drawText('Second page', { x: 10, y: 20 });
    doc.getPage(1).drawText('Strana 1 z 2', {
      x: first.width - 10,
      y: first.height - 7,
      fontSize: 8,
      align: 'right',
    });
    const result = await doc.toResult();
    expect(result.pageCount).toBe(2);
    const loaded = await PDFDocument.load(await result.toUint8Array());
    expect(loaded.getTitle()).toBe('Přehled');
    expect(loaded.getPage(0).getWidth()).toBeCloseTo(841.89);
    expect(loaded.getPage(1).getWidth()).toBeCloseTo((100 * 72) / 25.4);
    const parsed = await inspect(await result.toUint8Array());
    try {
      const text = await (await parsed.pdf.getPage(1)).getTextContent();
      expect(text.items.flatMap((item) => ('str' in item ? [item.str] : [])).join(' ')).toContain(
        'Příliš žluťoučký kůň',
      );
      expect(text.items.flatMap((item) => ('str' in item ? [item.str] : [])).join(' ')).toContain(
        'Strana 1 z 2',
      );
    } finally {
      await parsed.close();
    }
    expect(await doc.toResult()).toBe(result);
    expect(() => first.drawText('Late edit', { x: 1, y: 1 })).toThrow(/finalized/);
  });

  it('snapshots font bytes, custom geometry and metadata before asynchronous preparation', async () => {
    const font = Uint8Array.from(
      await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)),
    );
    const format = { width: 300, height: 200 };
    const metadata = { title: 'Original' };
    const pending = createDocument({
      format,
      metadata,
      fonts: [{ family: 'Owned Font', data: font }],
    });
    font.fill(0);
    format.width = 1;
    metadata.title = 'Changed';
    const doc = await pending;
    const page = doc.addPage();
    expect(page.width).toBe(300);
    page.drawText('Čeština', { x: 10, y: 30, font: 'Owned Font' });
    const loaded = await PDFDocument.load(await (await doc.toResult()).toUint8Array());
    expect(loaded.getTitle()).toBe('Original');
  });

  it('measures exact font faces and fails missing faces and glyphs explicitly', async () => {
    const doc = await createDocument({ unit: 'mm' });
    expect(doc.measureText('Hello', { fontSize: 12 }).width).toBeGreaterThan(0);
    expect(doc.measureText('Hello\nWorld', { fontSize: 12 }).height).toBeCloseTo(
      (2 * 12 * 1.15 * 25.4) / 72,
    );
    expect(() => doc.measureText('Příliš')).toThrow(/glyph/);
    expect(() => doc.measureText('Hello', { font: 'Missing' })).toThrow(/Register/);
    expect(() => doc.measureText('Hello', { fontSize: 0 })).toThrow(/positive/);
  });

  it('keeps bookmark destinations correct after page insertion and reordering', async () => {
    const doc = await createDocument();
    const first = doc.addPage();
    first.drawText('First', { x: 20, y: 20 });
    doc.addPage().drawText('Second', { x: 20, y: 20 });
    const parent = doc.addBookmark('První', { pageNumber: 1 });
    doc.addBookmark('Druhá', { pageNumber: 2, parent });
    doc.insertPage(1, { format: { width: 200, height: 200 } });
    doc.movePage(2, 3);
    expect(parent.pageNumber).toBe(3);
    expect(() => doc.removePage(3)).toThrow(/bookmarked/);
    const orphan = doc.getPage(1);
    doc.removePage(1);
    expect(() => orphan.drawText('Detached', { x: 1, y: 1 })).toThrow(/removed/);
    const parsed = await inspect(await (await doc.toResult()).toUint8Array());
    try {
      const outline = await parsed.pdf.getOutline();
      expect(outline?.[0]?.title).toBe('První');
      const destination = outline?.[0]?.dest;
      if (!Array.isArray(destination)) throw new Error('Expected a concrete page destination.');
      expect(await parsed.pdf.getPageIndex(destination[0])).toBe(1);
      expect(outline?.[0]?.items[0]?.title).toBe('Druhá');
    } finally {
      await parsed.close();
    }
  });

  it('appends completed PDF results without rasterizing and blocks concurrent mutation', async () => {
    const source = await createDocument({ format: { width: 200, height: 300 } });
    source.addPage().drawText('Imported', { x: 10, y: 20 });
    const doc = await createDocument();
    doc.addPage().drawText('Original', { x: 10, y: 20 });
    const importing = doc.appendPDF(await source.toResult());
    expect(() => doc.addPage()).toThrow(/pending/);
    await expect(doc.toResult()).rejects.toThrow(/pending/);
    await importing;
    expect(doc.pageCount).toBe(2);
    expect(doc.getPage(2).width).toBe(200);
    const parsed = await inspect(await (await doc.toResult()).toUint8Array());
    try {
      const text = await (await parsed.pdf.getPage(2)).getTextContent();
      expect(text.items.flatMap((item) => ('str' in item ? [item.str] : [])).join('')).toBe(
        'Imported',
      );
    } finally {
      await parsed.close();
    }
  });

  it('flattens field appearances into composable native PDF content', async () => {
    const doc = await createDocument({ format: { width: 300, height: 200 } });
    doc
      .addPage()
      .addTextField('name', { x: 20, y: 20, width: 160, height: 25 }, { value: 'Example' });
    const page = doc.getPage(1);
    page.saveGraphicsState().transform([1, 0, 0, 1, 30, 0]);
    expect(() => doc.flattenForms()).toThrow(/graphics/);
    page.restoreGraphicsState();
    doc.flattenForms();
    const result = await doc.toResult();
    const loaded = await PDFDocument.load(await result.toUint8Array());
    expect(loaded.getForm().getFields()).toHaveLength(0);
    expect((await mergePDFs([result, result])).pageCount).toBe(2);
  });

  it('rejects invalid settings and empty documents, and supports cancellation', async () => {
    await expect(createDocument({ unit: 'unknown' as 'pt' })).rejects.toThrow(/pt, mm or px/);
    const doc = await createDocument();
    for (const selection of ['12', ['1'], [0], [], [1.5]]) {
      await expect(
        doc.appendPDF(new Uint8Array(), selection as unknown as number[]),
      ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    }
    expect(() => doc.addPage({ format: { width: -1, height: 20 } })).toThrow(/positive/);
    expect(doc.pageCount).toBe(0);
    await expect(doc.toResult()).rejects.toThrow(/at least one/);
    const controller = new AbortController();
    controller.abort();
    await expect(createDocument({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
