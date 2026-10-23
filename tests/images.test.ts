import { describe, expect, it } from 'vite-plus/test';
import { nativeImageFormat } from '../src/images';

/** Construct a small synthetic JPEG metadata envelope without private image assets. */
function jpegWithOrientation(
  /** TIFF orientation value under test, including malformed values. */
  orientation: number,
  /** Exercise both valid TIFF byte orders. */
  littleEndian: boolean,
): Uint8Array {
  // The complete IFD0 contains one inline SHORT orientation and no thumbnail directory.
  const tiff = new Uint8Array(26);
  // Writing through a view keeps endian-dependent offsets explicit in the fixture.
  const view = new DataView(tiff.buffer);
  view.setUint16(0, littleEndian ? 0x4949 : 0x4d4d);
  view.setUint16(2, 42, littleEndian);
  view.setUint32(4, 8, littleEndian);
  view.setUint16(8, 1, littleEndian);
  view.setUint16(10, 0x0112, littleEndian);
  view.setUint16(12, 3, littleEndian);
  view.setUint32(14, 1, littleEndian);
  view.setUint16(18, orientation, littleEndian);
  // APP1 is bounded by its big-endian length regardless of TIFF byte order.
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe1,
    0,
    34,
    0x45,
    0x78,
    0x69,
    0x66,
    0,
    0,
    ...tiff,
    0xff,
    0xd9,
  ]);
}

describe('native image format and JPEG orientation guard', () => {
  it('recognizes PNG and metadata-free JPEG signatures without changing bytes', () => {
    // Only identification is tested here; the PDF adapter performs actual image decoding.
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // A minimal metadata envelope is enough to verify the absence of EXIF orientation.
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    // Guards never normalize, strip or otherwise alter caller-owned compressed bytes.
    const original = jpeg.slice();
    expect(nativeImageFormat(png)).toBe('png');
    expect(nativeImageFormat(jpeg)).toBe('jpeg');
    expect(jpeg).toEqual(original);
  });

  it.each([true, false])('accepts unrotated EXIF with littleEndian=%s', (littleEndian) => {
    expect(nativeImageFormat(jpegWithOrientation(1, littleEndian))).toBe('jpeg');
  });

  it.each([2, 3, 4, 5, 6, 7, 8, 0, 9])(
    'rejects browser-transformed or invalid EXIF orientation %s',
    (orientation) => {
      for (const littleEndian of [true, false]) {
        expect(() =>
          nativeImageFormat(jpegWithOrientation(orientation, littleEndian)),
        ).toThrowError(
          expect.objectContaining({
            code: 'RESOURCE_LOAD_FAILED',
            message: expect.stringContaining('normalize'),
          }),
        );
      }
    },
  );

  it('rejects truncated segments, escaping IFD offsets and invalid orientation types', () => {
    // APP1 lengths cannot be allowed to read entropy data or unrelated following segments.
    const truncated = jpegWithOrientation(1, true).slice(0, -3);
    // TIFF offsets are relative to its header, which begins at JPEG byte 12 in this fixture.
    const outsideDirectory = jpegWithOrientation(1, true);
    new DataView(outsideDirectory.buffer).setUint32(16, 0xffff_ffff, true);
    // Orientation must be exactly one inline SHORT rather than a pointer or arbitrary integer.
    const invalidType = jpegWithOrientation(1, false);
    new DataView(invalidType.buffer).setUint16(24, 4, false);
    // A directory claiming more fixed-width entries than APP1 can hold must fail before reads.
    const excessiveCount = jpegWithOrientation(1, true);
    new DataView(excessiveCount.buffer).setUint16(20, 0xffff, true);
    for (const bytes of [truncated, outsideDirectory, invalidType, excessiveCount]) {
      expect(() => nativeImageFormat(bytes)).toThrowError(
        expect.objectContaining({ code: 'RESOURCE_LOAD_FAILED' }),
      );
    }
  });

  it('ignores non-Exif APP1 metadata while rejecting unsupported resource bytes', () => {
    // XMP uses APP1 too; it does not supply the main image's TIFF orientation.
    const xmp = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, 5, 0x58, 0x4d, 0x50, 0xff, 0xd9]);
    expect(nativeImageFormat(xmp)).toBe('jpeg');
    expect(() => nativeImageFormat(Uint8Array.from([0x47, 0x49, 0x46]))).toThrowError(
      expect.objectContaining({ code: 'RESOURCE_LOAD_FAILED' }),
    );
  });
});
