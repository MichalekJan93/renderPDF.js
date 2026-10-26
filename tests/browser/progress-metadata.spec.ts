import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import type { RegisteredFont, RenderPDFOptions, RenderProgress } from '../../src/index';

/** Prepare a static, private-data-free document through the same public entry consumers use. */
async function loadFixture(
  /** Browser page owning this source and its exact registered font. */
  page: Page,
): Promise<void> {
  await page.goto('/tests/fixtures/page-bands.html');
  await page.evaluate(async () => {
    const modulePath = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const response = await fetch('/fonts/NotoSans-Regular.ttf');
    const font = await api.registerFont({
      family: 'Statement Sans',
      data: await response.arrayBuffer(),
    });
    (window as unknown as { progressFont: RegisteredFont }).progressFont = font;
    document.querySelector('#statement tbody')!.innerHTML = Array.from(
      { length: 12 },
      (_, index) => {
        const marker = String(index + 1).padStart(3, '0');
        return `<tr><td>ROW${marker}A</td><td>ROW${marker}B</td></tr>`;
      },
    ).join('');
    await document.fonts.ready;
  });
}

test('immutable progress counts real export work and metadata retains its original Unicode values', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await loadFixture(page);
  const evidence = await page.evaluate(async () => {
    const modulePath = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const root = document.querySelector<HTMLElement>('#statement')!;
    const font = (window as unknown as { progressFont: RegisteredFont }).progressFont;
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#1769aa';
    context.fillRect(0, 0, 8, 8);
    const source = canvas.toDataURL('image/png');
    for (let index = 0; index < 2; index += 1) {
      const image = document.createElement('img');
      image.src = source;
      image.width = 8;
      image.height = 8;
      root.append(image);
      await image.decode();
    }
    const raster = document.createElement('div');
    raster.style.cssText =
      'width: 100px; height: 30px; background: linear-gradient(90deg, #dbeaff, #fff1d2)';
    raster.textContent = 'Razítko';
    root.append(raster);
    const markup = root.outerHTML;
    const events: RenderProgress[] = [];
    const frozen: boolean[] = [];
    let taskObserved = false;
    let firstPageSawTask = false;
    const metadata = {
      title: 'Výpis účtu — 日本語',
      author: 'Žaneta Říhová',
      subject: 'Čtvrtletní přehled',
      keywords: ['čeština', '計算'],
    };
    const options: RenderPDFOptions = {
      fonts: [font],
      format: { width: 500, height: 220 },
      margin: 20,
      repeatTableHeaders: true,
      metadata,
      onProgress: (event) => {
        frozen.push(Object.isFrozen(event));
        events.push(event);
        // UI tasks must get an opportunity to run between page-progress notifications.
        if (event.stage === 'pages' && event.completed === 0) {
          setTimeout(() => {
            taskObserved = true;
          }, 0);
        }
        if (event.stage === 'pages' && event.completed === 1) firstPageSawTask = taskObserved;
      },
    };
    const pending = api.renderPDF(root, options);
    // Callers retain their objects; edits after invocation must not alter the current export.
    metadata.title = 'Changed title';
    metadata.author = 'Changed author';
    metadata.keywords.splice(0, metadata.keywords.length, 'Changed keyword');
    const result = await pending;
    const baseline = await api.renderPDF(root, {
      fonts: [font],
      format: { width: 500, height: 220 },
      margin: 20,
      repeatTableHeaders: true,
    });
    return {
      bytes: Array.from(await result.toUint8Array()),
      baselineBytes: Array.from(await baseline.toUint8Array()),
      events,
      frozen,
      firstPageSawTask,
      pageCount: result.pageCount,
      unchanged: root.outerHTML === markup,
    };
  });
  const pdfDocument = await PDFDocument.load(Uint8Array.from(evidence.bytes));
  const baseline = await PDFDocument.load(Uint8Array.from(evidence.baselineBytes));
  expect(pdfDocument.getTitle()).toBe('Výpis účtu — 日本語');
  expect(pdfDocument.getAuthor()).toBe('Žaneta Říhová');
  expect(pdfDocument.getSubject()).toBe('Čtvrtletní přehled');
  expect(pdfDocument.getKeywords()).toBe('čeština 計算');
  expect(baseline.getTitle()).toBe('RenderPDF.js');
  expect(pdfDocument.getPageCount()).toBe(evidence.pageCount);
  expect(baseline.getPageCount()).toBe(evidence.pageCount);
  expect(evidence.pageCount).toBeGreaterThanOrEqual(3);
  expect(evidence.unchanged).toBe(true);
  expect(evidence.frozen.every(Boolean)).toBe(true);
  expect(evidence.firstPageSawTask).toBe(true);
  const stages = [...new Set(evidence.events.map((event) => event.stage))];
  expect(stages).toEqual([
    'preparing',
    'layout',
    'pagination',
    'resources',
    'pages',
    'saving',
    'complete',
  ]);
  for (const stage of stages) {
    const events = evidence.events.filter((event) => event.stage === stage);
    const total = events[0]!.total;
    expect(total).toBeGreaterThan(0);
    expect(
      events.every(
        (event) =>
          Number.isInteger(event.completed) &&
          event.completed >= 0 &&
          event.completed <= total &&
          event.total === total,
      ),
    ).toBe(true);
    expect(events.map((event) => event.completed)).toEqual(
      events.map((event) => event.completed).sort((left, right) => left - right),
    );
    expect(events[0]!.completed).toBe(stage === 'complete' ? 1 : 0);
    expect(events.at(-1)!.completed).toBe(total);
  }
  expect(
    evidence.events.filter((event) => event.stage === 'resources').map((event) => event.completed),
  ).toEqual([0, 1, 2, 3, 4]);
  expect(
    evidence.events.filter((event) => event.stage === 'pages').map((event) => event.completed),
  ).toEqual(Array.from({ length: evidence.pageCount + 1 }, (_, index) => index));
  expect(evidence.events.at(-1)).toEqual({ stage: 'complete', completed: 1, total: 1 });
  await writeFile(testInfo.outputPath('progress-metadata.pdf'), Buffer.from(evidence.bytes));
});

test('progress callbacks preserve cancellation, original exceptions and source mutation diagnostics', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await loadFixture(page);
  const evidence = await page.evaluate(async () => {
    const modulePath = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const source = document.querySelector<HTMLElement>('#statement')!;
    const font = (window as unknown as { progressFont: RegisteredFont }).progressFont;
    const results: Record<
      string,
      { name: string; code: string; original: boolean; complete: boolean }
    > = {};
    /** Exercise a failure inside the writer rather than only during initial preparation. */
    async function reject(
      /** Failure behavior to trigger after the first physical page has been written. */
      mode: 'abort' | 'throw' | 'mutation' | 'completeMutation',
    ): Promise<void> {
      const controller = new AbortController();
      const expected = new Error('Application progress callback failed.');
      const events: RenderProgress[] = [];
      try {
        await api.renderPDF(source, {
          fonts: [font],
          format: { width: 500, height: 220 },
          margin: 20,
          signal: controller.signal,
          onProgress: (event) => {
            events.push(event);
            if (mode === 'completeMutation' && event.stage === 'complete') {
              source.dataset.changed = 'true';
            }
            if (event.stage !== 'pages' || event.completed !== 1) return;
            if (mode === 'abort') controller.abort();
            if (mode === 'throw') throw expected;
            if (mode === 'mutation') source.dataset.changed = 'true';
          },
        });
        results[mode] = { name: 'NO_ERROR', code: '', original: false, complete: false };
      } catch (error) {
        results[mode] = {
          name: error instanceof Error ? error.name : '',
          code: error instanceof api.RenderPDFError ? error.code : '',
          original: error === expected,
          complete: events.some((event) => event.stage === 'complete'),
        };
      } finally {
        delete source.dataset.changed;
      }
    }
    await reject('abort');
    await reject('throw');
    await reject('mutation');
    await reject('completeMutation');
    return results;
  });
  expect(evidence.abort!.name).toBe('AbortError');
  expect(evidence.throw!.original).toBe(true);
  expect(evidence.mutation!.code).toBe('SOURCE_CHANGED');
  expect(evidence.completeMutation!.code).toBe('SOURCE_CHANGED');
  expect(['abort', 'throw', 'mutation'].every((mode) => !evidence[mode]!.complete)).toBe(true);
});

test('malformed metadata and progress callbacks fail before source preparation', async ({
  page,
}) => {
  await loadFixture(page);
  const evidence = await page.evaluate(async () => {
    const modulePath = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const font = (window as unknown as { progressFont: RegisteredFont }).progressFont;
    const cases: unknown[] = [
      { metadata: null },
      { metadata: [] },
      { metadata: { title: 12 } },
      { metadata: { keywords: 'one,two' } },
      { metadata: { keywords: ['one', 2] } },
      { onProgress: 'report' },
      { onProgress: null },
    ];
    const codes: string[] = [];
    for (const extra of cases) {
      try {
        // An invalid source exposes validation-order regressions instead of hiding them behind export work.
        await api.renderPDF(
          null as unknown as HTMLElement,
          { fonts: [font], ...(extra as object) } as RenderPDFOptions,
        );
        codes.push('NO_ERROR');
      } catch (error) {
        codes.push(error instanceof api.RenderPDFError ? error.code : 'OTHER_ERROR');
      }
    }
    return codes;
  });
  expect(evidence).toEqual(Array.from({ length: 7 }, () => 'INVALID_OPTIONS'));
});
