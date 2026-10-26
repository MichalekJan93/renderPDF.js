import { describe, expect, it } from 'vite-plus/test';
import { assertImageSize, imagePlacement, MAX_IMAGE_PIXELS } from '../src/image-geometry';
import { resolvePageGeometry } from '../src/page';
import { imageToPDF } from '../src/image-pdf';
import type { ImagePDFOptions, ImageSource } from '../src/api-types';

describe('standalone image page geometry', () => {
  it('centers a complete image without cropping or changing its aspect ratio', () => {
    const page = resolvePageGeometry({ format: { width: 100, height: 80 }, margin: 10 });
    expect(imagePlacement(80, 40, 1, page)).toEqual([80, 0, 0, 40, 10, 20]);
    expect(imagePlacement(80, 40, 6, page)).toEqual([0, -60, 30, 0, 35, 70]);
    expect(resolvePageGeometry({ format: 'Letter', orientation: 'landscape' }).width).toBe(1056);
  });

  it('maps both upper corners correctly for all eight rotation and reflection orientations', () => {
    const page = resolvePageGeometry({ format: { width: 100, height: 80 }, margin: 10 });
    // Each pair contains the expected physical position of the stored top-left and top-right pixel corners.
    const corners = [
      [
        [20, 70],
        [80, 70],
      ],
      [
        [80, 70],
        [20, 70],
      ],
      [
        [80, 10],
        [20, 10],
      ],
      [
        [20, 10],
        [80, 10],
      ],
      [
        [20, 70],
        [20, 10],
      ],
      [
        [80, 70],
        [80, 10],
      ],
      [
        [80, 10],
        [80, 70],
      ],
      [
        [20, 10],
        [20, 70],
      ],
    ];
    for (let orientation = 1; orientation <= 8; orientation += 1) {
      const [a, b, c, d, e, f] = imagePlacement(40, 40, orientation, page);
      expect([
        [c + e, d + f],
        [a + c + e, b + d + f],
      ]).toEqual(corners[orientation - 1]);
    }
  });

  it('bounds pixel allocations and rejects invalid dimensions or orientations', () => {
    expect(() => assertImageSize(MAX_IMAGE_PIXELS, 1)).not.toThrow();
    for (const [width, height] of [
      [0, 1],
      [1, -1],
      [Number.NaN, 2],
      [2.5, 2],
    ]) {
      expect(() => assertImageSize(width!, height!)).toThrow(
        expect.objectContaining({ code: 'INVALID_SOURCE' }),
      );
    }
    expect(() => assertImageSize(MAX_IMAGE_PIXELS + 1, 1)).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_IMAGE' }),
    );
    const page = resolvePageGeometry({});
    for (const orientation of [0, 9, 1.5, Number.NaN]) {
      expect(() => imagePlacement(10, 10, orientation, page)).toThrow(
        expect.objectContaining({ code: 'INVALID_SOURCE' }),
      );
    }
  });

  it('validates direct API options and sources without needing a browser document or fonts', async () => {
    await expect(imageToPDF('photo.jpg' as unknown as ImageSource)).rejects.toMatchObject({
      code: 'INVALID_SOURCE',
    });
    await expect(imageToPDF(new Uint8Array())).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    for (const options of [
      { metadata: null },
      { onProgress: 'notify' },
      { signal: 'cancel' },
      { margin: -1 },
    ]) {
      await expect(
        imageToPDF(new Uint8Array([1]), options as unknown as ImagePDFOptions),
      ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    }
  });
});
