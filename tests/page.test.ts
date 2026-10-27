import { describe, expect, it } from 'vite-plus/test';
import type { RenderPDFOptions } from '../src/api-types';
import { resolvePage } from '../src/page';

/** One structural face is sufficient for paper validation; browser registration is tested separately. */
const fonts = [
  { family: 'Paper Test', weight: 400, style: 'normal' as const, bytes: new Uint8Array([1]) },
];

describe('public page options', () => {
  it('uses CSS-pixel margins and maps Letter landscape without scaling the source', () => {
    // Asymmetric copied margins expose axis swaps and mutable option ownership.
    const margin = { top: 30, right: 28, bottom: 34, left: 40 };
    // Letter dimensions are exact points, converted once to reference CSS pixels.
    const page = resolvePage({ fonts, format: 'Letter', orientation: 'landscape', margin });
    expect(page).toEqual({ width: 1056, height: 816, margin });
    margin.left = 80;
    expect(page.margin.left).toBe(40);
    expect(resolvePage({ fonts }).width).toBeCloseTo(793.707, 2);
    expect(resolvePage({ fonts, format: 'A3' }).height).toBe(1190.55 / 0.75);
    expect(resolvePage({ fonts, format: { width: 500, height: 400 }, margin: 20 })).toEqual({
      width: 500,
      height: 400,
      margin: { top: 20, right: 20, bottom: 20, left: 20 },
    });
    expect(
      resolvePage({ fonts, format: { width: 500, height: 400 }, orientation: 'landscape' }).width,
    ).toBe(400);
    // Auto orientation keeps portrait paper during preflight; the measured renderer chooses later.
    expect(resolvePage({ fonts, format: 'Letter', orientation: 'auto' }).width).toBe(816);
    expect(resolvePage({ fonts, fit: 'width' }).width).toBeCloseTo(793.707, 2);
  });

  it('rejects invalid runtime options before a browser or PDF document is needed', () => {
    // JavaScript consumers can supply values outside the compile-time union.
    const invalid = [
      { fonts: [] },
      { fonts, format: 'Unknown' },
      { fonts, format: { width: 0, height: 400 } },
      { fonts, format: { width: 500, height: Number.POSITIVE_INFINITY } },
      { fonts, format: { width: 500 } },
      { fonts, orientation: 'sideways' },
      { fonts, fit: 'stretch' },
      { fonts, margin: Number.NaN },
      { fonts, margin: -1 },
      { fonts, margin: 1000 },
      { fonts, margin: { top: 0, right: 0, left: 0 } },
      { fonts, rasterScale: 0 },
      { fonts, onWarning: 'log' },
      { fonts, fallback: 'everything' },
      { fonts, pageBreak: 'print' },
    ];
    for (const options of invalid) {
      expect(() => resolvePage(options as RenderPDFOptions)).toThrow(
        expect.objectContaining({ code: 'INVALID_OPTIONS' }),
      );
    }
  });
});
