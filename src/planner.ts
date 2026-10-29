import { RenderPDFError } from './diagnostics.js';
import { isHtmlTag } from './dom.js';
import type { CornerRadius, RoundedCorners } from './types.js';

// Self-contained raster backgrounds cannot depend on SVG resources or export-time requests.
const INLINE_BITMAP = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/=\s]+$/i;

/** Resolve one computed length against the browser-measured border-box axis. */
function radiusLength(
  /** Computed pixel or percentage component. */
  value: string,
  /** Horizontal width or vertical height in CSS pixels. */
  axis: number,
): number | undefined {
  // Complex calc() expressions stay with the browser's existing local fallback.
  const match = value.match(/^(\d+(?:\.\d+)?|\.\d+)(px|%)$/);
  if (!match) return undefined;
  // Browser-computed percentages use the corresponding border-box axis.
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? (match[2] === '%' ? (amount * axis) / 100 : amount) : undefined;
}

/** Resolve one CSS corner's horizontal and vertical components in CSS pixels. */
function cornerRadius(
  /** Computed corner radius, with an optional second elliptical component. */
  value: string,
  /** Browser-measured border-box width in CSS pixels. */
  width: number,
  /** Browser-measured border-box height in CSS pixels. */
  height: number,
): CornerRadius | undefined {
  // The second component belongs to the vertical axis; omitted values repeat the first.
  const parts = value.trim().split(/\s+/);
  if (parts.length < 1 || parts.length > 2) return undefined;
  // Both components must resolve before a native path can replace browser pixels.
  const x = radiusLength(parts[0]!, width);
  const y = radiusLength(parts[1] ?? parts[0]!, height);
  return x === undefined || y === undefined ? undefined : { x, y };
}

/** Select only single solid rounded boxes whose shape can be painted without clipping descendants.
 * @param element Browser-owned source box; images still need clipped bitmap content.
 * @param style Browser-computed values used by both vector validation and raster planning.
 */
export function nativeRoundedCorners(
  element: HTMLElement,
  style: CSSStyleDeclaration,
): RoundedCorners | undefined {
  if (
    style.borderRadius === '0px' ||
    isHtmlTag(element, 'img') ||
    !['block', 'flow-root', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid'].includes(
      style.display,
    ) ||
    style.backgroundImage !== 'none' ||
    style.backgroundClip !== 'border-box' ||
    style.boxShadow !== 'none' ||
    style.opacity !== '1' ||
    style.overflowX !== 'visible' ||
    style.overflowY !== 'visible' ||
    style.clipPath !== 'none' ||
    style.maskImage !== 'none'
  )
    return undefined;

  // Fragmented inline decorations cannot be represented by one rounded PDF path.
  const rectangles = Array.from(element.getClientRects()).filter(
    (rectangle) => rectangle.width > 0 && rectangle.height > 0,
  );
  if (rectangles.length !== 1) return undefined;
  // One physical border box supplies both percentage axes and overlap limits.
  const { width, height } = rectangles[0]!;
  if (![width, height].every(Number.isFinite)) return undefined;

  // Keep the existing native border contract: one uniform solid stroke or none.
  const sides = ['Top', 'Right', 'Bottom', 'Left'] as const;
  const widths = sides.map((side) => style[`border${side}Width`]);
  const borderWidth = Number.parseFloat(widths[0]!);
  if (
    !Number.isFinite(borderWidth) ||
    borderWidth < 0 ||
    borderWidth * 2 > Math.min(width, height) ||
    widths.some((sideWidth) => sideWidth !== widths[0]) ||
    (borderWidth > 0 &&
      (sides.some((side) => style[`border${side}Style`] !== 'solid') ||
        sides.some((side) => style[`border${side}Color`] !== style.borderTopColor)))
  )
    return undefined;

  // CSS scales all corners by one factor when opposite radii exceed a box edge.
  const topLeft = cornerRadius(style.borderTopLeftRadius, width, height);
  const topRight = cornerRadius(style.borderTopRightRadius, width, height);
  const bottomRight = cornerRadius(style.borderBottomRightRadius, width, height);
  const bottomLeft = cornerRadius(style.borderBottomLeftRadius, width, height);
  if (!topLeft || !topRight || !bottomRight || !bottomLeft) return undefined;
  // Empty edge sums impose no scaling; every other pair shares the smallest factor.
  const edgeScale = (axis: number, sum: number) => (sum > 0 ? axis / sum : 1);
  const scale = Math.min(
    1,
    edgeScale(width, topLeft.x + topRight.x),
    edgeScale(width, bottomLeft.x + bottomRight.x),
    edgeScale(height, topLeft.y + bottomLeft.y),
    edgeScale(height, topRight.y + bottomRight.y),
  );
  return {
    topLeft: { x: topLeft.x * scale, y: topLeft.y * scale },
    topRight: { x: topRight.x * scale, y: topRight.y * scale },
    bottomRight: { x: bottomRight.x * scale, y: bottomRight.y * scale },
    bottomLeft: { x: bottomLeft.x * scale, y: bottomLeft.y * scale },
  };
}

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
export function automaticRasterReason(
  style: CSSStyleDeclaration,
  /** Reject effects that cannot fit inside a local raster boundary. */
  strictCss = false,
  /** A checked solid rounded box can keep its native vector paint. */
  nativeRounded = false,
): string | undefined {
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
  if (style.borderRadius !== '0px' && !nativeRounded) reasons.push('border-radius');
  if (style.boxShadow !== 'none') {
    const shadows = cssLayers(style.boxShadow);
    if (strictCss && shadows.some((shadow) => !/\binset\b/.test(shadow))) {
      throw new RenderPDFError(
        'UNSUPPORTED_CSS',
        'Unsupported CSS: outer shadows require expanded capture bounds; only inset shadows can fall back automatically.',
      );
    }
    if (shadows.some((shadow) => /\binset\b/.test(shadow))) reasons.push('inset box-shadow');
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
