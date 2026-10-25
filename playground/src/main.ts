import './style.css';
import { registerFont, renderPDF, RenderPDFError, type RegisteredFont } from 'renderpdf-js';
import { createPreview, previewFamily } from './preview';
import exampleHtml from './example.html?raw';

/** Connect the independent package consumer's editor, browser preview and actual PDF download. */
async function initialize(): Promise<void> {
  // UI controls remain outside the source; changes there cannot enter the generated PDF.
  const input = document.querySelector<HTMLTextAreaElement>('#html-input')!;
  const refresh = document.querySelector<HTMLButtonElement>('#refresh-preview')!;
  const download = document.querySelector<HTMLButtonElement>('#download-pdf')!;
  const reset = document.querySelector<HTMLButtonElement>('#reset-example')!;
  const status = document.querySelector<HTMLElement>('#status')!;
  const warnings = document.querySelector<HTMLUListElement>('#warnings')!;
  const shadow = document
    .querySelector<HTMLElement>('#preview-host')!
    .attachShadow({ mode: 'open' });
  // Source ownership and the pending update must remain stable throughout asynchronous export.
  let source: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  input.value = exampleHtml.trim();
  input.disabled = refresh.disabled = reset.disabled = download.disabled = true;
  status.textContent = 'Načítání fontů pro náhled i PDF…';
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
      if (!response.ok) throw new Error(`Font ${face.file} se nepodařilo načíst.`);
      return registerFont({
        family: previewFamily,
        data: await response.arrayBuffer(),
        weight: face.weight,
        style: face.style,
      });
    }),
  );

  /** Flush the editor immediately, so a click never exports a previous debounce snapshot. */
  function updatePreview(): void {
    clearTimeout(timer);
    warnings.replaceChildren();
    warnings.hidden = true;
    source = null;
    download.disabled = true;
    try {
      // Validation and layout creation finish before replacing the last source reference.
      const next = createPreview(input.value);
      shadow.replaceChildren(next.container);
      source = next.exportIssues.length === 0 ? next.source : null;
      download.disabled = source === null;
      for (const issue of next.exportIssues) {
        // A visible preview must not imply that a PDF missing authored assets can be exported.
        const item = document.createElement('li');
        item.textContent = issue;
        warnings.append(item);
      }
      warnings.hidden = next.exportIssues.length === 0;
      status.textContent = source
        ? 'Náhled je aktuální. PDF se vytvoří z tohoto dokumentu.'
        : 'HTML je zobrazené. Před stažením PDF doplňte označené obrázky.';
    } catch (error) {
      shadow.replaceChildren();
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    source = null;
    // Keep download clickable while debouncing: its handler validates and flushes the current input.
    download.disabled = false;
    status.textContent = 'Aktualizuji náhled…';
    timer = setTimeout(updatePreview, 250);
  });
  refresh.addEventListener('click', updatePreview);
  reset.addEventListener('click', () => {
    input.value = exampleHtml.trim();
    updatePreview();
  });
  download.addEventListener('click', async () => {
    // Include preview validation and PDF generation in the duration visible to the person testing.
    const exportStartedAtMs = performance.now();
    updatePreview();
    if (!source) return;
    // Lock all editing before conversion; no preview replacement may race with measurement/capture.
    input.disabled = refresh.disabled = reset.disabled = download.disabled = true;
    status.textContent = 'Vytváření PDF…';
    try {
      // Only public installed package exports participate in runtime conversion.
      const result = await renderPDF(source, { fonts, format: 'A4', margin: 24 });
      await result.download('dokument.pdf');
      for (const warning of result.warnings) {
        // Diagnostics stay visible without interpreting the library's approximate text as exact shaping.
        const item = document.createElement('li');
        item.textContent = `${warning.code}: ${warning.message}`;
        warnings.append(item);
      }
      warnings.hidden = result.warnings.length === 0;
      // Measure the actual current browser instead of inferring its speed from an external benchmark.
      const exportDurationSeconds = ((performance.now() - exportStartedAtMs) / 1000).toFixed(2);
      status.textContent = `PDF je stažené. Počet stran: ${result.pageCount}. Čas exportu: ${exportDurationSeconds} s.`;
    } catch (error) {
      status.textContent =
        error instanceof RenderPDFError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
    } finally {
      input.disabled = refresh.disabled = reset.disabled = false;
      download.disabled = source === null;
    }
  });
  input.disabled = refresh.disabled = reset.disabled = false;
  updatePreview();
}

initialize().catch((error: unknown) => {
  // Failed font setup must stay visible and keep export disabled.
  document.querySelector<HTMLElement>('#status')!.textContent =
    error instanceof Error ? error.message : String(error);
});
