import './style.css';
import { registerFont, type RegisteredFont } from 'renderpdf-js';
import { measureJsPdf, measureRenderPdf, type ExportMeasurement } from './benchmark';
import { createPreview, previewFamily } from './preview';
import exampleHtml from './example.html?raw';

/** Trigger a local PDF download without including browser download handling in conversion time. */
function downloadPdf(
  /** Complete serialized PDF. */
  blob: Blob,
  /** Fixed output name identifying the renderer. */
  filename: string,
): void {
  // The temporary URL outlives the synchronous click and is released afterward.
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

/** Connect the independent package consumer's editor, file input, preview and comparison. */
async function initialize(): Promise<void> {
  // UI controls remain outside the source; changes there cannot enter the generated PDF.
  const input = document.querySelector<HTMLTextAreaElement>('#html-input')!;
  const fileInput = document.querySelector<HTMLInputElement>('#html-file')!;
  const strictCss = document.querySelector<HTMLInputElement>('#strict-css')!;
  const respectPageBreaks = document.querySelector<HTMLInputElement>('#respect-page-breaks')!;
  const refresh = document.querySelector<HTMLButtonElement>('#refresh-preview')!;
  const exportButton = document.querySelector<HTMLButtonElement>('#export-pdfs')!;
  const reset = document.querySelector<HTMLButtonElement>('#reset-example')!;
  const status = document.querySelector<HTMLElement>('#status')!;
  const warnings = document.querySelector<HTMLUListElement>('#warnings')!;
  const results = document.querySelector<HTMLElement>('#results')!;
  const renderRow = document.querySelector<HTMLTableRowElement>('#render-result')!;
  const jsPdfRow = document.querySelector<HTMLTableRowElement>('#jspdf-result')!;
  const winner = document.querySelector<HTMLElement>('#winner')!;
  const shadow = document
    .querySelector<HTMLElement>('#preview-host')!
    .attachShadow({ mode: 'open' });
  // Source ownership and the pending update must remain stable throughout asynchronous export.
  let source: HTMLElement | null = null;
  let previewContainer: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  input.value = exampleHtml.trim();
  input.disabled =
    fileInput.disabled =
    refresh.disabled =
    reset.disabled =
    exportButton.disabled =
      true;
  status.textContent = 'Loading fonts for the preview and PDFs…';
  // Static licensed faces avoid browser-synthesized regular/bold/italic variants.
  const faces = [
    { file: 'Regular', weight: 400, style: 'normal' as const },
    { file: 'Bold', weight: 700, style: 'normal' as const },
    { file: 'Italic', weight: 400, style: 'italic' as const },
  ];
  const fonts: RegisteredFont[] = await Promise.all(
    faces.map(async (face) => {
      // Font assets belong to the consumer application; they are absent from the library package.
      const response = await fetch(`${import.meta.env.BASE_URL}fonts/NotoSans-${face.file}.ttf`);
      if (!response.ok) throw new Error(`Could not load the ${face.file} font.`);
      return registerFont({
        family: previewFamily,
        data: await response.arrayBuffer(),
        weight: face.weight,
        style: face.style,
      });
    }),
  );

  /** Remove stale measurements whenever the document changes. */
  function clearResults(): void {
    results.hidden = true;
    winner.textContent = '';
    for (const row of [renderRow, jsPdfRow]) {
      for (const cell of Array.from(row.cells).slice(1)) cell.textContent = '—';
    }
  }

  /** Write one measured outcome to its named result row. */
  function showMeasurement(
    /** The renderer's row in the comparison table. */
    row: HTMLTableRowElement,
    /** Successful export, or its visible error message. */
    outcome: ExportMeasurement | string,
  ): void {
    results.hidden = false;
    if (typeof outcome === 'string') {
      row.cells[1]!.textContent = 'Error';
      row.cells[2]!.textContent = '—';
      row.cells[3]!.textContent = '—';
      row.cells[4]!.textContent = outcome;
      return;
    }
    row.cells[1]!.textContent = `${(outcome.durationMs / 1_000).toFixed(2)} s`;
    row.cells[2]!.textContent = `${outcome.blob.size.toLocaleString('en-US')} B`;
    row.cells[3]!.textContent = String(outcome.pageCount);
    row.cells[4]!.textContent = 'Done';
  }

  /** Flush the editor immediately, so a click never exports a previous debounce snapshot. */
  function updatePreview(): void {
    clearTimeout(timer);
    clearResults();
    warnings.replaceChildren();
    warnings.hidden = true;
    source = null;
    previewContainer = null;
    exportButton.disabled = true;
    try {
      // Validation and layout creation finish before replacing the last source reference.
      const next = createPreview(input.value);
      shadow.replaceChildren(next.container);
      source = next.exportIssues.length === 0 ? next.source : null;
      previewContainer = source ? next.container : null;
      exportButton.disabled = source === null;
      for (const issue of next.exportIssues) {
        // A visible preview must not imply that a PDF missing authored assets can be exported.
        const item = document.createElement('li');
        item.textContent = issue;
        warnings.append(item);
      }
      warnings.hidden = next.exportIssues.length === 0;
      status.textContent = source
        ? 'The preview is up to date. Both PDFs will use this document.'
        : 'The HTML is displayed. Replace the marked images before exporting.';
    } catch (error) {
      shadow.replaceChildren();
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    clearResults();
    source = null;
    previewContainer = null;
    // Keep export clickable while debouncing: its handler validates and flushes current input.
    exportButton.disabled = false;
    status.textContent = 'Updating the preview…';
    timer = setTimeout(updatePreview, 250);
  });
  strictCss.addEventListener('change', clearResults);
  respectPageBreaks.addEventListener('change', clearResults);
  fileInput.addEventListener('change', async () => {
    // File bytes are decoded as UTF-8; the original file is never uploaded or modified.
    const file = fileInput.files?.[0];
    if (!file) return;
    input.disabled =
      fileInput.disabled =
      strictCss.disabled =
      respectPageBreaks.disabled =
      refresh.disabled =
      reset.disabled =
      exportButton.disabled =
        true;
    try {
      if (!/\.html?$/i.test(file.name)) throw new Error('Choose an .html or .htm file.');
      if (file.size > 10 * 1024 * 1024)
        throw new Error('The HTML file must be no larger than 10 MiB.');
      input.value = await file.text();
      updatePreview();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      input.disabled =
        fileInput.disabled =
        strictCss.disabled =
        respectPageBreaks.disabled =
        refresh.disabled =
        reset.disabled =
          false;
      exportButton.disabled = source === null;
    }
  });
  refresh.addEventListener('click', updatePreview);
  reset.addEventListener('click', () => {
    fileInput.value = '';
    input.value = exampleHtml.trim();
    updatePreview();
  });
  exportButton.addEventListener('click', async () => {
    updatePreview();
    if (!source || !previewContainer) return;
    // Lock all editing before conversion; no preview replacement may race with measurement/capture.
    input.disabled =
      fileInput.disabled =
      strictCss.disabled =
      respectPageBreaks.disabled =
      refresh.disabled =
      reset.disabled =
      exportButton.disabled =
        true;
    status.textContent = 'Measuring RenderPDF.js…';
    // Independent errors keep a successful output available even if the other renderer fails.
    let renderMeasurement: ExportMeasurement | null = null;
    let jsPdfMeasurement: ExportMeasurement | null = null;
    try {
      renderMeasurement = await measureRenderPdf(
        source,
        fonts,
        strictCss.checked,
        respectPageBreaks.checked ? 'css' : 'auto',
      );
      showMeasurement(renderRow, renderMeasurement);
      for (const warning of renderMeasurement.warnings) {
        const item = document.createElement('li');
        item.textContent = `${warning.code}: ${warning.message}`;
        warnings.append(item);
      }
    } catch (error) {
      showMeasurement(renderRow, error instanceof Error ? error.message : String(error));
    }
    status.textContent = 'Measuring jsPDF…';
    try {
      jsPdfMeasurement = await measureJsPdf(previewContainer);
      showMeasurement(jsPdfRow, jsPdfMeasurement);
    } catch (error) {
      showMeasurement(jsPdfRow, error instanceof Error ? error.message : String(error));
    }
    warnings.hidden = warnings.childElementCount === 0;
    try {
      if (renderMeasurement) downloadPdf(renderMeasurement.blob, 'renderpdf.pdf');
      if (jsPdfMeasurement) downloadPdf(jsPdfMeasurement.blob, 'jspdf.pdf');
      if (renderMeasurement && jsPdfMeasurement) {
        // A size result remains visible even when the renderers paginate differently.
        const faster =
          renderMeasurement.durationMs === jsPdfMeasurement.durationMs
            ? 'tie'
            : renderMeasurement.durationMs < jsPdfMeasurement.durationMs
              ? 'RenderPDF.js'
              : 'jsPDF';
        const smaller =
          renderMeasurement.blob.size === jsPdfMeasurement.blob.size
            ? 'tie'
            : renderMeasurement.blob.size < jsPdfMeasurement.blob.size
              ? 'RenderPDF.js'
              : 'jsPDF';
        const pageNote =
          renderMeasurement.pageCount === jsPdfMeasurement.pageCount
            ? ''
            : ' Page counts differ; compare the content of both PDFs too.';
        winner.textContent = `Faster: ${faster}. Smaller file: ${smaller}.${pageNote}`;
        status.textContent = 'Comparison complete. Both PDFs have been downloaded.';
      } else {
        winner.textContent = 'The comparison is incomplete; see the table for details.';
        status.textContent = 'Finished with one or both exports failing.';
      }
    } finally {
      input.disabled =
        fileInput.disabled =
        strictCss.disabled =
        respectPageBreaks.disabled =
        refresh.disabled =
        reset.disabled =
          false;
      exportButton.disabled = source === null;
    }
  });
  input.disabled = fileInput.disabled = refresh.disabled = reset.disabled = false;
  updatePreview();
}

initialize().catch((error: unknown) => {
  // Failed font setup must stay visible and keep export disabled.
  document.querySelector<HTMLElement>('#status')!.textContent =
    error instanceof Error ? error.message : String(error);
});
