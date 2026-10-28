import './document.css';
import { loadBrowserFont } from './browser-export';
import { renderPDF } from '../src/index';
import { runExperiment } from './pdf';
import { resolvePage } from '../src/page';
import type { ExperimentResult } from './pdf';
import type { RegisteredFont } from '../src/index';

/** Test hooks expose this local document experiment without creating a stable package API. */
declare global {
  interface Window {
    /** Current source and exact fonts used by the visible document's PDF export. */
    documentExperiment: {
      /** Return the currently displayed, supported source root. */
      getSource: () => HTMLElement | null;
      /** Convert the same source seen in the preview, entirely in the browser. */
      export: () => Promise<ExperimentResult>;
      /** Exact registered face programs used by browser layout and PDF embedding. */
      fonts: RegisteredFont[];
    };
  }
}

/** Reject active content and resource requests before adopting any supplied HTML. */
function parseStaticDocument(
  /** Original HTML text read from a user-selected local file. */
  html: string,
): Document {
  // DOMParser creates an inert document; validation completes before live DOM adoption.
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  if (
    parsed.querySelector(
      'script, iframe, frame, object, embed, form, input, button, link, base, audio, video, source, track, svg, math, template, meta[http-equiv="refresh" i]',
    )
  ) {
    throw new Error(
      'This preview accepts only static HTML without scripts, forms or external documents.',
    );
  }
  for (const element of parsed.querySelectorAll('*')) {
    // Event handlers and external resource attributes are outside this local document probe.
    for (const attribute of element.attributes) {
      if (
        /^on/i.test(attribute.name) ||
        /^(?:src|srcset|srcdoc|poster|background|href|xlink:href|action|formaction)$/i.test(
          attribute.name,
        )
      ) {
        throw new Error('This test preview does not support external images or active content.');
      }
    }
  }
  // CSS resources must not initiate requests when a private document enters the live preview.
  const css =
    [...parsed.querySelectorAll('style')].map((element) => element.textContent).join('\n') +
    [...parsed.querySelectorAll('[style]')]
      .map((element) => element.getAttribute('style'))
      .join('\n');
  if (/@import\b|(?:url|(?:-webkit-)?image-set)\s*\(|\\/i.test(css)) {
    throw new Error('This test preview does not support external CSS resources.');
  }
  return parsed;
}

/** Prefer local Tahoma programs; use the bundled open font with a visible substitution note. */
async function loadDocumentFonts(): Promise<{ fonts: RegisteredFont[]; note: string }> {
  // Local system fonts remain in ignored artifacts and never enter a distributable package.
  if (import.meta.env.DEV && !new URLSearchParams(window.location.search).has('empty')) {
    try {
      // This preview deliberately uses one known family to match the supplied legacy document.
      const fonts = await Promise.all([
        loadBrowserFont('/artifacts/preview/fonts/Tahoma-Regular.ttf', 'Tahoma', 400),
        loadBrowserFont('/artifacts/preview/fonts/Tahoma-Bold.ttf', 'Tahoma', 700),
      ]);
      return { fonts, note: 'Preview and PDF font: Tahoma.' };
    } catch {
      // A repository checkout need not include the user's local system font files.
    }
  }
  // The fallback is explicit in the UI and uses identical bytes for preview and PDF.
  const fonts = await Promise.all([
    loadBrowserFont('/fonts/NotoSans-Regular.ttf', 'Noto Sans', 400),
    loadBrowserFont('/fonts/NotoSans-Bold.ttf', 'Noto Sans', 700),
  ]);
  return { fonts, note: 'Font: Noto Sans (substituted for unavailable local Tahoma).' };
}

/** Display and export one local static document through the existing native PDF pipeline. */
async function initializeDocument(): Promise<void> {
  // The toolbar is deliberately outside the document source being measured and exported.
  const button = document.querySelector<HTMLButtonElement>('#document-export')!;
  const input = document.querySelector<HTMLInputElement>('#document-file')!;
  const status = document.querySelector<HTMLElement>('#document-status')!;
  const name = document.querySelector<HTMLElement>('#document-name')!;
  // A shadow root contains legacy source styles so they cannot change the application's UI.
  const shadow = document
    .querySelector<HTMLElement>('#document-preview')!
    .attachShadow({ mode: 'open' });
  // The browser and PDF writer must agree on the exact regular and bold face programs.
  const { fonts, note } = await loadDocumentFonts();
  // The preview uses the core's default paper geometry instead of duplicating physical dimensions.
  const page = resolvePage({ fonts });
  document.querySelector<HTMLElement>('#document-font')!.textContent = note;
  // This reference changes only after a replacement file has parsed and passed validation.
  let source: HTMLElement | null = null;
  // The suggested filename follows the selected local file, without modifying the original.
  let filename = 'account-statement.pdf';

  /** Parse and show supported static HTML at the exact A4 content width used for PDF layout. */
  function showDocument(
    /** Complete original local document text. */
    html: string,
    /** User-facing file label and download-name source. */
    label: string,
  ): void {
    // Inert parsing prevents document scripts or attributes from executing in the preview.
    const parsed = parseStaticDocument(html);
    // The source's geometry includes the default HTML body's 8px whitespace on each side.
    const next = document.createElement('div');
    next.id = 'document-source';
    Object.assign(next.style, {
      display: 'flow-root',
      boxSizing: 'border-box',
      width: `${page.width - page.margin.left - page.margin.right}px`,
      padding: '8px',
      margin: '0',
      background: 'white',
      color: 'black',
      fontFamily: fonts[0]!.family,
      fontSize: '16px',
      lineHeight: 'normal',
    });
    next.append(...Array.from(parsed.body.childNodes));
    // This preview uses one explicit family; any substitution is stated above the preview.
    for (const element of [next, ...next.querySelectorAll<HTMLElement>('*')]) {
      if (
        [...element.childNodes].some((child) => child instanceof Text && Boolean(child.data.trim()))
      ) {
        element.style.fontFamily = fonts[0]!.family;
      }
    }
    shadow.replaceChildren(...Array.from(parsed.head.querySelectorAll('style')), next);
    source = next;
    filename = label.replace(/\.(?:html?|pdf)$/i, '') + '.pdf';
    name.textContent = label;
    button.disabled = false;
    status.textContent = 'The document is ready. Download PDF converts this preview directly.';
  }

  window.documentExperiment = {
    fonts,
    getSource: () => source,
    export: async () => {
      if (!source) throw new Error('Open an HTML document first.');
      return runExperiment(source, fonts);
    },
  };
  input.addEventListener('change', async () => {
    // File text is read locally; it is never uploaded or persisted by this page.
    const file = input.files?.[0];
    if (!file) return;
    try {
      // Reject invalid UTF-8 instead of silently inserting replacement characters into the PDF.
      const html = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      showDocument(html, file.name);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  });
  button.addEventListener('click', async () => {
    button.disabled = true;
    input.disabled = true;
    status.textContent = 'Creating PDF…';
    try {
      if (!source) throw new Error('Open an HTML document first.');
      // The user action exercises the same public API available to library consumers.
      const result = await renderPDF(source, { fonts });
      await result.download(filename);
      status.textContent = `PDF created: ${result.pageCount} pages, ${(await result.toUint8Array()).length.toLocaleString('en-US')} bytes. Text is selectable.`;
    } catch (error) {
      status.textContent = `PDF creation failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      button.disabled = source === null;
      input.disabled = false;
    }
  });
  if (import.meta.env.DEV && !new URLSearchParams(window.location.search).has('empty')) {
    try {
      // A plain-text copy prevents Vite from injecting its development script into source HTML.
      const response = await fetch('/artifacts/preview/current-document.txt');
      if (response.ok) {
        showDocument(await response.text(), 'account-statement.html');
        return;
      }
    } catch (error) {
      // A present but unsupported source must expose its error instead of silently disappearing.
      status.textContent = `Could not open the document: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
  }
  status.textContent = 'Choose a file with Open HTML.';
}

initializeDocument().catch((error: unknown) => {
  // Bootstrap failures must be visible instead of leaving an apparently ready export button.
  document.querySelector<HTMLElement>('#document-status')!.textContent = String(error);
});
