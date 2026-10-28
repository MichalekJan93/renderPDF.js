import { readFile } from 'node:fs/promises';
import { PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { describe, expect, it } from 'vite-plus/test';
import { PositionedFont } from '../src/text';

/** Use the same openly licensed static program as the browser regression fixtures. */
const bytes = new Uint8Array(
  await readFile(new URL('../public/fonts/NotoSans-Regular.ttf', import.meta.url)),
);

/** Create a public embedded font and its independent positioning adapter. */
async function face() {
  const document = await PDFDocument.create();
  const fontkit = (await import('@pdf-lib/fontkit')).default;
  document.registerFontkit(fontkit);
  const font = await document.embedFont(bytes);
  return { document, font, positioned: new PositionedFont(font, bytes) };
}

describe('positioned PDF text', () => {
  it('uses kerning advances without stretching glyph outlines or following word endpoints', async () => {
    const { positioned } = await face();
    const kerned = positioned.shape('AVATAR');
    const unkerned = positioned.shape('AVATAR', false);
    // Noto Sans places V forty units closer to A and compounds later pair adjustments.
    expect(kerned.map((glyph) => glyph.x)).toEqual([0, 599, 1159, 1728, 2214, 2853]);
    expect(unkerned.map((glyph) => glyph.x)).toEqual([0, 639, 1239, 1878, 2434, 3073]);
    expect(kerned.map((glyph) => glyph.encoded.asString())).toEqual(
      unkerned.map((glyph) => glyph.encoded.asString()),
    );
    expect(positioned.shape('AVATAR')).toBe(kerned);
  });

  it('keeps ligature substitutions and positions combining marks at their anchor', async () => {
    const { positioned } = await face();
    const ligature = positioned.shape('office');
    // The six source letters shape to o + ffi + c + e, retaining a complete word context.
    expect(ligature).toHaveLength(4);
    expect(ligature.map((glyph) => glyph.x)).toEqual([0, 605, 1551, 2031]);
    const marked = positioned.shape('a\u0301');
    expect(marked).toHaveLength(2);
    // The acute's GPOS anchor shifts left of the unadjusted 561-unit pen origin.
    expect(marked.map((glyph) => glyph.x)).toEqual([0, 553]);
  });

  it('embeds explicit Unicode mappings for ligature and combining glyphs through public PDF objects', async () => {
    const { document, font, positioned } = await face();
    const ligature = positioned.shape('ffi')[0]!;
    const marked = positioned.shape('a\u0301')[1]!;
    await positioned.embedUnicode(document);
    const dictionary = document.context.lookup(font.ref, PDFDict);
    const stream = document.context.lookup(dictionary.get(PDFName.of('ToUnicode')));
    if (!(stream instanceof PDFRawStream)) throw new Error('Missing Unicode CMap stream.');
    const cmap = new TextDecoder().decode(decodePDFRawStream(stream).decode());
    expect(cmap).toContain(`<${ligature.encoded.asString()}> <006600660069>`);
    expect(cmap).toContain(`<${marked.encoded.asString()}> <0301>`);
    // Saving must not replace the completed mapping with the dependency's cmap-only default.
    await document.save();
    expect(dictionary.get(PDFName.of('ToUnicode'))).toBeDefined();
    const savedStream = document.context.lookup(dictionary.get(PDFName.of('ToUnicode')));
    if (!(savedStream instanceof PDFRawStream)) throw new Error('Missing saved Unicode CMap.');
    expect(new TextDecoder().decode(decodePDFRawStream(savedStream).decode())).toBe(cmap);
  });
});
