import { GlobalWorkerOptions, OPS, getDocument } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/** PDF.js is a browser verification tool, never part of the export pipeline. */
GlobalWorkerOptions.workerSrc = workerUrl;

/** Independently extracted text geometry in PDF points. */
export interface InspectedText {
  /** Decoded Unicode text, with PDF.js whitespace normalization. */
  text: string;
  /** PDF text matrix, including the bottom-left baseline translation. */
  transform: number[];
  /** Embedded PDF font identifier selected for this run. */
  fontName: string;
}

/** Independent structural and visual evidence for one generated PDF page. */
export interface InspectedPage {
  /** Raster verification dimensions in CSS pixels at 96 DPI. */
  width: number;
  height: number;
  /** Rendered PDF page as a self-contained PNG. */
  png: string;
  /** Extracted selectable text objects. */
  text: InspectedText[];
  /** Number of actual image paint operations, excluding alpha-mask resources. */
  imagePaints: number;
  /** Pixel dimensions encoded with each image paint operation. */
  imageSizes: { width: number; height: number }[];
}

/** Render and inspect a PDF through an implementation independent of its writer.
 * @param bytes Complete generated PDF bytes serialized across the test boundary.
 */
export async function inspectPdf(bytes: number[]): Promise<InspectedPage[]> {
  // Strict parsing prevents a malformed PDF from passing through error recovery.
  const loadingTask = getDocument({ data: Uint8Array.from(bytes), stopAtErrors: true });
  // Keep the loading task as the public lifecycle owner of its worker resources.
  const document = await loadingTask.promise;
  // Collect each page while keeping only one temporary rendering canvas alive.
  const pages: InspectedPage[] = [];
  try {
    for (let index = 1; index <= document.numPages; index += 1) {
      // Public PDF.js APIs provide both extraction and graphics operations.
      const page = await document.getPage(index);
      // The PDF writer converts CSS pixels to points using 0.75.
      const viewport = page.getViewport({ scale: 1 / 0.75 });
      // A detached canvas avoids affecting the source browser document.
      const canvas = window.document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;
      // Text and operators are independent of the PDF's visible pixel image.
      const content = await page.getTextContent();
      // Inspect public graphics operations to distinguish images from native text.
      const operators = await page.getOperatorList();
      // Include inline images so an alternate writer cannot bypass locality checks.
      const imageIndexes = operators.fnArray.flatMap((operation, operationIndex) =>
        operation === OPS.paintImageXObject || operation === OPS.paintInlineImageXObject
          ? [operationIndex]
          : [],
      );
      pages.push({
        width: canvas.width,
        height: canvas.height,
        png: canvas.toDataURL('image/png'),
        text: content.items.flatMap((item) =>
          'str' in item
            ? [{ text: item.str, transform: [...item.transform], fontName: item.fontName }]
            : [],
        ),
        imagePaints: imageIndexes.length,
        imageSizes: imageIndexes.map((operationIndex) => {
          // Image XObject arguments contain object ID, width, and height.
          const argumentsList = operators.argsArray[operationIndex] as unknown[];
          return { width: Number(argumentsList[1]), height: Number(argumentsList[2]) };
        }),
      });
      // Release the native bitmap immediately after serializing its evidence.
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
    }
    return pages;
  } finally {
    await loadingTask.destroy();
  }
}
