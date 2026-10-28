import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { PNG } from 'pngjs';
import type { RenderProgress } from '../../src/index';
import { jpegOrientation, pngChunk, tiffFrames } from '../helpers/image-fixtures';
import type { InspectedPage } from './pdf-inspector';

/** Distinct interior colors retain identity after ordinary JPEG quantization. */
const colors = [
  [230, 20, 20],
  [20, 190, 40],
  [20, 40, 230],
  [240, 210, 20],
] as const;

/** Produce fictional corner colors with the browser's own PNG and JPEG encoders. */
async function loadFixture(
  /** Browser context used by the real public image export API. */
  page: Page,
): Promise<{ png: number[]; jpeg: number[] }> {
  await page.goto('/tests/fixtures/rendering.html');
  return page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 20;
    const context = canvas.getContext('2d')!;
    for (const [index, color] of ['#e61414', '#14be28', '#1428e6', '#f0d214'].entries()) {
      context.fillStyle = color;
      context.fillRect((index % 2) * 20, Math.floor(index / 2) * 10, 20, 10);
    }
    const png = await fetch(canvas.toDataURL('image/png'));
    const jpeg = await fetch(canvas.toDataURL('image/jpeg', 1));
    return {
      png: Array.from(new Uint8Array(await png.arrayBuffer())),
      jpeg: Array.from(new Uint8Array(await jpeg.arrayBuffer())),
    };
  });
}

/** Independently inspect PDF pixels, page geometry and actual image paint operations. */
async function inspect(
  /** Browser context owning the development-only PDF.js worker. */
  page: Page,
  /** Complete serialized PDF returned by the public conversion result. */
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

/** Read independently rendered RGB values safely inside a known solid-color region. */
function expectColor(
  /** PDF.js bitmap at one pixel per CSS reference pixel. */
  image: PNG,
  /** Horizontal sample point away from color transitions. */
  x: number,
  /** Vertical sample point away from color transitions. */
  y: number,
  /** Independent expected RGB value rather than a renderer-generated comparison. */
  expected: readonly number[],
  /** JPEG's quantization tolerance; lossless paths use the default two-channel-value bound. */
  tolerance = 2,
): void {
  const offset = (Math.floor(y) * image.width + Math.floor(x)) * 4;
  for (let channel = 0; channel < 3; channel += 1) {
    expect(Math.abs(image.data[offset + channel]! - expected[channel]!)).toBeLessThanOrEqual(
      tolerance,
    );
  }
  expect(image.data[offset + 3]).toBe(255);
}

/** Compare four interior corner regions in their expected transformed positions. */
function expectCorners(
  /** PDF.js bitmap whose physical page dimensions are checked separately. */
  image: PNG,
  /** Fitted image rectangle in top-left page coordinates. */
  placement: { x: number; y: number; width: number; height: number },
  /** Expected top-left, top-right, bottom-left and bottom-right color indices. */
  order: readonly number[],
  /** JPEG samples permit small codec differences while preserving color identity. */
  tolerance = 2,
): void {
  for (const [index, color] of order.entries()) {
    expectColor(
      image,
      placement.x + placement.width * (index % 2 === 0 ? 0.25 : 0.75),
      placement.y + placement.height * (index < 2 ? 0.25 : 0.75),
      colors[color]!,
      tolerance,
    );
  }
}

test('PNG File and Blob inputs fit proportionally, report real work and download the generated PDF', async ({
  page,
}, testInfo) => {
  const source = await loadFixture(page);
  const downloaded = page.waitForEvent('download');
  const evidence = await page.evaluate(async (encoded) => {
    const modulePath = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const events: RenderProgress[] = [];
    const file = new File([Uint8Array.from(encoded)], 'fictional-corners.png', {
      type: 'image/png',
    });
    const result = await api.imageToPDF(file, {
      format: { width: 100, height: 80 },
      margin: 10,
      onProgress: (event) => events.push(event),
    });
    const blobResult = await api.imageToPDF(
      new Blob([Uint8Array.from(encoded)], { type: 'image/png' }),
    );
    await result.download('fictional-corners.pdf');
    return {
      bytes: Array.from(await result.toUint8Array()),
      blobBytes: Array.from(await blobResult.toUint8Array()),
      pageCount: result.pageCount,
      events,
    };
  }, source.png);
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('fictional-corners.pdf');
  expect(await readFile((await download.path())!)).toEqual(Buffer.from(evidence.bytes));
  const pages = await inspect(page, evidence.bytes);
  expect(pages).toHaveLength(1);
  expect(evidence.pageCount).toBe(1);
  expect(pages[0]!.imagePaints).toBe(1);
  expect(pages[0]!.width).toBe(100);
  expect(pages[0]!.height).toBe(80);
  const image = PNG.sync.read(Buffer.from(pages[0]!.png.split(',')[1]!, 'base64'));
  expectCorners(image, { x: 10, y: 20, width: 80, height: 40 }, [0, 1, 2, 3]);
  expectColor(image, 50, 12, [255, 255, 255]);
  expectColor(image, 5, 40, [255, 255, 255]);
  const defaultDocument = await PDFDocument.load(Uint8Array.from(evidence.blobBytes));
  expect(defaultDocument.getPageCount()).toBe(1);
  expect(defaultDocument.getPage(0).getSize().width).toBeCloseTo(595.28, 1);
  expect(defaultDocument.getPage(0).getSize().height).toBeCloseTo(841.89, 1);
  expect([...new Set(evidence.events.map((event) => event.stage))]).toEqual([
    'preparing',
    'resources',
    'pages',
    'saving',
    'complete',
  ]);
  for (const stage of ['preparing', 'resources', 'pages', 'saving'] as const) {
    const events = evidence.events.filter((event) => event.stage === stage);
    expect(events.map((event) => event.completed)).toEqual([0, 1]);
    expect(events.every((event) => event.total === 1)).toBe(true);
  }
  expect(evidence.events.at(-1)).toEqual({ stage: 'complete', completed: 1, total: 1 });
  await writeFile(testInfo.outputPath('png-corners.pdf'), Buffer.from(evidence.bytes));
});

test('all eight JPEG EXIF orientations preserve original compressed bytes and transformed corner colors', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const source = await loadFixture(page);
  const inputs = Array.from({ length: 8 }, (_, index) => ({
    orientation: index + 1,
    bytes: Array.from(jpegOrientation(Uint8Array.from(source.jpeg), index + 1)),
  }));
  const outputs = await page.evaluate(async (encoded) => {
    const modulePath = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const results: number[][] = [];
    for (const input of encoded) {
      const bytes = Uint8Array.from(input.bytes);
      const result = await api.imageToPDF(input.orientation % 2 === 0 ? bytes.buffer : bytes, {
        format: { width: 80, height: 60 },
        margin: 0,
      });
      results.push(Array.from(await result.toUint8Array()));
    }
    return results;
  }, inputs);
  // Explicit EXIF mappings independently cover rotations and both mirror axes.
  const cornerOrders = [
    [0, 1, 2, 3],
    [1, 0, 3, 2],
    [3, 2, 1, 0],
    [2, 3, 0, 1],
    [0, 2, 1, 3],
    [2, 0, 3, 1],
    [3, 1, 2, 0],
    [1, 3, 0, 2],
  ];
  for (const [index, bytes] of outputs.entries()) {
    const pages = await inspect(page, bytes);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.imagePaints).toBe(1);
    const image = PNG.sync.read(Buffer.from(pages[0]!.png.split(',')[1]!, 'base64'));
    const rotated = index >= 4;
    expectCorners(
      image,
      rotated ? { x: 25, y: 0, width: 30, height: 60 } : { x: 0, y: 10, width: 80, height: 40 },
      cornerOrders[index]!,
      10,
    );
    expectColor(image, rotated ? 5 : 40, rotated ? 30 : 3, [255, 255, 255]);
    const document = await PDFDocument.load(Uint8Array.from(bytes));
    const images = document.context
      .enumerateIndirectObjects()
      .flatMap(([, object]) =>
        object instanceof PDFRawStream &&
        object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')
          ? [object]
          : [],
      );
    expect(images).toHaveLength(1);
    expect(Buffer.from(images[0]!.getContents())).toEqual(Buffer.from(inputs[index]!.bytes));
    await writeFile(testInfo.outputPath(`jpeg-orientation-${index + 1}.pdf`), Buffer.from(bytes));
  }
});

test('both TIFF byte orders preserve main-frame order, orientation, dimensions and known Group 4 pixels', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await loadFixture(page);
  for (const littleEndian of [true, false]) {
    const encoded = tiffFrames(
      [
        {
          width: 4,
          height: 2,
          photometric: 2,
          bits: [8, 8, 8],
          pixels: [
            ...colors[0],
            ...colors[0],
            ...colors[1],
            ...colors[1],
            ...colors[2],
            ...colors[2],
            ...colors[3],
            ...colors[3],
          ],
        },
        {
          width: 2,
          height: 4,
          photometric: 2,
          bits: [8, 8, 8],
          orientation: 6,
          pixels: Array.from({ length: 8 }, () => [210, 30, 190]).flat(),
        },
        { width: 2, height: 1, photometric: 1, orientation: 2, pixels: [0, 255] },
        {
          width: 8,
          height: 4,
          photometric: 0,
          bits: [1],
          compression: 4,
          // Independently encoded by Pillow/libtiff, then reopened to verify the fictional pixels.
          pixels: [38, 185, 126, 35, 38, 168, 142, 136, 232, 37, 136, 139, 0, 16, 1],
        },
      ],
      littleEndian,
    );
    const evidence = await page.evaluate(async (input) => {
      const modulePath = '/src/index.ts';
      const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
      const events: RenderProgress[] = [];
      const result = await api.imageToPDF(Uint8Array.from(input), {
        format: { width: 80, height: 60 },
        margin: 0,
        onProgress: (event) => events.push(event),
      });
      return {
        bytes: Array.from(await result.toUint8Array()),
        pageCount: result.pageCount,
        events,
      };
    }, Array.from(encoded));
    const pages = await inspect(page, evidence.bytes);
    expect(evidence.pageCount).toBe(4);
    expect(pages).toHaveLength(4);
    expect(pages.every((pdfPage) => pdfPage.imagePaints === 1)).toBe(true);
    const images = pages.map((pdfPage) =>
      PNG.sync.read(Buffer.from(pdfPage.png.split(',')[1]!, 'base64')),
    );
    expectCorners(images[0]!, { x: 0, y: 10, width: 80, height: 40 }, [0, 1, 2, 3]);
    expectColor(images[1]!, 40, 30, [210, 30, 190]);
    expectColor(images[1]!, 40, 3, [255, 255, 255]);
    expectColor(images[2]!, 20, 30, [255, 255, 255]);
    expectColor(images[2]!, 60, 30, [0, 0, 0]);
    const group4 = [
      [0, 0, 255, 255, 0, 0, 255, 255],
      [255, 255, 255, 255, 255, 255, 255, 255],
      [0, 255, 0, 255, 0, 255, 0, 255],
      [0, 0, 0, 0, 0, 0, 0, 0],
    ];
    for (const [rowIndex, row] of group4.entries()) {
      for (const [column, value] of row.entries()) {
        expectColor(images[3]!, column * 10 + 5, 10 + rowIndex * 10 + 5, [value, value, value]);
      }
    }
    for (const stage of ['resources', 'pages'] as const) {
      const events = evidence.events.filter((event) => event.stage === stage);
      expect(events.every((event) => event.total === 4)).toBe(true);
      expect(events.map((event) => event.completed)).toEqual([0, 1, 2, 3, 4]);
    }
    await writeFile(
      testInfo.outputPath(`tiff-${littleEndian ? 'II' : 'MM'}.pdf`),
      Buffer.from(evidence.bytes),
    );
  }
});

test('image diagnostics, cancellation, callback identity and synchronous input ownership remain observable', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const source = await loadFixture(page);
  const invalidCrc = Uint8Array.from(source.png);
  invalidCrc[29] = invalidCrc[29]! ^ 1;
  const animated = pngChunk(
    Uint8Array.from(source.png),
    'acTL',
    Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 0]),
  );
  const evidence = await page.evaluate(
    async (input) => {
      const modulePath = '/src/index.ts';
      const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
      const errors: Record<string, { name: string; code: string }> = {};
      for (const [label, bytes] of Object.entries({
        truncated: input.png.slice(0, 8),
        crc: input.invalidCrc,
        animation: input.animated,
        gif: input.gif,
      })) {
        try {
          await api.imageToPDF(Uint8Array.from(bytes));
          errors[label] = { name: 'NO_ERROR', code: '' };
        } catch (error) {
          errors[label] = {
            name: error instanceof Error ? error.name : '',
            code: error instanceof api.RenderPDFError ? error.code : '',
          };
        }
      }
      const failures: Record<string, { name: string; original: boolean; complete: boolean }> = {};
      for (const mode of ['aborted', 'abortPage', 'callback'] as const) {
        const controller = new AbortController();
        const marker = new Error('Image progress listener failed.');
        const events: RenderProgress[] = [];
        if (mode === 'aborted') controller.abort();
        try {
          await api.imageToPDF(Uint8Array.from(input.png), {
            signal: controller.signal,
            onProgress: (event) => {
              events.push(event);
              if (event.stage !== 'pages' || event.completed !== 1) return;
              if (mode === 'abortPage') controller.abort();
              if (mode === 'callback') throw marker;
            },
          });
          failures[mode] = { name: 'NO_ERROR', original: false, complete: true };
        } catch (error) {
          failures[mode] = {
            name: error instanceof Error ? error.name : '',
            original: error === marker,
            complete: events.some((event) => event.stage === 'complete'),
          };
        }
      }
      // A subarray catches accidental use of its entire backing buffer rather than its owned bytes.
      const backing = new Uint8Array(input.png.length + 12);
      backing.set(input.png, 5);
      const bytes = backing.subarray(5, 5 + input.png.length);
      const metadata = { title: 'Original title — copied before awaiting' };
      const pending = api.imageToPDF(bytes, {
        metadata,
        format: { width: 100, height: 80 },
        margin: 10,
      });
      backing.fill(0);
      metadata.title = 'Changed after invocation';
      const result = await pending;
      return { errors, failures, bytes: Array.from(await result.toUint8Array()) };
    },
    {
      png: source.png,
      invalidCrc: Array.from(invalidCrc),
      animated: Array.from(animated),
      gif: Array.from(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')),
    },
  );
  expect(evidence.errors.truncated!.code).toBe('INVALID_SOURCE');
  expect(evidence.errors.crc!.code).toBe('INVALID_SOURCE');
  expect(evidence.errors.animation!.code).toBe('UNSUPPORTED_IMAGE');
  expect(evidence.errors.gif!.code).toBe('UNSUPPORTED_IMAGE');
  expect(evidence.failures.aborted!.name).toBe('AbortError');
  expect(evidence.failures.abortPage!.name).toBe('AbortError');
  expect(evidence.failures.callback!.original).toBe(true);
  expect(Object.values(evidence.failures).every((failure) => !failure.complete)).toBe(true);
  const document = await PDFDocument.load(Uint8Array.from(evidence.bytes));
  expect(document.getTitle()).toBe('Original title — copied before awaiting');
  const pages = await inspect(page, evidence.bytes);
  expect(pages).toHaveLength(1);
  const image = PNG.sync.read(Buffer.from(pages[0]!.png.split(',')[1]!, 'base64'));
  expectCorners(image, { x: 10, y: 20, width: 80, height: 40 }, [0, 1, 2, 3]);
});
