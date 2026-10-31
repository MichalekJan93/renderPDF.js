import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Inspect the PDF downloaded from the manual browser fixture without using the exporter.
 * @param {string} path Absolute or repository-relative PDF path supplied by the caller.
 */
async function inspectSafariSmoke(path) {
  // Keep original bytes separate because PDF.js may transfer its Uint8Array buffer.
  const bytes = await readFile(path);
  const byteSize = bytes.length;
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  // The independent PDF.js reader exposes page text and paint operations.
  const loadingTask = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
  const pdf = await loadingTask.promise;
  assert.equal(pdf.numPages, 2);
  const imageOperations = new Set([
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
    OPS.paintJpegXObject,
  ]);
  // Page-level ownership catches dropped, duplicated or moved raster text.
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const operations = await page.getOperatorList();
    const text = content.items.map((item) => ('str' in item ? item.str : '')).join('');
    const imagePaints = operations.fnArray.filter((operation) =>
      imageOperations.has(operation),
    ).length;
    assert.equal(imagePaints, 1);
    pages.push({ pageNumber, text, imagePaints });
  }
  // The Czech Unicode phrase is a labeled regression sample, not interface copy.
  assert.match(pages[0].text, /PAGEONE č/);
  assert.match(pages[0].text, /RASTERONE Czech Unicode sample: áčďéěíňóřšťúůýž\./);
  assert.doesNotMatch(pages[0].text, /PAGETWO|RASTERTWO/);
  assert.match(pages[1].text, /PAGETWO ž/);
  assert.match(pages[1].text, /RASTERTWO follows the forced page break\./);
  assert.doesNotMatch(pages[1].text, /PAGEONE|RASTERONE/);
  assert.equal(pages[0].text.split('RASTERONE').length, 2);
  assert.equal(pages[1].text.split('RASTERTWO').length, 2);
  await loadingTask.destroy();
  return {
    path,
    byteSize,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    pageCount: pages.length,
    pages,
  };
}

// A caller-selected path prevents this check from mistaking an older download for today's test.
const path = process.argv[2];
if (!path) throw new Error('Pass the PDF downloaded from tests/fixtures/safari-smoke.html.');
process.stdout.write(`${JSON.stringify(await inspectSafariSmoke(path), null, 2)}\n`);
