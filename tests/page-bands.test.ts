import { describe, expect, it } from 'vite-plus/test';
import type { RenderPDFOptions } from '../src/api-types';
import { resolvePageBands } from '../src/page-bands';
import { resolvePage } from '../src/page';

/** Structural font handles suffice for option validation without starting a browser. */
const fonts = [
  { family: 'Band Sans', weight: 400, style: 'normal' as const, bytes: new Uint8Array([1]) },
];

describe('reserved page text areas', () => {
  it('copies caller settings and adds both bands to content margins without scaling', () => {
    const header = { text: 'Statement {pageNumber}/{pageCount}', height: 30 };
    const options: RenderPDFOptions = {
      fonts,
      header,
      footer: { text: 'End', height: 24, align: 'right' },
      margin: 20,
    };
    const page = resolvePage(options);
    const bands = resolvePageBands(page, options);
    header.text = 'Changed';
    header.height = 200;
    expect(bands.header).toEqual({
      text: 'Statement {pageNumber}/{pageCount}',
      height: 30,
      font: fonts[0],
      fontSize: 12,
      align: 'left',
    });
    expect(Object.isFrozen(bands.header)).toBe(true);
    expect(bands.content.margin).toEqual({ top: 50, right: 20, bottom: 44, left: 20 });
    expect(page.margin).toEqual({ top: 20, right: 20, bottom: 20, left: 20 });
    expect(bands.content.width).toBe(page.width);
    expect(bands.content.height).toBe(page.height);
  });

  it('preserves original geometry when page text is absent', () => {
    const options = { fonts };
    const page = resolvePage(options);
    expect(resolvePageBands(page, options)).toEqual({
      content: page,
      header: undefined,
      footer: undefined,
    });
  });

  it('resolves independent left and right text without changing the shared reserved height', () => {
    const options: RenderPDFOptions = {
      fonts,
      margin: 20,
      footer: { height: 26, left: 'Printed by: Example', right: 'Page {pageNumber}/{pageCount}' },
    };
    const bands = resolvePageBands(resolvePage(options), options);
    expect(bands.footer).toMatchObject({
      kind: 'slots',
      height: 26,
      lines: [
        { text: 'Printed by: Example', align: 'left' },
        { text: 'Page {pageNumber}/{pageCount}', align: 'right' },
      ],
    });
    expect(bands.content.margin.bottom).toBe(46);
  });

  it('rejects malformed bands and an exhausted content area before DOM preparation', () => {
    const invalid: unknown[] = [
      null,
      'header',
      {},
      { text: 12, height: 30 },
      { text: 'Title', height: 0 },
      { text: 'Title', height: Number.NaN },
      { text: 'Title', height: Number.POSITIVE_INFINITY },
      { text: 'First\nSecond', height: 30 },
      { text: 'Hidden\u202e', height: 30 },
      { text: 'Title', height: 30, fontSize: 0 },
      { text: 'Title', height: 30, fontSize: Number.NaN },
      { text: 'Title', height: 30, align: 'diagonal' },
      { text: 'Title', height: 30, font: { ...fonts[0] } },
      { height: 30 },
      { height: 30, left: 12 },
    ];
    for (const header of invalid) {
      const options = { fonts, header } as RenderPDFOptions;
      expect(() => resolvePageBands(resolvePage(options), options)).toThrow(
        expect.objectContaining({ code: 'INVALID_OPTIONS' }),
      );
    }
    const options: RenderPDFOptions = {
      fonts,
      format: { width: 300, height: 200 },
      margin: 20,
      header: { text: 'Title', height: 80 },
      footer: { text: 'End', height: 80 },
    };
    expect(() => resolvePageBands(resolvePage(options), options)).toThrow(
      expect.objectContaining({ code: 'INVALID_OPTIONS' }),
    );
    expect(() =>
      resolvePage({ fonts, repeatTableHeaders: 'yes' } as unknown as RenderPDFOptions),
    ).toThrow(expect.objectContaining({ code: 'INVALID_OPTIONS' }));
  });
});
