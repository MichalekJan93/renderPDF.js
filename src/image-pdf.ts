import {
  PDFDocument,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from 'pdf-lib';
import type { PDFRef } from 'pdf-lib';
import type { ImagePDFOptions, ImageSource, RenderPDFResult } from './api-types.js';
import { RenderPDFError, throwIfAborted } from './diagnostics.js';
import { applyPDFMetadata, resolveMetadata } from './export-options.js';
import { assertImageSize, imagePlacement } from './image-geometry.js';
import { inspectBitmap, validatePngData } from './image-input.js';
import { resolvePageGeometry } from './page.js';
import { withCancellation } from './prepare.js';
import { createProgressReporter } from './progress.js';
import { createResult } from './result.js';
import { openTiff } from './tiff.js';

/** One embedded image reference; decoded TIFF buffers are not retained across frames. */
interface EmbeddedImage {
  /** PDF image XObject, shared with the page through its public resource dictionary. */
  ref: PDFRef;
  /** Encoded pixel dimensions before applying TIFF/EXIF orientation. */
  width: number;
  /** Encoded pixel height. */
  height: number;
  /** TIFF/EXIF orientation applied by the page matrix without recompressing JPEG bytes. */
  orientation: number;
}

/** Embed decoded TIFF pixels using public PDF streams, avoiding a PNG encode/decode round trip. */
function embedRGBA(
  /** PDF document that owns these compressed image and optional transparency streams. */
  pdf: PDFDocument,
  /** Complete decoded frame, before orientation. */
  frame: { width: number; height: number; rgba: Uint8Array; orientation: number },
): EmbeddedImage {
  const { width, height, rgba, orientation } = frame;
  assertImageSize(width, height);
  const pixelCount = width * height;
  if (rgba.length !== pixelCount * 4) {
    throw new RenderPDFError(
      'RESOURCE_LOAD_FAILED',
      'Decoded TIFF pixels do not match the frame dimensions.',
    );
  }
  const rgb = new Uint8Array(pixelCount * 3);
  let alpha: Uint8Array | undefined;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    rgb[pixel * 3] = rgba[pixel * 4]!;
    rgb[pixel * 3 + 1] = rgba[pixel * 4 + 1]!;
    rgb[pixel * 3 + 2] = rgba[pixel * 4 + 2]!;
    const opacity = rgba[pixel * 4 + 3]!;
    if (opacity !== 255 && !alpha) alpha = new Uint8Array(pixelCount).fill(255);
    if (alpha) alpha[pixel] = opacity;
  }
  const mask = alpha
    ? pdf.context.register(
        pdf.context.flateStream(alpha, {
          Type: 'XObject',
          Subtype: 'Image',
          Width: width,
          Height: height,
          ColorSpace: 'DeviceGray',
          BitsPerComponent: 8,
        }),
      )
    : undefined;
  const ref = pdf.context.register(
    pdf.context.flateStream(rgb, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: width,
      Height: height,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
      ...(mask ? { SMask: mask } : {}),
    }),
  );
  return { ref, width, height, orientation };
}

/** Read an immutable Blob while retaining cancellation and input-specific diagnostics. */
async function readBlob(
  /** File and Blob payloads cannot be mutated by application code after construction. */
  source: Blob,
  /** Optional application cancellation. */
  signal?: AbortSignal,
): Promise<Uint8Array> {
  try {
    return new Uint8Array(await withCancellation(source.arrayBuffer(), signal));
  } catch (cause) {
    throwIfAborted(signal);
    throw new RenderPDFError('RESOURCE_LOAD_FAILED', 'The source image file could not be read.', {
      cause,
    });
  }
}

/** Convert one standalone PNG/JPEG or every main TIFF frame to an immutable PDF result. */
export async function imageToPDF(
  /** Complete image bytes or browser File/Blob; filenames and MIME types do not determine decoding. */
  source: ImageSource,
  /** Shared paper settings, metadata, cancellation and optional stage-local progress. */
  options: ImagePDFOptions = {},
): Promise<RenderPDFResult> {
  const geometry = resolvePageGeometry(options);
  const metadata = resolveMetadata(options.metadata);
  const { signal, onProgress } = options;
  if (onProgress !== undefined && typeof onProgress !== 'function') {
    throw new RenderPDFError('INVALID_OPTIONS', 'onProgress must be a function.');
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new RenderPDFError('INVALID_OPTIONS', 'signal must be an AbortSignal.');
  }
  throwIfAborted(signal);
  // Own mutable byte inputs synchronously, before progress callbacks or file reading can yield.
  const inputBytes =
    source instanceof Uint8Array
      ? Uint8Array.from(source)
      : source instanceof ArrayBuffer
        ? new Uint8Array(source.slice(0))
        : undefined;
  const blob = typeof Blob !== 'undefined' && source instanceof Blob ? source : undefined;
  if (!inputBytes && !blob) {
    throw new RenderPDFError(
      'INVALID_SOURCE',
      'Provide image bytes, an ArrayBuffer, or a File/Blob.',
    );
  }
  const progress = createProgressReporter(onProgress, signal);
  const report = progress.report;
  try {
    if (report) await report({ stage: 'preparing', completed: 0, total: 1 });
    const bytes = inputBytes ?? (await readBlob(blob!, signal));
    if (bytes.length === 0)
      throw new RenderPDFError('INVALID_SOURCE', 'The source image is empty.');
    // Classic TIFF and BigTIFF signatures reach the dedicated reader, which diagnoses unsupported variants.
    const isTiff =
      bytes.length >= 4 &&
      ((bytes[0] === 0x49 &&
        bytes[1] === 0x49 &&
        (bytes[2] === 42 || bytes[2] === 43) &&
        bytes[3] === 0) ||
        (bytes[0] === 0x4d &&
          bytes[1] === 0x4d &&
          bytes[2] === 0 &&
          (bytes[3] === 42 || bytes[3] === 43)));
    const tiff = isTiff ? await withCancellation(openTiff(bytes, signal), signal) : undefined;
    const bitmap = tiff ? undefined : inspectBitmap(bytes);
    const pageCount = tiff?.pageCount ?? 1;
    if (report) await report({ stage: 'preparing', completed: 1, total: 1 });
    const pdf = await PDFDocument.create();
    applyPDFMetadata(pdf, metadata);
    const images: EmbeddedImage[] = [];
    if (report) await report({ stage: 'resources', completed: 0, total: pageCount });
    for (let index = 0; index < pageCount; index += 1) {
      throwIfAborted(signal);
      if (tiff) {
        const frame = await withCancellation(tiff.decodeFrame(index), signal);
        images.push(embedRGBA(pdf, frame));
      } else {
        try {
          if (bitmap!.format === 'png') await validatePngData(bytes, signal);
          const embedded =
            bitmap!.format === 'png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
          if (embedded.width !== bitmap!.width || embedded.height !== bitmap!.height) {
            throw new RenderPDFError(
              'INVALID_SOURCE',
              'Decoded image dimensions disagree with its header.',
            );
          }
          images.push({
            ref: embedded.ref,
            width: embedded.width,
            height: embedded.height,
            orientation: bitmap!.orientation,
          });
        } catch (cause) {
          if (cause instanceof RenderPDFError) throw cause;
          throw new RenderPDFError(
            'RESOURCE_LOAD_FAILED',
            'The PNG/JPEG image could not be embedded.',
            { cause },
          );
        }
      }
      if (report) await report({ stage: 'resources', completed: index + 1, total: pageCount });
    }
    if (report) await report({ stage: 'pages', completed: 0, total: pageCount });
    for (const [index, image] of images.entries()) {
      throwIfAborted(signal);
      const page = pdf.addPage([geometry.width * 0.75, geometry.height * 0.75]);
      const matrix = imagePlacement(image.width, image.height, image.orientation, geometry);
      const name = page.node.newXObject('Image', image.ref);
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(
          matrix[0] * 0.75,
          matrix[1] * 0.75,
          matrix[2] * 0.75,
          matrix[3] * 0.75,
          matrix[4] * 0.75,
          matrix[5] * 0.75,
        ),
        drawObject(name),
        popGraphicsState(),
      );
      if (report) await report({ stage: 'pages', completed: index + 1, total: pageCount });
    }
    if (report) await report({ stage: 'saving', completed: 0, total: 1 });
    const output = await withCancellation(pdf.save(), signal);
    throwIfAborted(signal);
    if (report) await report({ stage: 'saving', completed: 1, total: 1 });
    if (report) await report({ stage: 'complete', completed: 1, total: 1 });
    throwIfAborted(signal);
    return createResult(output, pageCount, []);
  } catch (error) {
    return progress.rethrow(
      error instanceof RenderPDFError
        ? error
        : new RenderPDFError(
            'PDF_WRITE_FAILED',
            'The standalone image could not be written as PDF.',
            { cause: error },
          ),
    );
  }
}
