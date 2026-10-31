// Unicode regression samples use explicit escapes to preserve the tested glyphs.
import { readFile } from 'node:fs/promises';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { expect, it } from 'vite-plus/test';
import { writePDF } from '../src/pdf';
import type { PageGeometry, RegisteredFont } from '../src/api-types';
import type { LayoutSnapshot, TextOperation } from '../src/types';

/** Licensed static font used for both native PDF widths and Unicode extraction. */
const font: RegisteredFont = {
  family: 'Writer Test Sans',
  weight: 400,
  style: 'normal',
  bytes: new Uint8Array(
    await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)),
  ),
};

/** RTL regression face with independent Arabic glyph substitutions. */
const arabicFont: RegisteredFont = {
  family: 'Writer Test Arabic',
  weight: 400,
  style: 'normal',
  bytes: new Uint8Array(
    await readFile(new URL('../public/fonts/NotoSansArabic-Regular.ttf', import.meta.url)),
  ),
};

/** CFF outline face verifies the conservative full-font fallback. */
const hanFont: RegisteredFont = {
  family: 'Writer Test Han',
  weight: 400,
  style: 'normal',
  bytes: new Uint8Array(
    await readFile(new URL('../public/fonts/RenderPDFHanTest-Regular.otf', import.meta.url)),
  ),
};

/** Variable TrueType face verifies that its default instance remains usable. */
const variableFont: RegisteredFont = {
  family: 'Writer Test Variable',
  weight: 400,
  style: 'normal',
  bytes: new Uint8Array(
    await readFile(new URL('../public/fonts/Roboto-Variable.ttf', import.meta.url)),
  ),
};

/** Synthetic page uses one physical scale and keeps each shaped sample on its own line. */
const geometry: PageGeometry = {
  width: 400,
  height: 200,
  margin: { top: 20, right: 20, bottom: 20, left: 20 },
};

/** Build one measured line without requiring an unrelated browser layout fixture. */
function line(
  /** Source Unicode text retained as one shaped browser run. */
  text: string,
  /** Line top in source CSS pixels. */
  y: number,
  /** Match the browser's font-kerning selection. */
  kerning = true,
  /** Exact registered face selected for the line. */
  face: RegisteredFont = font,
): TextOperation {
  return {
    kind: 'text',
    bounds: { x: 0, y, width: 250, height: 20 },
    text,
    runs: [{ text, x: 0, width: 250 }],
    baseline: y + 16,
    fontSize: 18,
    family: face.family,
    weight: face.weight,
    style: face.style,
    kerning,
    color: 'rgb(0, 0, 0)',
    invisible: false,
  };
}

/** Read the saved stream through the dependency's public PDF object API. */
async function content(
  /** Complete writer output including the compressed page stream. */
  bytes: Uint8Array,
): Promise<string> {
  // Reloading verifies the bytes that consumers receive, not in-memory writer state.
  const loaded = await PDFDocument.load(bytes);
  const contents = loaded.getPage(0).node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  return streams
    .map((entry) => {
      const stream = loaded.context.lookup(entry);
      if (!(stream instanceof PDFRawStream)) throw new Error('Missing PDF content stream.');
      return new TextDecoder().decode(decodePDFRawStream(stream).decode());
    })
    .join('\n');
}

it('groups shaped glyphs while preserving kerning, ligatures, marks and Unicode extraction', async () => {
  // The cases cover distinct positioning paths, including a deliberately unkerned line.
  const samples = [
    line('AVATAR', 0),
    line('office', 30),
    line('a\u0301', 60),
    line('AVATAR', 90, false),
  ];
  // One synthetic page keeps the PDF stream inspection independent of DOM layout.
  const snapshot: LayoutSnapshot = {
    width: 300,
    height: 120,
    operations: samples,
    warnings: [],
  };
  const result = await writePDF(snapshot, [font], geometry, [{ start: 0, end: 120 }]);
  // A few lines need only a small TrueType subset, not the whole source program.
  expect(result.bytes.length).toBeLessThan(font.bytes.length / 2);
  const stream = await content(result.bytes);
  // A whole horizontal span uses one matrix; kerning is encoded as TJ displacement.
  expect((stream.match(/\bTm\b/g) ?? []).length).toBeLessThanOrEqual(6);
  expect(stream).toMatch(/\bTJ\b/);
  // PDF.js validates the saved ToUnicode map and reader-visible text as an independent parser.
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: Uint8Array.from(result.bytes), useSystemFonts: false });
  try {
    const pdf = await task.promise;
    const text = await (await pdf.getPage(1)).getTextContent();
    const extracted = text.items.flatMap((item) => ('str' in item ? [item.str] : [])).join('');
    expect(extracted.normalize('NFD').replace(/\s/gu, '')).toBe(
      'AVATARofficea\u0301AVATAR'.normalize('NFD'),
    );
  } finally {
    await task.destroy();
  }
});

it('keeps multilingual Unicode and page ownership with TrueType subsets and CFF fallback', async () => {
  // Separate slices make a page shift visible in independent PDF.js extraction.
  const snapshot: LayoutSnapshot = {
    width: 300,
    height: 200,
    operations: [
      line('P\u0159\u00edli\u0161 \u017elu\u0165ou\u010dk\u00fd k\u016f\u0148', 0),
      line('office a\u0301', 30),
      line('\u062a\u0642\u0631\u064a\u0631 \u0631\u0642\u0645', 110, true, arabicFont),
      line('\u4e2d\u6587\u6d4b\u8bd5', 140, true, hanFont),
      line('Roboto variable', 170, true, variableFont),
    ],
    warnings: [],
  };
  const result = await writePDF(snapshot, [font, arabicFont, hanFont, variableFont], geometry, [
    { start: 0, end: 100 },
    { start: 100, end: 200 },
  ]);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: Uint8Array.from(result.bytes), useSystemFonts: false });
  try {
    const pdf = await task.promise;
    expect(pdf.numPages).toBe(2);
    // PDF.js is an independent parser of the serialized font files and ToUnicode maps.
    const pageTexts: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pageTexts.push(content.items.flatMap((item) => ('str' in item ? [item.str] : [])).join(''));
    }
    expect(pageTexts[0]!.replace(/\s/gu, '').normalize('NFD')).toContain(
      'P\u0159\u00edli\u0161\u017elu\u0165ou\u010dk\u00fdk\u016f\u0148officea\u0301'.normalize(
        'NFD',
      ),
    );
    expect(pageTexts[1]!.replace(/\s/gu, '')).toContain(
      '\u062a\u0642\u0631\u064a\u0631\u0631\u0642\u0645',
    );
    expect(pageTexts[1]!.replace(/\s/gu, '')).toContain('\u4e2d\u6587\u6d4b\u8bd5');
    expect(pageTexts[1]).toContain('Roboto variable');
    expect(pageTexts[0]).not.toContain('Roboto variable');
    expect(pageTexts[1]).not.toContain('office');
  } finally {
    await task.destroy();
  }
});
