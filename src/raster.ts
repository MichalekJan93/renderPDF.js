import { toPng } from 'html-to-image';
import type { RegisteredFont } from './api-types.js';
import { RenderPDFError } from './diagnostics.js';
import { computedStyle, isHtmlElement, isHtmlTag } from './dom.js';
import { resolveRegisteredFont } from './fonts.js';

/** Bounds the memory of the experiment's temporary canvas, in physical pixels. */
const MAX_RASTER_PIXELS = 16_777_216;

/** Bounds each canvas axis before html-to-image can silently resize it. */
const MAX_RASTER_EDGE = 8_192;

/** Matches self-contained bitmap resources; SVG can contain further external URLs. */
const INLINE_BITMAP = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/=\s]+$/i;

/** Converts an explicitly registered font into a self-contained CSS font source. */
function fontFaceCss(
  /** Exact font face shared with browser layout and PDF embedding. */
  font: RegisteredFont,
): string {
  // Read immutable registered bytes once; the public handle returns defensive copies.
  const bytes = font.bytes;
  if (!/^[\w -]+$/.test(font.family) || bytes.byteLength === 0) {
    throw new RenderPDFError(
      'RASTER_FAILED',
      'Raster capture requires nonempty registered fonts with plain CSS family names.',
    );
  }

  // Convert small chunks to avoid spreading an entire font into the call stack.
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }

  // CFF OpenType and TrueType both remain self-contained with their matching CSS format hint.
  const opentype = bytes[0] === 0x4f && bytes[1] === 0x54 && bytes[2] === 0x54 && bytes[3] === 0x4f;
  return `@font-face { font-family: "${font.family}"; font-weight: ${font.weight}; font-style: ${font.style}; src: url("data:font/${opentype ? 'otf' : 'ttf'};base64,${btoa(binary)}") format("${opentype ? 'opentype' : 'truetype'}"); }`;
}

/** Rejects image references that would require network access inside an SVG image. */
function assertInlineResources(
  /** Computed style whose URL-valued properties html-to-image will clone. */
  style: CSSStyleDeclaration,
): void {
  // Inspect all computed URL values, including masks and border images.
  for (const property of style) {
    // CSSOM serializes URL values with quotes; the optional quotes also cover data URLs.
    const value = style.getPropertyValue(property);
    for (const match of value.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
      if (!INLINE_BITMAP.test(match[2] ?? '')) {
        throw new RenderPDFError(
          'RASTER_FAILED',
          `Raster capture requires inline bitmap resources (${property}).`,
        );
      }
    }
  }
}

/** Ensures a subtree can be captured without external or surrounding document state. */
function assertSelfContained(
  /** Bounded region selected explicitly by the rendering planner. */
  element: HTMLElement,
  /** Font programs allowed in the cloned SVG document. */
  fonts: readonly RegisteredFont[],
): void {
  // Bounds permit inner clipping but reject descendants painted outside the capture.
  const rootBounds = element.getBoundingClientRect();
  // Include the region itself when checking resources and context-dependent effects.
  const descendants = [element, ...element.querySelectorAll('*')];
  for (const descendant of descendants) {
    if (!isHtmlElement(descendant)) {
      throw new RenderPDFError(
        'RASTER_FAILED',
        'Raster capture supports HTML subtrees only; inline SVG needs a separate experiment.',
      );
    }
    if (
      descendant.shadowRoot ||
      descendant.tagName.includes('-') ||
      descendant.tagName === 'SLOT'
    ) {
      throw new RenderPDFError(
        'RASTER_FAILED',
        'Raster capture does not inspect shadow trees or distributed slot content in supported renderer.',
      );
    }
    if (
      /^(CANVAS|IFRAME|OBJECT|EMBED|VIDEO|AUDIO|INPUT|TEXTAREA|SELECT|SCRIPT|STYLE|LINK)$/.test(
        descendant.tagName,
      )
    ) {
      throw new RenderPDFError(
        'RASTER_FAILED',
        `Raster capture does not support ${descendant.tagName.toLowerCase()} elements.`,
      );
    }

    // Use the same computed declarations that html-to-image copies into its clone.
    const style = computedStyle(descendant);
    assertInlineResources(style);
    if (style.mixBlendMode !== 'normal' || style.backdropFilter !== 'none') {
      throw new RenderPDFError(
        'RASTER_FAILED',
        'Raster capture cannot reproduce blending with pixels outside its subtree.',
      );
    }
    if (style.position === 'fixed' || style.position === 'sticky') {
      throw new RenderPDFError(
        'RASTER_FAILED',
        'Raster capture does not reproduce viewport-dependent positioning.',
      );
    }
    if (descendant !== element && style.position === 'absolute') {
      throw new RenderPDFError(
        'RASTER_FAILED',
        'Raster capture does not normalize external containing blocks for positioned descendants.',
      );
    }
    // Split top-level shadows without splitting rgb() color component commas.
    const shadows = style.boxShadow.split(/,(?![^(]*\))/);
    if (
      style.filter !== 'none' ||
      (style.boxShadow !== 'none' &&
        shadows.some(
          /** Every shadow must remain inside the selected element's own border box. */
          (shadow) => !shadow.includes('inset'),
        ))
    ) {
      throw new RenderPDFError(
        'RASTER_FAILED',
        'Raster capture requires effects contained in the border box; outer shadows and filters need expanded bounds.',
      );
    }
    if (
      style.textShadow !== 'none' ||
      (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0)
    ) {
      throw new RenderPDFError(
        'RASTER_FAILED',
        'Raster capture requires expanded bounds before capturing text shadows or outlines.',
      );
    }
    if (style.backgroundAttachment.includes('fixed')) {
      throw new RenderPDFError(
        'RASTER_FAILED',
        'Raster capture does not preserve viewport-dependent background attachment.',
      );
    }
    if (descendant === element && style.transform !== 'none') {
      throw new RenderPDFError(
        'RASTER_FAILED',
        'Raster capture does not normalize transformed region coordinates.',
      );
    }
    if (style.display === 'list-item') {
      throw new RenderPDFError(
        'RASTER_FAILED',
        'Raster capture does not preserve generated list markers in supported renderer.',
      );
    }

    // Generated content has separate geometry and no extraction counterpart in this experiment.
    for (const pseudo of ['::before', '::after']) {
      // Pseudo-elements with even empty content can paint backgrounds or borders.
      const content = computedStyle(descendant, pseudo).content;
      if (content !== 'none' && content !== 'normal') {
        throw new RenderPDFError(
          'RASTER_FAILED',
          'Raster capture does not support generated pseudo-element content in supported renderer.',
        );
      }
    }

    if (isHtmlTag(descendant, 'img')) {
      if (descendant.srcset || !INLINE_BITMAP.test(descendant.currentSrc || descendant.src)) {
        throw new RenderPDFError(
          'RASTER_FAILED',
          'Raster capture requires inline bitmap images without srcset.',
        );
      }
      if (!descendant.complete || descendant.naturalWidth === 0) {
        throw new RenderPDFError(
          'RASTER_FAILED',
          'Raster capture requires successfully decoded images.',
        );
      }
    }

    // Check visible text nodes only; container font defaults do not create glyphs.
    const hasOwnText = [...descendant.childNodes].some(
      /** A direct text child whose face must exist inside the SVG image. */
      (child) => child.nodeType === Node.TEXT_NODE && Boolean(child.textContent?.trim()),
    );
    if (hasOwnText) {
      if (!style.font) {
        throw new RenderPDFError(
          'RASTER_FAILED',
          'Raster capture requires a serializable computed font shorthand to preserve exact font sizes.',
        );
      }
      // One shared resolver keeps native and raster text on the same browser-selected face.
      resolveRegisteredFont(style, fonts);
    }

    // Ignore hidden descendants, whose zero geometry cannot escape the capture.
    const bounds = descendant.getBoundingClientRect();
    if (
      bounds.width > 0 &&
      bounds.height > 0 &&
      (bounds.left < rootBounds.left - 0.5 ||
        bounds.top < rootBounds.top - 0.5 ||
        bounds.right > rootBounds.right + 0.5 ||
        bounds.bottom > rootBounds.bottom + 0.5)
    ) {
      throw new RenderPDFError(
        'RASTER_FAILED',
        'Raster capture descendants must stay inside the selected border box.',
      );
    }
  }
}

/**
 * Captures one explicitly isolated, self-contained HTML region as PNG bytes.
 * Gradients, rounded corners and inset shadows remain browser-painted. Effects
 * involving a backdrop, external assets or pixels beyond the box fail explicitly.
 */
export async function captureRaster(
  /** Connected source region; capture never mutates its DOM. */
  element: HTMLElement,
  /** Font bytes also used to lay out the original browser document. */
  fonts: readonly RegisteredFont[],
  /** Physical bitmap pixels per CSS pixel. */
  scale: number,
  /** Fractional CSS origin retained inside a bitmap placed on an integer pixel grid. */
  offset: {
    /** Horizontal transparent padding in CSS pixels, from zero inclusive to one exclusive. */
    x: number;
    /** Vertical transparent padding in CSS pixels, from zero inclusive to one exclusive. */
    y: number;
  } = { x: 0, y: 0 },
): Promise<Uint8Array> {
  if (!element.isConnected || !element.ownerDocument.defaultView) {
    throw new RenderPDFError(
      'RASTER_FAILED',
      'Raster capture requires a connected element in a live document.',
    );
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RenderPDFError('RASTER_FAILED', 'Raster scale must be a finite positive number.');
  }
  if (
    !offset ||
    ![offset.x, offset.y].every(
      /** Offset fractions preserve the source's sampling phase without moving its layout. */
      (fraction) => Number.isFinite(fraction) && fraction >= 0 && fraction < 1,
    )
  ) {
    throw new RenderPDFError(
      'RASTER_FAILED',
      'Raster offsets must be finite CSS pixel fractions from zero inclusive to one exclusive.',
    );
  }

  await element.ownerDocument.fonts.ready;
  // Match the browser's measured border box and preserve fractional CSS dimensions.
  const { width, height } = element.getBoundingClientRect();
  // Transparent padding carries a fractional source origin within an integer-aligned image.
  const captureWidth = Math.ceil(width + offset.x);
  const captureHeight = Math.ceil(height + offset.y);
  // Reject an oversized bitmap before html-to-image allocates or automatically shrinks it.
  const pixelWidth = Math.ceil(captureWidth * scale);
  const pixelHeight = Math.ceil(captureHeight * scale);
  if (
    width <= 0 ||
    height <= 0 ||
    pixelWidth < 1 ||
    pixelHeight < 1 ||
    pixelWidth > MAX_RASTER_EDGE ||
    pixelHeight > MAX_RASTER_EDGE ||
    pixelWidth * pixelHeight > MAX_RASTER_PIXELS
  ) {
    throw new RenderPDFError(
      'RASTER_FAILED',
      'Raster region exceeds the supported renderer canvas budget or has empty bounds.',
    );
  }

  assertSelfContained(element, fonts);
  // Supplying fontEmbedCSS bypasses stylesheet scanning and external font requests.
  const fontEmbedCSS = fonts.map(fontFaceCss).join('\n');
  // html-to-image 1.11.13 floors font-size and subtracts 0.1px; copy the exact font shorthand first instead.
  // Upstream behavior: https://github.com/bubkoo/html-to-image/blob/v1.11.13/src/clone-node.ts#L139-L143
  const includeStyleProperties = [
    'font',
    ...Array.from(computedStyle(element)).filter(
      /** Preserve every other computed longhand after setting the exact font shorthand. */
      (property) => property !== 'font-size',
    ),
  ];
  // html-to-image clones computed styles; only the selected root's placement is normalized.
  const dataUrl = await toPng(element, {
    width: captureWidth,
    height: captureHeight,
    pixelRatio: scale,
    skipAutoScale: true,
    fontEmbedCSS,
    includeStyleProperties,
    // Manual styles are applied after SVG viewport dimensions, preserving the original box size.
    style: {
      margin: '0',
      top: '0',
      left: '0',
      right: 'auto',
      bottom: 'auto',
      boxSizing: 'border-box',
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(${offset.x}px, ${offset.y}px)`,
    },
  });
  // Decode only the generated local data URL; no fetch or upload occurs here.
  const payload = dataUrl.match(/^data:image\/png;base64,(.+)$/)?.[1];
  if (!payload) {
    throw new RenderPDFError('RASTER_FAILED', 'Raster capture produced an empty or invalid PNG.');
  }
  // Decoded bytes can be embedded directly by the isolated PDF writer.
  const binary = atob(payload);
  return Uint8Array.from(
    binary,
    /** Byte value at the current position in the binary PNG string. */
    (character) => character.charCodeAt(0),
  );
}
