import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { DevExtremeEvidence, DevExtremePageEvidence } from '../fixtures/devextreme';

test('real DevExtreme exports paged and selected rows with Unicode text, truncation and two-part footers', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/tests/fixtures/devextreme.html');
  await page.waitForFunction(() => 'devextremeFixture' in window);
  const full = await page.evaluate(async () => {
    const fixture = (
      window as unknown as {
        devextremeFixture: { exportGrid(selectedOnly?: boolean): Promise<DevExtremeEvidence> };
      }
    ).devextremeFixture;
    return fixture.exportGrid();
  });
  expect(full.version).toMatch(/^25\.1\./);
  expect(full.pageCount).toBeGreaterThan(1);
  const inspect = async (bytes: number[]): Promise<DevExtremePageEvidence[]> =>
    page.evaluate(async (input) => {
      const fixture = (
        window as unknown as {
          devextremeFixture: { inspectPDF(bytes: number[]): Promise<DevExtremePageEvidence[]> };
        }
      ).devextremeFixture;
      return fixture.inspectPDF(input);
    }, bytes);
  const pages = await inspect(full.bytes);
  const allText = pages.flatMap((item) => item.text.map((text) => text.value)).join('');
  for (let index = 1; index <= 120; index += 1) {
    expect(allText.match(new RegExp(`ROW${String(index).padStart(3, '0')}`, 'g'))).toHaveLength(1);
  }
  expect(allText).toContain('Unicode row \u017d\u0165\u010d\u00fd\u016f\u0148');
  expect(allText).not.toContain('M'.repeat(90));
  for (const [index, item] of pages.entries()) {
    expect(item.width).toBeCloseTo(841.89, 1);
    expect(item.height).toBeCloseTo(595.28, 1);
    expect(item.images).toBe(0);
    const footer = item.text.find((text) => text.value.includes('Printed by:'));
    const counter = item.text.find((text) =>
      text.value.includes(`Page ${index + 1} of ${pages.length}`),
    );
    expect(footer?.value).toContain('Synthetic user');
    expect(footer!.x).toBeCloseTo((10 * 72) / 25.4, 1);
    expect(counter).toBeDefined();
    expect(counter!.y).toBeCloseTo(footer!.y, 1);
    expect(footer!.y).toBeCloseTo((7 * 72) / 25.4, 1);
    expect(counter!.x).toBeGreaterThan(item.width / 2);
    await writeFile(
      testInfo.outputPath(`devextreme-page-${index + 1}.png`),
      Buffer.from(item.png.split(',')[1]!, 'base64'),
    );
  }
  await writeFile(testInfo.outputPath('devextreme-all-rows.pdf'), Uint8Array.from(full.bytes));
  const selection = await page.evaluate(async () => {
    const fixture = (
      window as unknown as {
        devextremeFixture: { exportGrid(selectedOnly?: boolean): Promise<DevExtremeEvidence> };
      }
    ).devextremeFixture;
    return fixture.exportGrid(true);
  });
  const selectedText = (await inspect(selection.bytes))
    .flatMap((item) => item.text.map((text) => text.value))
    .join('');
  expect(selectedText.match(/ROW\d{3}/g)).toEqual(['ROW005', 'ROW040', 'ROW119']);
  expect(selection.pageCount).toBe(1);
  const wide = await page.evaluate(async () => {
    const fixture = (
      window as unknown as {
        devextremeFixture: {
          exportGrid(selectedOnly?: boolean, horizontal?: boolean): Promise<DevExtremeEvidence>;
        };
      }
    ).devextremeFixture;
    return fixture.exportGrid(true, true);
  });
  const widePages = await inspect(wide.bytes);
  expect(wide.pageCount).toBeGreaterThan(1);
  expect(widePages.length).toBe(wide.pageCount);
  expect(errors).toEqual([]);
  await writeFile(
    testInfo.outputPath('devextreme-selected-rows.pdf'),
    Uint8Array.from(selection.bytes),
  );
  await writeFile(
    testInfo.outputPath('devextreme-horizontal-pages.pdf'),
    Uint8Array.from(wide.bytes),
  );
});
