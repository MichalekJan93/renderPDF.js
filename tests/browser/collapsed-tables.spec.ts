import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { PDFDocument } from 'pdf-lib';
import type { RegisteredFont, RenderProgress } from '../../src/index';
import type { InspectedPage } from './pdf-inspector';

/** Load synthetic tables and register the same static face for browser and PDF text. */
async function loadFixture(
  /** Browser document that owns the source and its explicit font registrations. */
  page: Page,
): Promise<void> {
  await page.goto('/tests/fixtures/collapsed-tables.html');
  await page.evaluate(async () => {
    const modulePath = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const response = await fetch('/fonts/NotoSans-Regular.ttf');
    const fonts = [
      await api.registerFont({ family: 'Collapsed Sans', data: await response.arrayBuffer() }),
    ];
    (window as unknown as { collapsedFonts: RegisteredFont[] }).collapsedFonts = fonts;
    // Unique row markers expose missing or duplicated extraction across repeated headers.
    document.querySelector('#continued tbody')!.innerHTML = Array.from(
      { length: 10 },
      (_, index) => {
        const identifier = String(index + 1).padStart(3, '0');
        return `<tr><td>LINE${identifier}A</td><td>LINE${identifier}B</td><td>LINE${identifier}C</td></tr>`;
      },
    ).join('');
    await document.fonts.ready;
  });
}

/** Decode output through independent PDF.js rendering and selectable-text extraction. */
async function inspect(
  /** Browser context that owns the independent PDF decoder worker. */
  page: Page,
  /** Complete serialized output returned by the real public API. */
  bytes: number[],
): Promise<InspectedPage[]> {
  return page.evaluate(async (serializedBytes) => {
    const modulePath = '/tests/browser/pdf-inspector.ts';
    const inspector = (await import(
      /* @vite-ignore */ modulePath
    )) as typeof import('./pdf-inspector');
    return inspector.inspectPdf(serializedBytes);
  }, bytes);
}

/** Read one fully covered interior pixel, away from text ink and antialiasing boundaries. */
function pixel(
  /** Independently rendered browser or PDF bitmap at one pixel per CSS pixel. */
  image: PNG,
  /** Source-relative horizontal sample coordinate. */
  x: number,
  /** Source-relative vertical sample coordinate. */
  y: number,
): number[] {
  const offset = (Math.floor(y) * image.width + Math.floor(x)) * 4;
  return Array.from(image.data.subarray(offset, offset + 4));
}

/** Normalize extraction whitespace without changing synthetic source order. */
function pageText(
  /** Independently inspected PDF page. */
  page: InspectedPage,
): string {
  return page.text
    .map((item) => item.text)
    .join('')
    .replace(/\s+/g, '');
}

test('collapsed shared borders preserve browser pixels, alpha, colspan and rowspan without rasterizing', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await loadFixture(page);
  const source = page.locator('#collapsed');
  const markup = await source.evaluate((element) => element.outerHTML);
  const evidence = await page.evaluate(async () => {
    const modulePath = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const root = document.querySelector<HTMLElement>('#collapsed')!;
    const origin = root.getBoundingClientRect();
    const wider = root.querySelector('#wide-edge')!.getBoundingClientRect();
    const spanning = root.querySelector('#spanning-cell')!.getBoundingClientRect();
    const merged = root.querySelector('#merged-cell')!.getBoundingClientRect();
    const hidden = root.querySelector('#hidden-edge')!.getBoundingClientRect();
    const table = root.querySelector('table')!.getBoundingClientRect();
    const probes = [
      {
        label: 'wider translucent shared edge',
        x: wider.right - origin.left,
        y: (wider.top + wider.bottom) / 2 - origin.top,
      },
      {
        label: 'rowspan suppresses an internal horizontal segment',
        x: spanning.left + 8 - origin.left,
        y: wider.bottom - origin.top,
      },
      {
        label: 'colspan suppresses an internal vertical segment',
        x: wider.right - origin.left,
        y: merged.top + 8 - origin.top,
      },
      {
        label: 'hidden wins over a visible neighboring border',
        x: hidden.left + 8 - origin.left,
        y: hidden.top - origin.top,
      },
      {
        label: 'table outer border participates in conflict resolution',
        x: table.left + 1 - origin.left,
        y: wider.top + 10 - origin.top,
      },
    ];
    const result = await api.renderPDF(root, {
      fonts: (window as unknown as { collapsedFonts: RegisteredFont[] }).collapsedFonts,
      format: { width: 500, height: 420 },
      margin: 20,
    });
    return { bytes: Array.from(await result.toUint8Array()), probes };
  });
  const browserImage = PNG.sync.read(await source.screenshot());
  const pages = await inspect(page, evidence.bytes);
  expect(pages).toHaveLength(1);
  expect(pages[0]!.imagePaints).toBe(0);
  expect(pageText(pages[0]!)).toContain('COLSPANHEADERTHIRDSPANABMERGEDCDE');
  const rendered = PNG.sync.read(Buffer.from(pages[0]!.png.split(',')[1]!, 'base64'));
  const pdfImage = new PNG({ width: browserImage.width, height: browserImage.height });
  PNG.bitblt(rendered, pdfImage, 20, 20, browserImage.width, browserImage.height, 0, 0);
  // A whole-source comparison catches displaced geometry; exact probes catch even one missing edge.
  const changed = pixelmatch(
    browserImage.data,
    pdfImage.data,
    null,
    browserImage.width,
    browserImage.height,
    { threshold: 0.1, includeAA: false },
  );
  expect(changed / (browserImage.width * browserImage.height)).toBeLessThan(0.01);
  for (const probe of evidence.probes) {
    const expected = pixel(browserImage, probe.x, probe.y);
    const actual = pixel(pdfImage, probe.x, probe.y);
    for (let channel = 0; channel < 4; channel += 1) {
      expect(Math.abs(actual[channel]! - expected[channel]!), probe.label).toBeLessThanOrEqual(1);
    }
  }
  // Painting a half-transparent shared edge twice would darken this independently sampled color.
  const shared = pixel(browserImage, evidence.probes[0]!.x, evidence.probes[0]!.y);
  expect(shared[0]).toBeGreaterThan(130);
  expect(shared[0]).toBeLessThan(145);
  expect(await source.evaluate((element) => element.outerHTML)).toBe(markup);
  await writeFile(testInfo.outputPath('collapsed-browser.png'), PNG.sync.write(browserImage));
  await writeFile(testInfo.outputPath('collapsed-pdf.png'), PNG.sync.write(pdfImage));
  await writeFile(testInfo.outputPath('collapsed.pdf'), Buffer.from(evidence.bytes));
});

test('collapsed tables retain repeated native headers and each complete selectable row', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await loadFixture(page);
  const evidence = await page.evaluate(async () => {
    const modulePath = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const events: RenderProgress[] = [];
    const result = await api.renderPDF(document.querySelector<HTMLElement>('#continued')!, {
      fonts: (window as unknown as { collapsedFonts: RegisteredFont[] }).collapsedFonts,
      format: { width: 500, height: 220 },
      margin: 20,
      repeatTableHeaders: true,
      metadata: { title: 'Kolabované okraje — více stran' },
      onProgress: (event) => events.push(event),
    });
    return { bytes: Array.from(await result.toUint8Array()), pageCount: result.pageCount, events };
  });
  const pages = await inspect(page, evidence.bytes);
  const texts = pages.map(pageText);
  expect(pages.length).toBeGreaterThanOrEqual(3);
  expect(evidence.pageCount).toBe(pages.length);
  const metadata = await PDFDocument.load(Uint8Array.from(evidence.bytes));
  expect(metadata.getTitle()).toBe('Kolabované okraje — více stran');
  const pageEvents = evidence.events.filter((event) => event.stage === 'pages');
  expect(pageEvents.every((event) => event.total === pages.length)).toBe(true);
  expect(pageEvents.map((event) => event.completed)).toEqual(
    Array.from({ length: pages.length + 1 }, (_, index) => index),
  );
  expect(evidence.events.at(-1)).toEqual({ stage: 'complete', completed: 1, total: 1 });
  for (const [index, pdfPage] of pages.entries()) {
    expect(texts[index]!.match(/REPEATHEAD/g)).toHaveLength(1);
    expect(texts[index]).toMatch(/^REPEATHEAD(?:LINE\d{3}ALINE\d{3}BLINE\d{3}C)+$/);
    expect(pdfPage.imagePaints).toBe(0);
    await writeFile(
      testInfo.outputPath(`collapsed-continued-${index + 1}.png`),
      Buffer.from(pdfPage.png.split(',')[1]!, 'base64'),
    );
  }
  for (let index = 1; index <= 10; index += 1) {
    const identifier = String(index).padStart(3, '0');
    const row = `LINE${identifier}ALINE${identifier}BLINE${identifier}C`;
    expect(texts.join('').match(new RegExp(row, 'g'))).toHaveLength(1);
    expect(texts.filter((text) => text.includes(row))).toHaveLength(1);
  }
  await writeFile(testInfo.outputPath('collapsed-continued.pdf'), Buffer.from(evidence.bytes));
});

test('collapsed outer half-borders stay with complete rows instead of creating border-only pages', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await loadFixture(page);
  const evidence = await page.evaluate(async () => {
    const modulePath = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const table = document.querySelector<HTMLTableElement>('#conflicts')!;
    table.style.cssText =
      'width: 200px; border: 2px solid #142846; border-collapse: collapse; table-layout: fixed';
    const fonts = (window as unknown as { collapsedFonts: RegisteredFont[] }).collapsedFonts;
    table.innerHTML =
      '<tbody><tr><td style="height:100px;padding:0;border:2px solid #8299af">TIGHT001</td></tr></tbody>';
    const impossibleBounds = table.getBoundingClientRect();
    const impossibleRow = table.rows[0]!.getBoundingClientRect();
    let impossibleCode = 'NO_ERROR';
    try {
      await api.renderPDF(table, {
        fonts,
        format: { width: 200, height: 101 },
        margin: 0,
      });
    } catch (error) {
      impossibleCode = error instanceof api.RenderPDFError ? error.code : '';
    }
    // Two separate rows fit on separate pages only when each keeps its exterior half-stroke.
    table.innerHTML =
      '<tbody><tr><td style="height:40px;padding:0;border:2px solid #8299af">TIGHT001</td></tr>' +
      '<tr><td style="height:40px;padding:0;border:2px solid #8299af">TIGHT002</td></tr></tbody>';
    const origin = table.getBoundingClientRect();
    const rows = Array.from(table.rows, (row) => {
      const bounds = row.getBoundingClientRect();
      return { top: bounds.top - origin.top, bottom: bounds.bottom - origin.top };
    });
    const result = await api.renderPDF(table, {
      fonts,
      format: { width: 200, height: 81 },
      margin: 0,
    });
    return {
      impossibleCode,
      impossibleHeight: impossibleBounds.height,
      impossibleRow: {
        top: impossibleRow.top - impossibleBounds.top,
        bottom: impossibleRow.bottom - impossibleBounds.top,
      },
      height: origin.height,
      rows,
      bytes: Array.from(await result.toUint8Array()),
    };
  });
  expect(evidence.impossibleHeight).toBe(102);
  expect(evidence.impossibleRow).toEqual({ top: 1, bottom: 101 });
  expect(evidence.impossibleCode).toBe('PAGINATION_FAILED');
  expect(evidence.height).toBe(82);
  expect(evidence.rows).toEqual([
    { top: 1, bottom: 41 },
    { top: 41, bottom: 81 },
  ]);
  const pages = await inspect(page, evidence.bytes);
  expect(pages).toHaveLength(2);
  expect(pages.map(pageText)).toEqual(['TIGHT001', 'TIGHT002']);
  expect(pages.every((pdfPage) => pdfPage.imagePaints === 0)).toBe(true);
  await writeFile(
    testInfo.outputPath('collapsed-tight-outer-borders.pdf'),
    Buffer.from(evidence.bytes),
  );
});

test('unsupported collapsed border styles and row-group contributions fail explicitly', async ({
  page,
}) => {
  await loadFixture(page);
  const errors = await page.evaluate(async () => {
    const modulePath = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const root = document.querySelector<HTMLElement>('#collapsed')!;
    const cases = [
      { selector: '#wide-edge', property: 'border-right-style', value: 'dashed' },
      { selector: '#wide-edge', property: 'border-right-style', value: 'double' },
      { selector: 'tbody', property: 'border-top', value: '2px solid red' },
      { selector: '#wide-edge', property: 'display', value: 'block' },
      { selector: 'tbody tr', property: 'display', value: 'block' },
    ];
    const diagnostics: { code: string; message: string }[] = [];
    for (const candidate of cases) {
      const element = root.querySelector<HTMLElement>(candidate.selector)!;
      const original = element.getAttribute('style');
      element.style.setProperty(candidate.property, candidate.value);
      try {
        await api.renderPDF(root, {
          fonts: (window as unknown as { collapsedFonts: RegisteredFont[] }).collapsedFonts,
        });
        diagnostics.push({ code: 'NO_ERROR', message: '' });
      } catch (error) {
        diagnostics.push({
          code: error instanceof api.RenderPDFError ? error.code : '',
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (original === null) element.removeAttribute('style');
        else element.setAttribute('style', original);
      }
    }
    return diagnostics;
  });
  for (const error of errors) {
    expect(error.code).toBe('UNSUPPORTED_CSS');
    expect(error.message).toMatch(/border|row|group|table|display/i);
  }
});
