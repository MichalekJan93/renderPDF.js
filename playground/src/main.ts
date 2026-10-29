import './style.css';
import {
  registerFont,
  RenderPDFError,
  type RegisteredFont,
  type RenderPDFOptions,
} from 'renderpdf-js';
import {
  measureJsPdf,
  measureRenderPdf,
  type ExportMeasurement,
  type RenderTimingBreakdown,
} from './benchmark';
import { createPreview, previewFamily } from './preview';
import { inspectFontRequirements, type MissingFontFace } from './font-requirements';
import { DEFAULT_OPTIONS_TEXT, parseOptions } from './options';
import exampleOneHtml from './examples/example-1.html?raw';
import exampleTwoHtml from './examples/example-2.html?raw';
import logoUrl from '../../assets/renderpdf-logo.png?url';

// Bundled static documents stay in the application and never enter the library package.
const examples = new Map<string, string>([
  ['example-1', exampleOneHtml.trim()],
  ['example-2', exampleTwoHtml.trim()],
]);

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
  const optionsInput = document.querySelector<HTMLTextAreaElement>('#options-input')!;
  const optionsError = document.querySelector<HTMLElement>('#options-error')!;
  document.querySelector<HTMLImageElement>('#brand-logo')!.src = logoUrl;
  const exampleSelect = document.querySelector<HTMLSelectElement>('#example-select')!;
  const fileInput = document.querySelector<HTMLInputElement>('#html-file')!;
  const fontFamilyInput = document.querySelector<HTMLInputElement>('#font-family')!;
  const fontWeightInput = document.querySelector<HTMLInputElement>('#font-weight')!;
  const fontStyleInput = document.querySelector<HTMLSelectElement>('#font-style')!;
  const fontFileInput = document.querySelector<HTMLInputElement>('#font-file')!;
  const registerFontButton = document.querySelector<HTMLButtonElement>('#register-font')!;
  const fontStatus = document.querySelector<HTMLElement>('#font-status')!;
  const missingFontList = document.querySelector<HTMLUListElement>('#font-requirements')!;
  const registeredFontList = document.querySelector<HTMLUListElement>('#registered-fonts')!;
  const profileStages = document.querySelector<HTMLInputElement>('#profile-stages')!;
  const refresh = document.querySelector<HTMLButtonElement>('#refresh-preview')!;
  const exportButton = document.querySelector<HTMLButtonElement>('#export-pdfs')!;
  const reset = document.querySelector<HTMLButtonElement>('#reset-example')!;
  const status = document.querySelector<HTMLElement>('#status')!;
  const warnings = document.querySelector<HTMLUListElement>('#warnings')!;
  const errors = document.querySelector<HTMLUListElement>('#errors')!;
  const diagnosticsEmpty = document.querySelector<HTMLElement>('#diagnostics-empty')!;
  const results = document.querySelector<HTMLElement>('#results')!;
  const renderRow = document.querySelector<HTMLTableRowElement>('#render-result')!;
  const renderLabel = document.querySelector<HTMLTableCellElement>('#render-label')!;
  const jsPdfRow = document.querySelector<HTMLTableRowElement>('#jspdf-result')!;
  const renderProfile = document.querySelector<HTMLDetailsElement>('#render-profile')!;
  const renderPhases = document.querySelector<HTMLElement>('#render-phases')!;
  const winner = document.querySelector<HTMLElement>('#winner')!;
  const shadow = document
    .querySelector<HTMLElement>('#preview-host')!
    .attachShadow({ mode: 'open' });
  // Source ownership and the pending update must remain stable throughout asynchronous export.
  let source: HTMLElement | null = null;
  let previewContainer: HTMLElement | null = null;
  let renderFonts: readonly RegisteredFont[] = [];
  let activeFonts: readonly RegisteredFont[] = [];
  let activeOptions: RenderPDFOptions | null = null;
  let missingFaces: readonly MissingFontFace[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let isRegisteringFont = false;
  let isExporting = false;

  /** Freeze every control that can change source text, layout, fonts, or export options. */
  function setControlsLocked(
    /** True while loading a file, registering a face, or writing the two PDFs. */
    locked: boolean,
  ): void {
    for (const control of [
      input,
      optionsInput,
      exampleSelect,
      fileInput,
      fontFamilyInput,
      fontWeightInput,
      fontStyleInput,
      fontFileInput,
      registerFontButton,
      profileStages,
      refresh,
      reset,
    ])
      control.disabled = locked;
    exportButton.disabled = locked || isRegisteringFont || isExporting || source === null;
  }
  input.value = exampleOneHtml.trim();
  optionsInput.value = DEFAULT_OPTIONS_TEXT;
  setControlsLocked(true);
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

  /** Show which exact browser/PDF faces have been explicitly registered. */
  function showRegisteredFonts(): void {
    registeredFontList.replaceChildren();
    for (const face of fonts) {
      const item = document.createElement('li');
      item.textContent = `${face.family} · ${face.weight} ${face.style}`;
      registeredFontList.append(item);
    }
  }
  showRegisteredFonts();

  /** Remove stale measurements whenever the document changes. */
  function clearResults(): void {
    results.hidden = true;
    errors.replaceChildren();
    errors.hidden = true;
    diagnosticsEmpty.hidden = warnings.childElementCount > 0;
    renderProfile.hidden = true;
    renderProfile.open = false;
    renderPhases.replaceChildren();
    winner.textContent = '';
    for (const row of [renderRow, jsPdfRow]) {
      for (const cell of Array.from(row.cells).slice(1)) cell.textContent = '—';
    }
  }

  /** Place a visible input or exporter failure beside the measured results. */
  function showError(
    /** Origin and message to display without interpreting source HTML. */
    message: string,
  ): void {
    const item = document.createElement('li');
    item.textContent = message;
    errors.append(item);
    errors.hidden = false;
    diagnosticsEmpty.hidden = true;
  }

  /** Show measured stage intervals and the time not covered by public progress notifications. */
  function showTimingBreakdown(
    /** Profiled export timings, including Blob creation. */
    timing: RenderTimingBreakdown,
  ): void {
    /** Add one labeled duration without injecting document content into the application UI. */
    function addTiming(
      /** Human-readable stage or overhead category. */
      label: string,
      /** Observed elapsed time in milliseconds. */
      durationMs: number,
    ): void {
      // Each term and value stays a separate accessible definition-list item.
      const term = document.createElement('dt');
      const value = document.createElement('dd');
      term.textContent = label;
      value.textContent = `${durationMs.toFixed(1)} ms`;
      renderPhases.append(term, value);
    }

    renderPhases.replaceChildren();
    for (const phase of timing.phases) {
      addTiming(phase.stage[0]!.toUpperCase() + phase.stage.slice(1), phase.durationMs);
    }
    addTiming('Other / handoffs', timing.otherMs);
    addTiming('Blob creation', timing.blobMs);
    renderProfile.hidden = false;
    renderProfile.open = true;
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
    diagnosticsEmpty.hidden = false;
    source = null;
    previewContainer = null;
    renderFonts = [];
    activeFonts = [];
    activeOptions = null;
    missingFaces = [];
    exportButton.disabled = true;
    missingFontList.replaceChildren();
    missingFontList.hidden = true;
    optionsError.textContent = '';
    optionsError.hidden = true;
    // Keep a valid HTML preview visible even when its PDF settings are invalid.
    let parsedOptions: RenderPDFOptions | null = null;
    let optionsIssue: string | null = null;
    try {
      parsedOptions = parseOptions(optionsInput.value);
    } catch (error) {
      optionsIssue = error instanceof Error ? error.message : String(error);
      optionsError.textContent = optionsIssue;
      optionsError.hidden = false;
      showError(`Options: ${optionsIssue}`);
    }
    try {
      // Validation and layout creation finish before replacing the last source reference.
      const next = createPreview(input.value);
      shadow.replaceChildren(next.container);
      const requirements = inspectFontRequirements(next.source, fonts);
      missingFaces = requirements.missing;
      for (const face of requirements.missing) {
        const item = document.createElement('li');
        item.textContent = `No matching bytes for ${face.family} · ${face.weight} ${face.style}. Register its TTF for an exact font, or use fontMismatch in the JSON options.`;
        missingFontList.append(item);
      }
      for (const issue of requirements.unsupported) {
        const item = document.createElement('li');
        item.textContent = issue;
        missingFontList.append(item);
      }
      missingFontList.hidden = missingFontList.childElementCount === 0;
      if (requirements.missing.length > 0 && !fontFamilyInput.value.trim()) {
        fontFamilyInput.value = requirements.missing[0]!.family;
        fontWeightInput.value = String(requirements.missing[0]!.weight);
        fontStyleInput.value = requirements.missing[0]!.style;
      }
      source = next.exportIssues.length === 0 && parsedOptions ? next.source : null;
      previewContainer = source ? next.container : null;
      activeOptions = source ? parsedOptions : null;
      // A requested substitute must be supplied even when the source never uses that family.
      const fallbackFamily = parsedOptions?.fontFallback?.toLowerCase();
      const preferredFallbackFaces = fallbackFamily
        ? fonts.filter((font) => font.family.toLowerCase() === fallbackFamily)
        : [];
      renderFonts = source
        ? [...new Set([...requirements.usedFonts, ...preferredFallbackFaces])]
        : [];
      const effectiveMismatch =
        parsedOptions?.fontMismatch ??
        (requirements.usedFonts.length === 0 || parsedOptions?.fontFallback !== undefined
          ? 'fallback'
          : 'error');
      // jsPDF still receives application faces for its independent HTML conversion.
      const fallbackFaces = requirements.missing.map(
        (face) =>
          fonts.find(
            (font) =>
              font.family === previewFamily &&
              font.weight === face.weight &&
              font.style === face.style,
          ) ?? fonts[0]!,
      );
      const needsBaseFace =
        requirements.missing.length > 0 ||
        requirements.unsupported.length > 0 ||
        requirements.usedFonts.length === 0;
      activeFonts = source
        ? [
            ...new Set([
              ...requirements.usedFonts,
              ...(needsBaseFace ? [fonts[0]!, ...fallbackFaces] : []),
            ]),
          ]
        : [];
      exportButton.disabled = source === null || isRegisteringFont || isExporting;
      for (const issue of [...next.exportIssues, ...next.limitations]) {
        // A visible preview must not imply that a PDF missing authored assets can be exported.
        const item = document.createElement('li');
        item.textContent = issue;
        warnings.append(item);
      }
      warnings.hidden = warnings.childElementCount === 0;
      diagnosticsEmpty.hidden = warnings.childElementCount > 0 || errors.childElementCount > 0;
      renderLabel.textContent =
        parsedOptions?.verifySource === 'mutations'
          ? 'RenderPDF.js · Fast static HTML'
          : 'RenderPDF.js · Full CSS guard';
      status.textContent = optionsIssue
        ? 'Correct the JSON options before exporting.'
        : source
          ? missingFontList.childElementCount > 0
            ? effectiveMismatch === 'fallback'
              ? 'The preview is ready. RenderPDF.js will report any font substitutions after export.'
              : 'The preview is ready. RenderPDF.js will return an error if a font cannot be matched.'
            : 'The preview is up to date. Both PDFs will use this document.'
          : 'The HTML is displayed. Replace the marked images before exporting.';
    } catch (error) {
      shadow.replaceChildren();
      missingFaces = [];
      missingFontList.replaceChildren();
      missingFontList.hidden = true;
      status.textContent = error instanceof Error ? error.message : String(error);
      showError(`HTML preview: ${status.textContent}`);
    }
  }

  /** Replace edited or uploaded markup with the selected bundled static document. */
  function loadSelectedExample(): void {
    // The select owns only the known bundled IDs; an invalid value leaves the editor intact.
    const html = examples.get(exampleSelect.value);
    if (html === undefined) {
      status.textContent = 'The selected example is unavailable.';
      return;
    }
    fileInput.value = '';
    input.value = html;
    updatePreview();
  }

  /** Debounce editor changes while allowing the export click to flush them synchronously. */
  function schedulePreviewUpdate(): void {
    clearTimeout(timer);
    clearResults();
    source = null;
    previewContainer = null;
    activeOptions = null;
    // Keep export clickable while debouncing: its handler validates and flushes current input.
    exportButton.disabled = isRegisteringFont || isExporting;
    status.textContent = 'Updating the preview…';
    timer = setTimeout(updatePreview, 250);
  }
  input.addEventListener('input', schedulePreviewUpdate);
  optionsInput.addEventListener('input', schedulePreviewUpdate);
  profileStages.addEventListener('change', clearResults);
  exampleSelect.addEventListener('change', loadSelectedExample);
  registerFontButton.addEventListener('click', async () => {
    if (isRegisteringFont || isExporting) return;
    // A local file is assigned to the exact CSS descriptor supplied by the user.
    const file = fontFileInput.files?.[0];
    const family = fontFamilyInput.value.trim();
    const weight = Number(fontWeightInput.value);
    const style = fontStyleInput.value;
    if (
      !file ||
      !family ||
      !Number.isInteger(weight) ||
      weight < 100 ||
      weight > 900 ||
      weight % 100 !== 0 ||
      (style !== 'normal' && style !== 'italic')
    ) {
      fontStatus.textContent =
        'Choose a TTF file and enter its CSS family, a 100–900 weight in steps of 100, and style.';
      return;
    }
    if (!/\.ttf$/i.test(file.name) || file.size > 20 * 1024 * 1024) {
      fontStatus.textContent =
        'Choose a static .ttf file no larger than 20 MiB. OTF is unsupported by jsPDF HTML export.';
      return;
    }
    isRegisteringFont = true;
    setControlsLocked(true);
    fontStatus.textContent = `Registering ${family} ${weight} ${style}…`;
    try {
      const bytes = await file.arrayBuffer();
      // jsPDF's HTML plugin only imports TrueType URLs; reject OTF bytes regardless of suffix.
      if (bytes.byteLength < 4 || new DataView(bytes).getUint32(0) !== 0x00010000) {
        throw new Error(
          'The selected file is not a static TrueType font. OTF is unsupported by jsPDF HTML export.',
        );
      }
      const face = await registerFont({ family, weight, style, data: bytes });
      if (!fonts.includes(face)) fonts.push(face);
      showRegisteredFonts();
      fontFileInput.value = '';
      fontStatus.textContent = `Registered ${family} ${weight} ${style} for both PDF exporters.`;
      // Rebuild connected layout after FontFaceSet changes; it can now use the owned program.
      updatePreview();
      const nextFace = missingFaces[0];
      if (nextFace) {
        fontFamilyInput.value = nextFace.family;
        fontWeightInput.value = String(nextFace.weight);
        fontStyleInput.value = nextFace.style;
      }
    } catch (error) {
      fontStatus.textContent =
        error instanceof Error ? `Font registration failed: ${error.message}` : String(error);
      updatePreview();
    } finally {
      isRegisteringFont = false;
      setControlsLocked(false);
    }
  });
  fileInput.addEventListener('change', async () => {
    // File bytes are decoded as UTF-8; the original file is never uploaded or modified.
    const file = fileInput.files?.[0];
    if (!file) return;
    setControlsLocked(true);
    try {
      if (!/\.html?$/i.test(file.name)) throw new Error('Choose an .html or .htm file.');
      if (file.size > 10 * 1024 * 1024)
        throw new Error('The HTML file must be no larger than 10 MiB.');
      input.value = await file.text();
      updatePreview();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      setControlsLocked(false);
    }
  });
  refresh.addEventListener('click', updatePreview);
  reset.addEventListener('click', loadSelectedExample);
  exportButton.addEventListener('click', async () => {
    if (isRegisteringFont || isExporting) return;
    updatePreview();
    if (!source || !previewContainer || !activeOptions) return;
    // Lock all editing before conversion; no preview replacement may race with measurement/capture.
    isExporting = true;
    setControlsLocked(true);
    status.textContent = 'Measuring RenderPDF.js…';
    // Independent errors keep a successful output available even if the other renderer fails.
    let renderMeasurement: ExportMeasurement | null = null;
    let jsPdfMeasurement: ExportMeasurement | null = null;
    try {
      renderMeasurement = await measureRenderPdf(
        source,
        renderFonts,
        activeOptions,
        profileStages.checked,
      );
      showMeasurement(renderRow, renderMeasurement);
      if (renderMeasurement.timing) showTimingBreakdown(renderMeasurement.timing);
      for (const warning of renderMeasurement.warnings) {
        const item = document.createElement('li');
        item.textContent = `${warning.code}: ${warning.message}`;
        warnings.append(item);
      }
    } catch (error) {
      const message =
        error instanceof RenderPDFError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
      showMeasurement(renderRow, message);
      showError(`RenderPDF.js: ${message}`);
    }
    status.textContent = 'Measuring jsPDF…';
    try {
      jsPdfMeasurement = await measureJsPdf(previewContainer, activeFonts);
      showMeasurement(jsPdfRow, jsPdfMeasurement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showMeasurement(jsPdfRow, message);
      showError(`jsPDF: ${message}`);
    }
    warnings.hidden = warnings.childElementCount === 0;
    diagnosticsEmpty.hidden = warnings.childElementCount > 0 || errors.childElementCount > 0;
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
      isExporting = false;
      setControlsLocked(false);
    }
  });
  setControlsLocked(false);
  updatePreview();
}

initialize().catch((error: unknown) => {
  // Failed font setup must stay visible and keep export disabled.
  document.querySelector<HTMLElement>('#status')!.textContent =
    error instanceof Error ? error.message : String(error);
});
