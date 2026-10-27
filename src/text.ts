import fontkit from '@pdf-lib/fontkit';
import { PDFArray, PDFDict, PDFHexString, PDFName } from 'pdf-lib';
import type { Font } from '@pdf-lib/fontkit';
import type { PDFDocument, PDFFont } from 'pdf-lib';
import { RenderPDFError } from './diagnostics.js';

/** One encoded glyph at its shaped origin, in unscaled font units. */
export interface PositionedGlyph {
  /** Authoritative PDF encoding returned by the public font adapter. */
  encoded: PDFHexString;
  /** Horizontal pen position including the font's placement offset. */
  x: number;
  /** Vertical pen position including the font's placement offset, positive upward. */
  y: number;
}

/** Reusable shaping state for one exact static font during a single export. */
export class PositionedFont {
  /** Original font metrics and OpenType positioning owned by this export. */
  private readonly program: Font;
  /** Identical text runs share shaping work without sharing browser coordinates. */
  private readonly runs = new Map<string, readonly PositionedGlyph[]>();
  /** Used glyph mappings include GSUB ligatures without Unicode cmap entries. */
  private readonly unicode = new Map<string, readonly number[]>();
  /** Used substituted glyphs also need nominal PDF widths even without cmap entries. */
  private readonly widths = new Map<string, number>();
  /** Font units per em, used to convert shaped origins without stretching outlines. */
  readonly unitsPerEm: number;

  /** Own a shaper matching the font program embedded through pdf-lib.
   * @param font Public PDF font whose encoding remains authoritative.
   * @param bytes Exact registered program shared with browser layout.
   */
  constructor(
    readonly font: PDFFont,
    bytes: Uint8Array,
  ) {
    this.program = fontkit.create(bytes);
    this.unitsPerEm = this.program.unitsPerEm;
  }

  /** Shape one browser-measured run while retaining kerning, ligatures and marks.
   * @param text Complete run; splitting into characters would lose OpenType context.
   * @param kerning Whether CSS admits kerning for this line.
   */
  shape(text: string, kerning = true): readonly PositionedGlyph[] {
    const key = `${kerning ? '1' : '0'}:${text}`;
    const previous = this.runs.get(key);
    if (previous) return previous;
    const shaped = this.program.layout(text, { kern: kerning });
    const encoded = this.font.encodeText(text).asString();
    // Static full-font embedding emits one two-byte CID per shaped glyph.
    if (encoded.length !== shaped.glyphs.length * 4) {
      throw new RenderPDFError(
        'PDF_WRITE_FAILED',
        'PDF font encoding disagrees with font shaping.',
      );
    }
    let x = 0;
    let y = 0;
    const positioned = shaped.glyphs.map((glyph, index) => {
      const code = encoded.slice(index * 4, index * 4 + 4);
      // Compare actual codes rather than silently assuming another embedding strategy.
      if (Number.parseInt(code, 16) !== glyph.id) {
        throw new RenderPDFError(
          'PDF_WRITE_FAILED',
          'PDF glyph identifiers disagree with shaping.',
        );
      }
      if (glyph.codePoints.length === 0) {
        throw new RenderPDFError(
          'PDF_WRITE_FAILED',
          'The font produced a shaped glyph without a Unicode source mapping.',
        );
      }
      const position = shaped.positions[index]!;
      // PDF text extractors reorder RTL runs; reverse multi-letter ligature mappings
      // so their internal letters return to logical order after that reordering.
      // shortcut: vowel marks spanning a ligature can still extract out of order; cluster-aware CIDs are needed.
      const points =
        shaped.direction === 'rtl' &&
        glyph.codePoints.length > 1 &&
        glyph.codePoints.every((point) => /\p{L}/u.test(String.fromCodePoint(point)))
          ? [...glyph.codePoints].reverse()
          : [...glyph.codePoints];
      // One PDF CID has one Unicode mapping; keep the first source spelling for aliases.
      if (!this.unicode.has(code)) this.unicode.set(code, points);
      this.widths.set(code, (glyph.advanceWidth * 1000) / this.unitsPerEm);
      const result = {
        encoded: PDFHexString.of(code),
        x: x + position.xOffset,
        y: y + position.yOffset,
      };
      x += position.xAdvance;
      y += position.yAdvance;
      return result;
    });
    this.runs.set(key, positioned);
    return positioned;
  }

  /** Measure shaped advance and ink extents so repeated page text cannot overflow its band.
   * @param text Complete single line using this exact embedded font.
   */
  measure(text: string): { left: number; right: number; ascent: number; descent: number } {
    const run = this.program.layout(text);
    let x = 0;
    let y = 0;
    let left = 0;
    let right = 0;
    let ascent = this.program.ascent;
    let descent = -this.program.descent;
    for (let index = 0; index < run.glyphs.length; index += 1) {
      const glyph = run.glyphs[index]!;
      const position = run.positions[index]!;
      left = Math.min(left, x + position.xOffset + glyph.bbox.minX);
      right = Math.max(right, x + position.xOffset + glyph.bbox.maxX);
      ascent = Math.max(ascent, y + position.yOffset + glyph.bbox.maxY);
      descent = Math.max(descent, -(y + position.yOffset + glyph.bbox.minY));
      x += position.xAdvance;
      y += position.yAdvance;
    }
    return { left, right: Math.max(right, x), ascent, descent };
  }

  /** Preserve extraction for every used shaped glyph, including uncoded ligatures.
   * @param document Export document owning the public font reference and object context.
   */
  async embedUnicode(document: PDFDocument): Promise<void> {
    // Complete ordinary font embedding before replacing only its public ToUnicode entry.
    await this.font.embed();
    if (this.unicode.size === 0) return;
    const mappings = [...this.unicode].map(([code, points]) => {
      const text = String.fromCodePoint(...points);
      let unicode = '';
      // CMap destinations are UTF-16BE code units, including surrogate pairs.
      for (let index = 0; index < text.length; index += 1) {
        unicode += text.charCodeAt(index).toString(16).padStart(4, '0');
      }
      return `<${code}> <${unicode}>`;
    });
    const sections: string[] = [];
    // The PDF specification limits each bfchar section to one hundred entries.
    for (let index = 0; index < mappings.length; index += 100) {
      const chunk = mappings.slice(index, index + 100);
      sections.push(`${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar`);
    }
    const cmap = [
      '/CIDInit /ProcSet findresource begin',
      '12 dict begin',
      'begincmap',
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
      '/CMapName /RenderPDFUnicode def',
      '/CMapType 2 def',
      '1 begincodespacerange',
      '<0000> <ffff>',
      'endcodespacerange',
      ...sections,
      'endcmap',
      'CMapName currentdict /CMap defineresource pop',
      'end',
      'end',
    ].join('\n');
    const dictionary = document.context.lookup(this.font.ref, PDFDict);
    dictionary.set(
      PDFName.of('ToUnicode'),
      document.context.register(document.context.flateStream(cmap)),
    );
    // GSUB-only glyphs may be absent from pdf-lib's cmap-based default width list.
    const descendants = dictionary.lookup(PDFName.of('DescendantFonts'), PDFArray);
    const descendant = descendants.lookup(0, PDFDict);
    const widths = [...this.widths]
      .sort(([first], [second]) => Number.parseInt(first, 16) - Number.parseInt(second, 16))
      .flatMap(([code, width]) => [Number.parseInt(code, 16), [width]]);
    descendant.set(PDFName.of('W'), document.context.obj(widths));
  }
}
