import type { PageGeometry } from './api-types.js';
import { RenderPDFError } from './diagnostics.js';

/** Bound per-frame decoding allocations while allowing typical 600-DPI A4 scans. */
export const MAX_IMAGE_PIXELS = 40_000_000;

/** Reject invalid and excessive dimensions before a decoder allocates pixel buffers. */
export function assertImageSize(
  /** Encoded pixel width, before orientation. */
  width: number,
  /** Encoded pixel height, before orientation. */
  height: number,
): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new RenderPDFError('INVALID_SOURCE', 'Image dimensions must be positive safe integers.');
  }
  if (width > MAX_IMAGE_PIXELS / height) {
    throw new RenderPDFError(
      'UNSUPPORTED_IMAGE',
      `Each image frame must contain at most ${MAX_IMAGE_PIXELS} pixels.`,
    );
  }
}

/** Fit and orient an image's unit square inside the page, returning a CSS-pixel PDF matrix. */
export function imagePlacement(
  /** Original encoded image width. */
  width: number,
  /** Original encoded image height. */
  height: number,
  /** TIFF/EXIF orientation, including mirrored variants. */
  orientation: number,
  /** Physical page with validated margins. */
  page: PageGeometry,
): [number, number, number, number, number, number] {
  assertImageSize(width, height);
  if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) {
    throw new RenderPDFError(
      'INVALID_SOURCE',
      'Image orientation must be an integer from 1 through 8.',
    );
  }
  const displayWidth = orientation >= 5 ? height : width;
  const displayHeight = orientation >= 5 ? width : height;
  const availableWidth = page.width - page.margin.left - page.margin.right;
  const availableHeight = page.height - page.margin.top - page.margin.bottom;
  const scale = Math.min(availableWidth / displayWidth, availableHeight / displayHeight);
  const fittedWidth = displayWidth * scale;
  const fittedHeight = displayHeight * scale;
  const left = page.margin.left + (availableWidth - fittedWidth) / 2;
  const bottom = page.margin.bottom + (availableHeight - fittedHeight) / 2;
  // PDF coordinates point upward; these unit-square matrices implement the eight TIFF orientations.
  const transforms = [
    [1, 0, 0, 1, 0, 0],
    [-1, 0, 0, 1, 1, 0],
    [-1, 0, 0, -1, 1, 1],
    [1, 0, 0, -1, 0, 1],
    [0, -1, -1, 0, 1, 1],
    [0, -1, 1, 0, 0, 1],
    [0, 1, 1, 0, 0, 0],
    [0, 1, -1, 0, 1, 0],
  ];
  const [a, b, c, d, e, f] = transforms[orientation - 1]! as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return [
    a * fittedWidth,
    b * fittedHeight,
    c * fittedWidth,
    d * fittedHeight,
    left + e * fittedWidth,
    bottom + f * fittedHeight,
  ];
}
