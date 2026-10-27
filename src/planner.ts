import { RenderPDFError } from './diagnostics.js';
import { isHtmlTag } from './dom.js';

// Self-contained raster backgrounds cannot depend on SVG resources or export-time requests.
const INLINE_BITMAP = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/=\s]+$/i;

/** Split computed CSS image/shadow layers without splitting nested color or gradient functions.
 * @param value Browser-validated computed declaration containing comma-separated layers.
 */
function cssLayers(value: string): string[] {
  // Parentheses and quoted URL contents own their commas until the current layer ends.
  let depth = 0;
  // Empty quotes indicate that parsing currently occurs outside a CSS string.
  let quote = '';
  // Each layer begins immediately after the preceding top-level comma.
  let start = 0;
  // The browser already validates the declaration; this parser only locates its layer boundaries.
  const layers: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    // Escaped quotes and parentheses are literal URL/string content.
    const character = value[index]!;
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      layers.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  layers.push(value.slice(start).trim());
  return layers;
}

/** Identify only effects that a bounded subtree can reproduce without surrounding pixels.
 * @param style Browser-computed declarations; native layout and typography remain unchanged.
 */
export function automaticRasterReason(style: CSSStyleDeclaration): string | undefined {
  // Each reason names an effect owned by this element, never an unsupported descendant.
  const reasons: string[] = [];
  if (style.backgroundImage !== 'none') {
    for (const layer of cssLayers(style.backgroundImage)) {
      if (/^(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(layer)) continue;
      // Background URLs remain local bitmap payloads, matching the raster capture resource policy.
      const source = layer.match(/^url\(\s*(["']?)(.*?)\1\s*\)$/i)?.[2];
      if (!source || !INLINE_BITMAP.test(source)) {
        throw new RenderPDFError(
          'UNSUPPORTED_CSS',
          'Unsupported CSS: automatic raster backgrounds require gradients or inline bitmap URLs.',
        );
      }
    }
    reasons.push('background-image');
  }
  if (style.borderRadius !== '0px') reasons.push('border-radius');
  if (style.boxShadow !== 'none') {
    if (cssLayers(style.boxShadow).some((shadow) => !/\binset\b/.test(shadow))) {
      throw new RenderPDFError(
        'UNSUPPORTED_CSS',
        'Unsupported CSS: outer shadows require expanded capture bounds; only inset shadows can fall back automatically.',
      );
    }
    reasons.push('inset box-shadow');
  }
  if (style.opacity !== '1') reasons.push('opacity');
  return reasons.length ? reasons.join(', ') : undefined;
}

/** Require a single formatting box that can be cloned into an independent rectangular viewport.
 * @param element Candidate selected for its own local visual effects.
 * @param style Browser-computed display mode for the candidate.
 */
export function assertAutomaticRasterBoundary(
  element: HTMLElement,
  style: CSSStyleDeclaration,
): void {
  // Inline fragments and table internals depend on formatting context outside their own box.
  if (
    !isHtmlTag(element, 'img') &&
    !['block', 'flow-root', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid'].includes(
      style.display,
    )
  ) {
    throw new RenderPDFError(
      'UNSUPPORTED_CSS',
      'Automatic raster fallback requires a rectangular block, flex, grid, inline-block, or image boundary; wrap inline or table-internal effects in a supported block.',
    );
  }
  // A union rectangle cannot preserve the separate origins and gaps of fragmented browser boxes.
  const rectangles = Array.from(element.getClientRects()).filter(
    (rectangle) => rectangle.width > 0 && rectangle.height > 0,
  );
  if (rectangles.length !== 1) {
    throw new RenderPDFError(
      'UNSUPPORTED_CSS',
      'Automatic raster fallback cannot capture fragmented inline or multi-column regions.',
    );
  }
}
