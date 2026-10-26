import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import type { RegisteredFont, RenderPDFOptions } from '../../src/index';
import type { InspectedPage } from './pdf-inspector';

/** Register explicit static fonts and create independently identifiable synthetic rows. */
async function loadFixture(
  /** Browser page that owns the live source and its registered faces. */
  page: Page,
): Promise<void> {
  await page.goto('/tests/fixtures/page-bands.html');
  await page.evaluate(async () => {
    // Public browser imports retain the same contract as ordinary package consumers.
    const modulePath = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    // Two family registrations exercise an explicit band face independently from the source face.
    const response = await fetch('/fonts/NotoSans-Regular.ttf');
    const data = await response.arrayBuffer();
    const fonts = await Promise.all(
      ['Statement Sans', 'Page Band Sans'].map((family) => api.registerFont({ family, data })),
    );
    (window as unknown as { pageBandFonts: RegisteredFont[] }).pageBandFonts = fonts;
    // Unique endpoints expose missing, duplicated, or physically split table rows.
    const body = document.querySelector('#statement tbody')!;
    body.innerHTML = Array.from({ length: 32 }, (_, index) => {
      const identifier = String(index + 1).padStart(3, '0');
      return `<tr><td>ROW${identifier}A</td><td>ROW${identifier}B</td></tr>`;
    }).join('');
    await document.fonts.ready;
  });
}

/** Decode text and pixels through PDF.js, independently from the library writer. */
async function inspect(
  /** Browser context used only for the independent PDF decoder. */
  page: Page,
  /** Complete serialized bytes returned by the public export API. */
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

/** Normalize extraction whitespace while preserving order and unique synthetic markers. */
function pageText(
  /** Independently decoded page whose selectable text is under test. */
  page: InspectedPage,
): string {
  return page.text
    .map((item) => item.text)
    .join('')
    .replace(/\s+/g, '');
}

test('repeated native table headers and selectable page bands preserve every row and column', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await loadFixture(page);
  const source = page.locator('#statement');
  const originalMarkup = await source.evaluate((element) => element.outerHTML);
  const evidence = await page.evaluate(async () => {
    const modulePath = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const root = document.querySelector<HTMLElement>('#statement')!;
    const fonts = (window as unknown as { pageBandFonts: RegisteredFont[] }).pageBandFonts;
    // Bands reserve another 60px after the original 20px physical page margins.
    const options: RenderPDFOptions = {
      fonts,
      format: { width: 500, height: 400 },
      margin: 20,
      header: { text: 'Výpis účtu', height: 32, fontSize: 12, align: 'left', font: fonts[1]! },
      footer: {
        text: 'Strana {pageNumber} z {pageCount}',
        height: 28,
        fontSize: 11,
        align: 'right',
      },
    };
    const repeated = await api.renderPDF(root, { ...options, repeatTableHeaders: true });
    // Omitting the opt-in flag is an observable compatibility control for the old behavior.
    const original = await api.renderPDF(root, options);
    const origin = root.getBoundingClientRect();
    const firstCells = Array.from(root.querySelectorAll('tbody tr:first-child td'), (cell) => {
      const range = document.createRange();
      range.selectNodeContents(cell);
      return range.getBoundingClientRect().left - origin.left;
    });
    return {
      bytes: Array.from(await repeated.toUint8Array()),
      originalBytes: Array.from(await original.toUint8Array()),
      pageCount: repeated.pageCount,
      firstCells,
    };
  });
  const pages = await inspect(page, evidence.bytes);
  const originalPages = await inspect(page, evidence.originalBytes);
  const texts = pages.map(pageText);
  expect(pages.length).toBeGreaterThanOrEqual(4);
  expect(evidence.pageCount).toBe(pages.length);
  expect(
    originalPages
      .map(pageText)
      .join('')
      .match(/TABHEAD/g),
  ).toHaveLength(1);
  for (let index = 0; index < pages.length; index += 1) {
    const pdfPage = pages[index]!;
    const text = texts[index]!;
    expect(text.match(/TABHEAD/g)).toHaveLength(1);
    expect(text.match(/Výpisúčtu/g)).toHaveLength(1);
    expect(text.match(new RegExp(`Strana${index + 1}z${pages.length}`, 'g'))).toHaveLength(1);
    // Selection order follows the same top-to-bottom flow as the independently rendered pixels.
    expect(text).toMatch(/^VýpisúčtuTABHEADKontrola(?:ROW\d{3}AROW\d{3}B)+Strana\d+z\d+$/);
    expect(pdfPage.imagePaints).toBe(0);
    // Body text stays below both bands and the 32px table header on every physical page.
    const rows = pdfPage.text.filter((item) => /ROW\d{3}[AB]/.test(item.text));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const baseline = pdfPage.height - row.transform[5]! / 0.75;
      expect(baseline).toBeGreaterThanOrEqual(84);
      expect(baseline).toBeLessThanOrEqual(352);
      const column = row.text.endsWith('A') ? 0 : 1;
      expect(row.transform[4]! / 0.75).toBeCloseTo(20 + evidence.firstCells[column]!, 2);
    }
    const heading = pdfPage.text.find((item) => item.text.includes('Výpis'))!;
    const footer = pdfPage.text.find((item) => item.text.includes('Strana'))!;
    expect(heading).toBeDefined();
    expect(footer).toBeDefined();
    expect(pdfPage.height - heading.transform[5]! / 0.75).toBeLessThan(52);
    expect(pdfPage.height - footer.transform[5]! / 0.75).toBeGreaterThan(352);
    expect(heading.fontName).not.toBe(rows[0]!.fontName);
    // Solid interior pixels verify repeated header paint, beyond merely repeating its text layer.
    const image = PNG.sync.read(Buffer.from(pdfPage.png.split(',')[1]!, 'base64'));
    const offset = ((52 + 4) * image.width + 20 + 4) * 4;
    expect(Array.from(image.data.subarray(offset, offset + 4))).toEqual([225, 235, 245, 255]);
    await writeFile(testInfo.outputPath(`page-bands-${index + 1}.png`), PNG.sync.write(image));
  }
  for (let index = 1; index <= 32; index += 1) {
    const identifier = String(index).padStart(3, '0');
    expect(texts.join('').match(new RegExp(`ROW${identifier}A`, 'g'))).toHaveLength(1);
    expect(texts.join('').match(new RegExp(`ROW${identifier}B`, 'g'))).toHaveLength(1);
    expect(
      texts.filter(
        (text) => text.includes(`ROW${identifier}A`) && text.includes(`ROW${identifier}B`),
      ),
    ).toHaveLength(1);
  }
  await writeFile(testInfo.outputPath('page-bands.pdf'), Buffer.from(evidence.bytes));
  expect(await source.evaluate((element) => element.outerHTML)).toBe(originalMarkup);
});

test('a table header near the page bottom moves together with its first complete row', async ({
  page,
}) => {
  await loadFixture(page);
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('#statement')!;
    const body = root.querySelector('tbody')!;
    // Only 40px remain after the introduction: enough for the header, but not the first row.
    body.replaceChildren(...Array.from(body.children).slice(0, 2));
    const introduction = document.createElement('p');
    introduction.textContent = 'INTRO';
    const spacer = document.createElement('div');
    spacer.style.height = '240px';
    root.prepend(introduction, spacer);
  });
  const source = page.locator('#statement');
  const originalMarkup = await source.evaluate((element) => element.outerHTML);
  const bytes = await page.evaluate(async () => {
    const modulePath = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const fonts = (window as unknown as { pageBandFonts: RegisteredFont[] }).pageBandFonts;
    const result = await api.renderPDF(document.querySelector<HTMLElement>('#statement')!, {
      fonts,
      format: { width: 500, height: 400 },
      margin: 20,
      repeatTableHeaders: true,
      header: { text: 'Výpis účtu', height: 32 },
      footer: { text: 'Strana {pageNumber} z {pageCount}', height: 28 },
    });
    return Array.from(await result.toUint8Array());
  });
  const pages = await inspect(page, bytes);
  expect(pages).toHaveLength(2);
  expect(pageText(pages[0]!)).toContain('INTRO');
  expect(pageText(pages[0]!)).not.toContain('TABHEAD');
  expect(pageText(pages[1]!).match(/TABHEAD/g)).toHaveLength(1);
  expect(pageText(pages[1]!)).toContain('ROW001AROW001BROW002AROW002B');
  expect(await source.evaluate((element) => element.outerHTML)).toBe(originalMarkup);
});

test('tight table border spacing fits a complete row below each repeated header', async ({
  page,
}) => {
  await loadFixture(page);
  const evidence = await page.evaluate(async () => {
    const modulePath = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const fonts = (window as unknown as { pageBandFonts: RegisteredFont[] }).pageBandFonts;
    const root = document.querySelector<HTMLElement>('#statement')!;
    const table = root.querySelector('table')!;
    const body = table.tBodies[0]!;
    body.replaceChildren(...Array.from(body.children).slice(0, 2));
    // Preserve the browser's outer 2px gaps while making the first cluster fit exactly in 102px.
    table.style.borderSpacing = '2px';
    for (const cell of table.tHead!.querySelectorAll('th')) {
      cell.style.height = '20px';
      cell.style.padding = '0';
      cell.style.fontSize = '12px';
      cell.style.lineHeight = '18px';
    }
    for (const [index, row] of Array.from(body.rows).entries()) {
      for (const cell of row.cells) {
        cell.style.height = index === 0 ? '78px' : '80px';
        cell.style.padding = '0';
      }
    }
    // The trailing outer table gap belongs with real following content, rather than an empty page.
    const ending = document.createElement('p');
    ending.textContent = 'END';
    root.append(ending);
    const markup = root.outerHTML;
    const origin = root.getBoundingClientRect();
    const head = table.tHead!.getBoundingClientRect();
    const rows = Array.from(body.rows, (row) => {
      const bounds = row.getBoundingClientRect();
      return { top: bounds.top - origin.top, bottom: bounds.bottom - origin.top };
    });
    const result = await api.renderPDF(root, {
      fonts,
      format: { width: 500, height: 142 },
      margin: 20,
      repeatTableHeaders: true,
    });
    return {
      bytes: Array.from(await result.toUint8Array()),
      head: { top: head.top - origin.top, height: head.height },
      rows,
      unchanged: markup === root.outerHTML,
    };
  });
  expect(evidence.head).toEqual({ top: 2, height: 20 });
  expect(evidence.rows).toEqual([
    { top: 24, bottom: 102 },
    { top: 104, bottom: 184 },
  ]);
  const pages = await inspect(page, evidence.bytes);
  const texts = pages.map(pageText);
  expect(pages).toHaveLength(3);
  expect(texts[0]).toBe('TABHEADKontrolaROW001AROW001B');
  expect(texts[1]).toBe('TABHEADKontrolaROW002AROW002B');
  expect(texts[2]).toBe('END');
  expect(pages.every((pdfPage) => pdfPage.imagePaints === 0)).toBe(true);
  expect(evidence.unchanged).toBe(true);
});

test('invalid page bands and impossible repeated headers fail with actionable public diagnostics', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await loadFixture(page);
  const evidence = await page.evaluate(async () => {
    const modulePath = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const fonts = (window as unknown as { pageBandFonts: RegisteredFont[] }).pageBandFonts;
    const source = document.querySelector<HTMLElement>('#statement')!;
    const options: RenderPDFOptions = {
      fonts: [fonts[0]!],
      format: { width: 500, height: 400 },
      margin: 20,
    };
    const errors: Record<string, { code: string; message: string }> = {};
    /** Capture runtime diagnostics even for JavaScript callers bypassing static option types. */
    async function reject(
      /** Identifies one independently exercised malformed or impossible option set. */
      label: string,
      /** Runtime option object passed through the real public rendering entry. */
      extra: Record<string, unknown>,
    ): Promise<void> {
      try {
        await api.renderPDF(source, { ...options, ...extra } as RenderPDFOptions);
        errors[label] = { code: 'NO_ERROR', message: '' };
      } catch (error) {
        errors[label] = {
          code: error instanceof api.RenderPDFError ? error.code : '',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    await reject('repeatType', { repeatTableHeaders: 'true' });
    await reject('height', { header: { text: 'Výpis', height: -1 } });
    await reject('size', { footer: { text: 'Výpis', height: 28, fontSize: Number.NaN } });
    await reject('align', { header: { text: 'Výpis', height: 32, align: 'justify' } });
    await reject('reserves', { header: { text: 'Výpis', height: 360 } });
    await reject('font', { header: { text: 'Výpis', height: 32, font: fonts[1]! } });
    await reject('line', { header: { text: 'První\nDruhý', height: 32 } });
    await reject('wide', { header: { text: 'A'.repeat(200), height: 32 } });
    await reject('short', { header: { text: 'Výpis', height: 2, fontSize: 12 } });
    // The header plus one atomic body row must fit after reserving both page bands.
    source.querySelector<HTMLElement>('thead th')!.style.height = '280px';
    await reject('table', {
      repeatTableHeaders: true,
      header: { text: 'Výpis', height: 32 },
      footer: { text: 'Strana {pageNumber}', height: 28 },
    });
    // A short line box can paint below THEAD while remaining inside the header/body spacing.
    source.querySelector<HTMLTableElement>('table')!.style.borderSpacing = '0 12px';
    for (const cell of source.querySelectorAll<HTMLElement>('thead th')) {
      cell.style.cssText = 'height: 0; padding: 20px 8px 0; font-size: 20px; line-height: 4px';
    }
    const head = source.querySelector('thead')!.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(source.querySelector('thead th')!);
    const paint = range.getBoundingClientRect();
    const bodyTop = source.querySelector('tbody tr')!.getBoundingClientRect().top;
    if (paint.top < head.top || paint.bottom <= head.bottom || paint.bottom > bodyTop) {
      throw new Error('The overflow fixture must paint only into the spacing below THEAD.');
    }
    await reject('headerPaint', { repeatTableHeaders: true });
    return errors;
  });
  for (const label of ['repeatType', 'height', 'size', 'align', 'reserves', 'font', 'line']) {
    expect(evidence[label]!.code, label).toBe('INVALID_OPTIONS');
    expect(evidence[label]!.message.length, label).toBeGreaterThan(10);
  }
  for (const label of ['wide', 'short']) {
    expect(evidence[label]!.code, label).toBe('SOURCE_OVERFLOW');
    expect(evidence[label]!.message).toMatch(/header|band/i);
  }
  expect(evidence.table!.code).toBe('PAGINATION_FAILED');
  expect(evidence.table!.message).toMatch(/header|row|fit/i);
  expect(evidence.headerPaint!.code).toBe('UNSUPPORTED_CSS');
  expect(evidence.headerPaint!.message).toMatch(/overflowing paint/i);
});
