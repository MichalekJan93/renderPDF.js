import { describe, expect, it } from 'vite-plus/test';
import type { PDFMetadata, RenderPDFOptions } from '../src/api-types';
import { resolveMetadata } from '../src/export-options';
import { resolvePage } from '../src/page';

/** Structural handles isolate option validation from browser font registration. */
const fonts = [
  { family: 'Export Test', weight: 400, style: 'normal' as const, bytes: new Uint8Array([1]) },
];

describe('PDF metadata and progress options', () => {
  it('copies Unicode metadata and freezes its keyword collection before asynchronous work', () => {
    const metadata = {
      title: 'Výpis účtu — 日本語',
      author: 'Žaneta Říhová',
      subject: 'Čtvrtletní přehled',
      keywords: ['čeština', '計算'],
    };
    const resolved = resolveMetadata(metadata);
    metadata.title = 'Changed';
    metadata.keywords[0] = 'Changed';
    metadata.keywords.push('Added');
    expect(resolved).toEqual({
      title: 'Výpis účtu — 日本語',
      author: 'Žaneta Říhová',
      subject: 'Čtvrtletní přehled',
      keywords: ['čeština', '計算'],
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved!.keywords)).toBe(true);
    expect(resolveMetadata(undefined)).toBeUndefined();
    expect(resolveMetadata({ title: '', keywords: [] })).toEqual({ title: '', keywords: [] });
  });

  it('rejects malformed metadata without silently stringifying caller values', () => {
    const invalid: unknown[] = [
      null,
      [],
      'metadata',
      true,
      { title: 12 },
      { author: null },
      { subject: ['statement'] },
      { keywords: 'one,two' },
      { keywords: ['valid', 12] },
      { keywords: [null] },
    ];
    for (const metadata of invalid) {
      expect(() => resolveMetadata(metadata as PDFMetadata)).toThrow(
        expect.objectContaining({ code: 'INVALID_OPTIONS' }),
      );
    }
  });

  it('accepts a callback and rejects invalid onProgress values before a DOM is needed', () => {
    expect(() => resolvePage({ fonts, onProgress: () => {} })).not.toThrow();
    for (const onProgress of [null, false, 0, 'progress', {}]) {
      expect(() => resolvePage({ fonts, onProgress } as unknown as RenderPDFOptions)).toThrow(
        expect.objectContaining({ code: 'INVALID_OPTIONS' }),
      );
    }
  });
});
