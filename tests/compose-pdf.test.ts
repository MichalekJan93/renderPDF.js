import { describe, expect, it } from 'vite-plus/test';
import { readFile } from 'node:fs/promises';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  StandardFonts,
  degrees,
  rgb,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { RenderProgress } from '../src/api-types';
import {
  appendPDFPages,
  extractPDFPages,
  loadPDFSource,
  mergePDFs,
  splitPDF,
} from '../src/compose-pdf';

/** Real synthetic pages allow an independent reader to detect lost text or raster replacement. */
async function fixture() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const first = pdf.addPage([180, 260]);
  first.drawText('First page', { x: 20, y: 190, font, size: 12 });
  first.drawRectangle({ x: 10, y: 10, width: 25, height: 30, color: rgb(1, 0, 0) });
  const second = pdf.addPage([320, 200]);
  second.setRotation(degrees(90));
  second.setCropBox(8, 10, 300, 175);
  second.drawText('Second page', { x: 20, y: 140, font, size: 12 });
  return pdf.save();
}

/** PDF.js extracts text and operators without depending on the PDF writer's object model. */
async function inspect(bytes: Uint8Array) {
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: true });
  const pdf = await task.promise;
  try {
    const pages: { text: string; images: number; rectangles: number }[] = [];
    for (let index = 1; index <= pdf.numPages; index += 1) {
      const page = await pdf.getPage(index);
      const text = await page.getTextContent();
      const operations = await page.getOperatorList();
      pages.push({
        text: text.items.flatMap((item) => ('str' in item ? [item.str] : [])).join(''),
        images: operations.fnArray.filter((operation) => operation === OPS.paintImageXObject)
          .length,
        rectangles: operations.fnArray.filter((operation) => operation === OPS.constructPath)
          .length,
      });
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

/** Add a local page link or external URI through standard PDF annotation dictionaries. */
function link(pdf: PDFDocument, action: boolean) {
  const [first, second] = pdf.getPages();
  const destination = pdf.context.obj([second!.ref, 'Fit']);
  const annotation = pdf.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [0, 0, 100, 20],
    Border: [0, 0, 0],
    ...(action ? { A: { S: 'GoTo', D: destination } } : { Dest: destination }),
  });
  first!.node.addAnnot(pdf.context.register(annotation));
}

describe('native PDF composition', () => {
  it('merges byte, Blob and result inputs without rasterizing text or vector content', async () => {
    const bytes = await fixture();
    const first = await extractPDFPages(bytes, [1]);
    const result = await mergePDFs([
      new Blob([Uint8Array.from(bytes)]),
      first,
      Uint8Array.from(bytes).buffer,
    ]);
    expect(result.pageCount).toBe(5);
    const pages = await inspect(await result.toUint8Array());
    expect(pages.map((page) => page.text)).toEqual([
      'First page',
      'Second page',
      'First page',
      'First page',
      'Second page',
    ]);
    expect(pages.every((page) => page.images === 0)).toBe(true);
    expect(pages[0]!.rectangles).toBeGreaterThan(0);
    const loaded = await PDFDocument.load(await result.toUint8Array());
    expect(loaded.getPages().map((page) => page.getSize())).toEqual([
      { width: 180, height: 260 },
      { width: 320, height: 200 },
      { width: 180, height: 260 },
      { width: 180, height: 260 },
      { width: 320, height: 200 },
    ]);
    expect(loaded.getPage(1).getRotation().angle).toBe(90);
    expect(loaded.getPage(1).getCropBox()).toEqual({ x: 8, y: 10, width: 300, height: 175 });
  });

  it('keeps selected page order, duplicates, original text and independent output byte copies', async () => {
    const result = await extractPDFPages(await fixture(), [2, 1, 2]);
    const bytes = await result.toUint8Array();
    expect((await inspect(bytes)).map((page) => page.text)).toEqual([
      'Second page',
      'First page',
      'Second page',
    ]);
    bytes.fill(0);
    expect((await result.toUint8Array())[0]).toBe(37);
    expect((await result.toBlob()).type).toBe('application/pdf');
  });

  it('splits a document into immutable, independently readable single-page results', async () => {
    const results = await splitPDF(await fixture());
    expect(Object.isFrozen(results)).toBe(true);
    expect(results.map((result) => result.pageCount)).toEqual([1, 1]);
    expect((await inspect(await results[1]!.toUint8Array()))[0]!.text).toBe('Second page');
    const pdf = await PDFDocument.load(await results[1]!.toUint8Array());
    expect(pdf.getPage(0).getSize()).toEqual({ width: 320, height: 200 });
    expect(pdf.getPage(0).getRotation().angle).toBe(90);
  });

  it('preserves embedded Unicode text and snapshots source bytes, metadata and page selection', async () => {
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const font = await pdf.embedFont(
      await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)),
    );
    const page = pdf.addPage([500, 300]);
    page.drawText('Příliš žluťoučký kůň', { x: 20, y: 220, font, size: 16 });
    const bytes = await pdf.save();
    const pages = [1];
    const metadata = { title: 'Český dokument', keywords: ['původní'] };
    const pending = extractPDFPages(bytes, pages, { metadata });
    bytes.fill(0);
    pages[0] = 999;
    metadata.title = 'Changed';
    metadata.keywords[0] = 'changed';
    const output = await pending;
    expect((await inspect(await output.toUint8Array()))[0]!.text).toBe('Příliš žluťoučký kůň');
    const loaded = await PDFDocument.load(await output.toUint8Array());
    expect(loaded.getTitle()).toBe('Český dokument');
    expect(loaded.getKeywords()).toBe('původní');
  });

  it.each([false, true])(
    'rewrites internal links and annotation owners after page reordering (action=%s)',
    async (action) => {
      const source = await PDFDocument.load(await fixture());
      link(source, action);
      const output = await extractPDFPages(await source.save(), [2, 1]);
      const loaded = await PDFDocument.load(await output.toUint8Array());
      const owner = loaded.getPage(1);
      const annotation = owner.node.Annots()!.lookup(0, PDFDict);
      expect(annotation.get(PDFName.of('P'))).toEqual(owner.ref);
      const dictionary = action ? annotation.lookup(PDFName.of('A'), PDFDict) : annotation;
      const destination = dictionary.lookup(PDFName.of(action ? 'D' : 'Dest'), PDFArray);
      expect(destination.get(0)).toEqual(loaded.getPage(0).ref);
      await expect(extractPDFPages(await source.save(), [1])).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
      });
      await expect(splitPDF(await source.save())).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
      });
    },
  );

  it('isolates annotations, actions and destinations on repeated donor pages', async () => {
    const source = await PDFDocument.load(await fixture());
    link(source, true);
    const result = await extractPDFPages(await source.save(), [1, 1, 2]);
    const pdf = await PDFDocument.load(await result.toUint8Array());
    const first = pdf.getPage(0).node.Annots()!.lookup(0, PDFDict);
    const second = pdf.getPage(1).node.Annots()!.lookup(0, PDFDict);
    expect(first).not.toBe(second);
    expect(first.get(PDFName.of('P'))).toEqual(pdf.getPage(0).ref);
    expect(second.get(PDFName.of('P'))).toEqual(pdf.getPage(1).ref);
    const firstAction = first.lookup(PDFName.of('A'), PDFDict);
    const secondAction = second.lookup(PDFName.of('A'), PDFDict);
    expect(firstAction).not.toBe(secondAction);
    expect(firstAction.lookup(PDFName.of('D'), PDFArray)).not.toBe(
      secondAction.lookup(PDFName.of('D'), PDFArray),
    );
    expect(firstAction.lookup(PDFName.of('D'), PDFArray).get(0)).toEqual(pdf.getPage(2).ref);
    expect(secondAction.lookup(PDFName.of('D'), PDFArray).get(0)).toEqual(pdf.getPage(2).ref);
  });

  it('shares safe source loading and page appending with the builder', async () => {
    const donor = await loadPDFSource(await fixture());
    const target = await PDFDocument.create();
    target.addPage([100, 100]);
    const added = await appendPDFPages(target, donor, [2, 1]);
    expect(added).toHaveLength(2);
    expect(Object.isFrozen(added)).toBe(true);
    expect(target.getPageCount()).toBe(3);
    expect(target.getPage(1).getRotation().angle).toBe(90);
    await expect(appendPDFPages(target, donor, [3])).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    expect(target.getPageCount()).toBe(3);
  });

  it('rejects unsupported interactive forms and encrypted-marked inputs', async () => {
    const source = await PDFDocument.load(await fixture());
    const field = source.getForm().createTextField('name');
    field.addToPage(source.getPage(0), { x: 10, y: 20, width: 80, height: 20 });
    await expect(mergePDFs([await source.save()])).rejects.toMatchObject({
      code: 'INVALID_SOURCE',
    });
    source.getForm().flatten();
    // pdf-lib can leave a deleted widget reference; this fixture has no other annotations.
    source.getPage(0).node.delete(PDFName.of('Annots'));
    expect((await mergePDFs([await source.save()])).pageCount).toBe(2);

    const encrypted = await PDFDocument.load(await fixture());
    encrypted.context.trailerInfo.Encrypt = encrypted.context.register(
      encrypted.context.obj({
        Filter: 'Standard',
        V: 1,
        R: 2,
        P: -4,
        O: PDFHexString.of('00'.repeat(32)),
        U: PDFHexString.of('00'.repeat(32)),
      }),
    );
    await expect(mergePDFs([await encrypted.save()])).rejects.toMatchObject({
      code: 'INVALID_SOURCE',
      message: expect.stringContaining('encrypted'),
    });
  });

  it('rejects empty/malformed sources and invalid page selections with stable diagnostics', async () => {
    await expect(mergePDFs([])).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    await expect(mergePDFs([new Uint8Array()])).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    await expect(mergePDFs([new TextEncoder().encode('not a PDF')])).rejects.toMatchObject({
      code: 'INVALID_SOURCE',
    });
    const source = await fixture();
    for (const selection of [[], [0], [-1], [1.5], [3], [NaN]]) {
      await expect(extractPDFPages(source, selection)).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
      });
    }
    await expect(mergePDFs([source], { onProgress: 1 } as never)).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    await expect(mergePDFs([source], { signal: {} } as never)).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
    const tooMany = await PDFDocument.create();
    for (let index = 0; index < 1001; index += 1) tooMany.addPage([10, 10]);
    await expect(mergePDFs([await tooMany.save()])).rejects.toMatchObject({
      code: 'INVALID_SOURCE',
    });
    tooMany.removePage(1000);
    let extraReads = 0;
    await expect(
      mergePDFs([
        await tooMany.save(),
        source,
        {
          toUint8Array: async () => {
            extraReads += 1;
            return source;
          },
        },
      ]),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(extraReads).toBe(0);
  });

  it('reports frozen stage-local progress and preserves callback failures and cancellation', async () => {
    const source = await fixture();
    const events: RenderProgress[] = [];
    await mergePDFs([source], { onProgress: (event) => events.push(event) });
    expect([...new Set(events.map((event) => event.stage))]).toEqual([
      'preparing',
      'resources',
      'pages',
      'saving',
      'complete',
    ]);
    expect(events.every((event) => Object.isFrozen(event) && event.completed <= event.total)).toBe(
      true,
    );
    expect(events.at(-1)).toEqual({ stage: 'complete', completed: 1, total: 1 });
    const failure = new Error('Application callback failed.');
    await expect(
      mergePDFs([source], {
        onProgress: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    const controller = new AbortController();
    await expect(
      mergePDFs([source], {
        signal: controller.signal,
        onProgress: (event) => {
          if (event.stage === 'pages' && event.completed === 1) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(mergePDFs([source], { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
