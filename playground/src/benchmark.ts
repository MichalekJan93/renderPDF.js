import { jsPDF } from 'jspdf';
import { renderPDF, type RegisteredFont } from 'renderpdf-js';
import { contentWidthPx, previewFamily } from './preview';

/** One completed browser export, measured through PDF byte serialization. */
export interface ExportMeasurement {
  /** Elapsed conversion time, excluding preview preparation and browser download handling. */
  durationMs: number;
  /** Serialized PDF bytes ready for a local download. */
  blob: Blob;
  /** Number of pages reported by the producing library. */
  pageCount: number;
  /** Diagnostics from RenderPDF.js, if available. */
  warnings: readonly { code: string; message: string }[];
}

/** Export the connected preview through the installed RenderPDF.js package. */
export async function measureRenderPdf(
  /** The same laid-out source shown in the preview. */
  source: HTMLElement,
  /** Explicit font programs registered for browser and PDF use. */
  fonts: readonly RegisteredFont[],
  /** Fail on unsupported decorative CSS when explicitly requested. */
  strictCss: boolean,
  /** Honor authored CSS page breaks or fill pages from measured content alone. */
  pageBreak: 'css' | 'auto',
): Promise<ExportMeasurement> {
  // Serialization is included; the download action is excluded for both libraries.
  const startedAtMs = performance.now();
  const result = await renderPDF(source, { fonts, format: 'A4', margin: 24, strictCss, pageBreak });
  const blob = await result.toBlob();
  return {
    durationMs: performance.now() - startedAtMs,
    blob,
    pageCount: result.pageCount,
    warnings: result.warnings,
  };
}

/** Export the same styled preview through jsPDF's official HTML conversion plugin. */
export async function measureJsPdf(
  /** The preview wrapper includes its own stylesheet when jsPDF clones the element. */
  container: HTMLElement,
): Promise<ExportMeasurement> {
  // A4 and all margins match RenderPDF.js: 24 CSS px = 18 PDF pt.
  const startedAtMs = performance.now();
  const document = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  await document.html(container, {
    // jsPDF applies margin to x/y itself; zero avoids counting the edge twice.
    x: 0,
    y: 0,
    margin: 18,
    width: contentWidthPx * 0.75,
    windowWidth: contentWidthPx,
    autoPaging: 'text',
    html2canvas: { logging: false },
    // The same licensed local face files are available to the HTML plugin.
    fontFaces: [
      {
        family: previewFamily,
        weight: 400,
        src: [{ url: `${import.meta.env.BASE_URL}fonts/NotoSans-Regular.ttf`, format: 'truetype' }],
      },
      {
        family: previewFamily,
        weight: 700,
        src: [{ url: `${import.meta.env.BASE_URL}fonts/NotoSans-Bold.ttf`, format: 'truetype' }],
      },
      {
        family: previewFamily,
        style: 'italic',
        weight: 400,
        src: [{ url: `${import.meta.env.BASE_URL}fonts/NotoSans-Italic.ttf`, format: 'truetype' }],
      },
    ],
  });
  const blob = document.output('blob');
  return {
    durationMs: performance.now() - startedAtMs,
    blob,
    pageCount: document.getNumberOfPages(),
    warnings: [],
  };
}
