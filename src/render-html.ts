import type {
  FontSource,
  PageTextOptions,
  PageTextSlotsOptions,
  RenderPDFOptions,
  RenderPDFResult,
  RegisteredFont,
} from './api-types.js';
import { RenderPDFError, throwIfAborted, type RenderWarning } from './diagnostics.js';
import { computedStyle, isHtmlElement } from './dom.js';
import { registerFont } from './fonts.js';
import { resolvePageGeometry } from './page.js';
import { withCancellation } from './prepare.js';
import { renderPDF } from './render-pdf.js';

/** A source-owned HTML fragment painted in a reserved page header or footer. */
export interface RenderHTMLBand {
  /** Browser markup parsed inside the same isolated document as the source. */
  html: string;
  /** Reserved page height in CSS pixels. */
  height: number;
}

/** HTML text bands use fonts registered in the isolated document, selected by default. */
export type RenderHTMLTextBand = Omit<PageTextOptions, 'font'> | Omit<PageTextSlotsOptions, 'font'>;

/** Self-contained HTML-string entry point; all created DOM and font faces are released together. */
export interface RenderHTMLOptions extends Omit<RenderPDFOptions, 'fonts' | 'header' | 'footer'> {
  /** Exact font programs to register inside this export's isolated document. */
  fonts: readonly Omit<FontSource, 'document'>[];
  /** Full document or fragment in a ShadowRoot; both modes use an owned sandboxed iframe. */
  isolation?: 'iframe' | 'shadow';
  /** Browser viewport width in CSS pixels before PDF fitting; defaults to portrait printable width. */
  sourceWidth?: number;
  /** Supplied family used to relayout copied elements whose first CSS family is unregistered. */
  fontFallback?: string;
  /** Repeated text or HTML in a reserved band above each page. */
  header?: RenderHTMLTextBand | RenderHTMLBand;
  /** Repeated text or HTML in a reserved band below each page. */
  footer?: RenderHTMLTextBand | RenderHTMLBand;
}

/** Reject active markup before it can be attached to a browser document. */
function assertInertMarkup(markup: string, label: string): void {
  if (typeof markup !== 'string' || !markup.trim()) {
    throw new RenderPDFError('INVALID_SOURCE', `${label} requires nonempty HTML.`);
  }
  // DOMParser is inert; the sandboxed destination additionally forbids script execution.
  const parsed = new DOMParser().parseFromString(markup, 'text/html');
  for (const element of parsed.querySelectorAll('*')) {
    // Template contents evade querySelectorAll and may activate during srcdoc parsing.
    if (
      [
        'SCRIPT',
        'IFRAME',
        'FRAME',
        'FRAMESET',
        'OBJECT',
        'EMBED',
        'BASE',
        'LINK',
        'TEMPLATE',
      ].includes(element.tagName)
    ) {
      throw new RenderPDFError(
        'UNSUPPORTED_ELEMENT',
        `${label} cannot contain ${element.tagName}.`,
      );
    }
    if (
      element.tagName === 'META' &&
      element.getAttribute('http-equiv')?.trim().toLowerCase() === 'refresh'
    ) {
      throw new RenderPDFError('UNSUPPORTED_ELEMENT', `${label} cannot refresh the document.`);
    }
    for (const attribute of element.attributes) {
      // URL parsing discards embedded ASCII tabs/newlines before selecting a scheme.
      const value = attribute.value.replace(/[\t\n\r]/g, '').trim();
      if (
        attribute.name.toLowerCase().startsWith('on') ||
        attribute.name.toLowerCase() === 'srcdoc' ||
        attribute.name.toLowerCase() === 'is' ||
        /^(?:javascript|vbscript):/i.test(value)
      ) {
        throw new RenderPDFError('UNSUPPORTED_ELEMENT', `${label} contains an active attribute.`);
      }
    }
  }
}

/** Convert a caller-supplied HTML band into a connected element outside the measured body. */
function createHtmlBand(
  sourceDocument: Document,
  band: RenderHTMLBand,
  printableWidth: number,
): { height: number; element: HTMLElement } {
  assertInertMarkup(band.html, 'Page band');
  if (!Number.isFinite(band.height) || band.height <= 0) {
    throw new RenderPDFError('INVALID_OPTIONS', 'HTML page-band height must be positive.');
  }
  // A sibling of BODY stays outside the source traversal while sharing its document and fonts.
  const host = sourceDocument.createElement('div');
  host.style.cssText = `position:absolute;left:-100000px;top:0;width:${printableWidth}px;`;
  sourceDocument.documentElement.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const element = sourceDocument.createElement('div');
  element.style.cssText = `box-sizing:border-box;width:${printableWidth}px;min-height:${band.height}px;`;
  element.innerHTML = band.html;
  shadow.append(element);
  return { height: band.height, element };
}

/** Keep a text band as text or parse HTML in the same document as its source. */
function resolveHtmlBand(
  sourceDocument: Document,
  band: RenderHTMLTextBand | RenderHTMLBand | undefined,
  printableWidth: number,
): RenderPDFOptions['header'] {
  if (!band) return undefined;
  if ('html' in band) return createHtmlBand(sourceDocument, band, printableWidth);
  if ('font' in band && band.font !== undefined) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'renderHTML text bands use supplied fonts by default.',
    );
  }
  return band;
}

/** Reflow only copied elements whose CSS first family has no supplied program. */
function substituteFonts(
  source: HTMLElement,
  registered: readonly RegisteredFont[],
  fallbackFamily: string,
): number {
  const families = new Set(registered.map((font) => font.family.toLowerCase()));
  if (!families.has(fallbackFamily.toLowerCase())) {
    throw new RenderPDFError('INVALID_OPTIONS', 'fontFallback must name a supplied font family.');
  }
  let substitutions = 0;
  for (const element of [source, ...source.querySelectorAll('*')]) {
    if (!isHtmlElement(element)) continue;
    const firstFamily = computedStyle(element)
      .fontFamily.split(',')[0]
      ?.trim()
      .replace(/^["']|["']$/g, '')
      .toLowerCase();
    if (firstFamily && !families.has(firstFamily)) {
      // An inline important declaration changes browser layout before its PDF geometry is read.
      element.style.setProperty('font-family', `"${fallbackFamily}"`, 'important');
      substitutions += 1;
    }
  }
  return substitutions;
}

/** Parse and export HTML through one source document, releasing it on every outcome. */
export async function renderHTML(
  /** A full document for iframe mode, or a fragment for shadow mode. */
  html: string,
  /** Explicit font programs, page layout, optional source width and isolation policy. */
  options: RenderHTMLOptions,
): Promise<RenderPDFResult> {
  if (!options || !Array.isArray(options.fonts) || options.fonts.length === 0) {
    throw new RenderPDFError('INVALID_OPTIONS', 'renderHTML requires explicit font programs.');
  }
  assertInertMarkup(html, 'Source');
  const {
    fonts: fontSources,
    isolation = 'iframe',
    sourceWidth,
    fontFallback,
    header,
    footer,
    ...pdfOptions
  } = options;
  if (isolation !== 'iframe' && isolation !== 'shadow') {
    throw new RenderPDFError('INVALID_OPTIONS', 'HTML isolation must be iframe or shadow.');
  }
  if (isolation === 'shadow' && /<\s*(?:html|head|body)\b/i.test(html)) {
    throw new RenderPDFError(
      'INVALID_SOURCE',
      'Use iframe isolation for a complete HTML document.',
    );
  }
  // The default viewport reproduces a normal A4 source without changing author-supplied widths.
  const page = resolvePageGeometry({
    format: options.format ?? 'A4',
    margin: options.margin ?? 24,
    orientation: options.orientation === 'landscape' ? 'landscape' : 'portrait',
  });
  const printableWidth = page.width - page.margin.left - page.margin.right;
  const viewportWidth = sourceWidth ?? Math.floor(printableWidth);
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0 || viewportWidth > 32_768) {
    throw new RenderPDFError('INVALID_OPTIONS', 'sourceWidth must be a positive CSS-pixel width.');
  }
  throwIfAborted(options.signal);
  // The destination uses its own FontFaceSet, so temporary registrations disappear with it.
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.style.cssText = `position:fixed;left:-100000px;top:0;width:${viewportWidth}px;height:1000px;border:0;pointer-events:none;`;
  frame.srcdoc = isolation === 'iframe' ? html : '<!doctype html><html><body></body></html>';
  const loaded = new Promise<void>((resolve, reject) => {
    frame.addEventListener('load', () => resolve(), { once: true });
    frame.addEventListener(
      'error',
      () => reject(new RenderPDFError('RESOURCE_LOAD_FAILED', 'Isolated HTML failed to load.')),
      { once: true },
    );
  });
  document.body.append(frame);
  try {
    await withCancellation(loaded, options.signal);
    const sourceDocument = frame.contentDocument;
    if (!sourceDocument?.body || !sourceDocument.defaultView) {
      throw new RenderPDFError('INVALID_SOURCE', 'Isolated HTML document is unavailable.');
    }
    // Shadow fragments use an otherwise blank document; the wrapper is the measured source.
    let source: HTMLElement = sourceDocument.body;
    if (isolation === 'shadow') {
      sourceDocument.body.style.margin = '0';
      const host = sourceDocument.createElement('div');
      host.style.width = `${viewportWidth}px`;
      sourceDocument.body.append(host);
      const shadow = host.attachShadow({ mode: 'open' });
      source = sourceDocument.createElement('div');
      source.style.width = `${viewportWidth}px`;
      source.innerHTML = html;
      shadow.append(source);
    }
    const fonts = await Promise.all(
      fontSources.map((font) => registerFont({ ...font, document: sourceDocument })),
    );
    // Custom HTML bands never enter BODY's display list; they share source fonts and CSS pixels.
    const resolvedHeader = resolveHtmlBand(sourceDocument, header, printableWidth);
    const resolvedFooter = resolveHtmlBand(sourceDocument, footer, printableWidth);
    const substituted = fontFallback
      ? substituteFonts(source, fonts, fontFallback) +
        (resolvedHeader && 'element' in resolvedHeader
          ? substituteFonts(resolvedHeader.element, fonts, fontFallback)
          : 0) +
        (resolvedFooter && 'element' in resolvedFooter
          ? substituteFonts(resolvedFooter.element, fonts, fontFallback)
          : 0)
      : 0;
    const substitutionWarning: RenderWarning | undefined = substituted
      ? {
          code: 'FONT_SUBSTITUTED',
          message: `${substituted} copied HTML elements were relaid out with ${fontFallback} because their first CSS font family was not supplied.`,
        }
      : undefined;
    if (substitutionWarning) options.onWarning?.(substitutionWarning);
    const result = await renderPDF(source, {
      ...pdfOptions,
      fonts,
      ...(resolvedHeader ? { header: resolvedHeader } : {}),
      ...(resolvedFooter ? { footer: resolvedFooter } : {}),
    });
    if (!substitutionWarning) return result;
    return Object.freeze({
      ...result,
      warnings: Object.freeze([Object.freeze(substitutionWarning), ...result.warnings]),
    });
  } finally {
    frame.remove();
  }
}
