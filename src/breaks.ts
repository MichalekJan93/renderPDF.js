import { RenderPDFError } from './diagnostics.js';
import type { Bounds, LayoutSnapshot } from './types.js';

/** Displays whose vertical border-box boundaries can be mapped without inventing line fragments. */
const FRAGMENTABLE_DISPLAYS = new Set([
  'block',
  'flow-root',
  'flex',
  'grid',
  'table',
  'table-caption',
  'table-row',
  'table-row-group',
  'table-header-group',
  'table-footer-group',
]);

/** Read one modern break property, with the browser's legacy page-break alias as a fallback. */
function breakValue(
  /** Browser-resolved source declarations. */
  style: CSSStyleDeclaration,
  /** Before/after/inside suffix shared by both CSS property spellings. */
  edge: 'before' | 'after' | 'inside',
): string {
  // Most browsers canonicalize aliases; reading both also covers legacy source markup.
  const modern = style.getPropertyValue(`break-${edge}`).trim();
  // Empty legacy values occur when a modern property has no page-break equivalent.
  const legacy = style.getPropertyValue(`page-break-${edge}`).trim();
  return modern && modern !== 'auto' ? modern : legacy || modern || 'auto';
}

/** Reject parity, column and other fragmentation modes that need a different page model. */
function assertBreakValue(
  /** Browser-resolved break keyword. */
  value: string,
  /** Property suffix used to distinguish inside restrictions from boundary restrictions. */
  edge: 'before' | 'after' | 'inside',
): void {
  if (
    value === 'auto' ||
    value === 'avoid' ||
    value === 'avoid-page' ||
    (edge !== 'inside' && (value === 'page' || value === 'always'))
  ) {
    return;
  }
  throw new RenderPDFError(
    'UNSUPPORTED_CSS',
    `Unsupported CSS break-${edge}: ${value}; only page/always boundaries and avoid/avoid-page preferences are supported.`,
  );
}

/** Measure one border box in the same source CSS-pixel system used by the display list. */
function sourceBounds(
  /** Source element whose page boundaries are being considered. */
  element: HTMLElement,
  /** Original source root's viewport-relative border box. */
  origin: DOMRect,
): Bounds {
  // Geometry is taken from layout instead of reconstructing margins, Flexbox or Grid flow.
  const rectangle = element.getBoundingClientRect();
  return {
    x: rectangle.left - origin.left,
    y: rectangle.top - origin.top,
    width: rectangle.width,
    height: rectangle.height,
  };
}

/** Identify visible, positive-size block-like elements whose boundary rules can apply. */
function hasFragmentableBox(
  /** Candidate sibling considered for an avoid-before/after preference. */
  element: HTMLElement,
): boolean {
  // Hidden siblings do not supply page content or break boundaries.
  const style = getComputedStyle(element);
  // Zero-size elements can request forced boundaries separately, but cannot form a keep-together pair.
  const bounds = element.getBoundingClientRect();
  return (
    style.visibility === 'visible' &&
    FRAGMENTABLE_DISPLAYS.has(style.display) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

/** Find the nearest visible block sibling without treating inline fragments as whole blocks. */
function blockSibling(
  /** Block whose previous/next boundary requests avoidance. */
  element: HTMLElement,
  /** Which adjacent content boundary should stay together. */
  direction: 'previous' | 'next',
): HTMLElement | undefined {
  // Display-none and visibility-hidden siblings do not interrupt the visible adjacent pair.
  let sibling =
    direction === 'previous' ? element.previousElementSibling : element.nextElementSibling;
  while (sibling) {
    if (!(sibling instanceof HTMLElement)) return undefined;
    // A visible inline sibling has no single block boundary for this collector to join.
    const style = getComputedStyle(sibling);
    if (style.display !== 'none' && style.visibility === 'visible') {
      return hasFragmentableBox(sibling) ? sibling : undefined;
    }
    sibling =
      direction === 'previous' ? sibling.previousElementSibling : sibling.nextElementSibling;
  }
  return undefined;
}

/** Join adjacent block boxes into a soft preference, retaining all geometry between them. */
function joinedBounds(
  /** Current block or row's measured source rectangle. */
  current: Bounds,
  /** Adjacent visible block or row's measured source rectangle. */
  adjacent: Bounds,
): Bounds {
  // The enclosing rectangle is a preference only; intrinsically atomic items remain separate.
  const x = Math.min(current.x, adjacent.x);
  // Source DOM and browser paint order need not imply vertical order in Flexbox or Grid.
  const y = Math.min(current.y, adjacent.y);
  return {
    x,
    y,
    width: Math.max(current.x + current.width, adjacent.x + adjacent.width) - x,
    height: Math.max(current.y + current.height, adjacent.y + adjacent.height) - y,
  };
}

/** Collect the supported CSS page-break subset from existing measured browser geometry. */
export function collectPageBreaks(
  /** Connected current-document root; collection leaves its source DOM unchanged. */
  root: HTMLElement,
  /** Ordered display list identifying intrinsic raster boundaries and source extent. */
  snapshot: LayoutSnapshot,
): Pick<LayoutSnapshot, 'forcedBreaks' | 'avoidBreakBounds'> {
  if (!root.isConnected || root.ownerDocument !== document) {
    throw new RenderPDFError(
      'INVALID_SOURCE',
      'CSS page-break collection requires a connected source in the current document.',
    );
  }
  // Every boundary is expressed relative to the same source border box as text and images.
  const origin = root.getBoundingClientRect();
  // Raster descendants already paint as one atomic bitmap and cannot contain a physical page cut.
  const rasters = snapshot.operations.filter(
    /** Explicit and automatically planned regions use the same ordered raster operation contract. */
    (operation) => operation.kind === 'raster',
  );
  // Duplicate ancestor/sibling declarations are harmless, but avoid storing the same interval twice.
  const preferences = new Map<string, Bounds>();
  // Page-edge duplicates and ordering are normalized by the pure pagination stage.
  const forcedBreaks: number[] = [];
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (!(element instanceof HTMLElement)) continue;
    // Visibility and display are resolved by the browser, including hidden ancestor effects on size.
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility !== 'visible') continue;
    // An element hidden by an ancestor has no layout rectangle even if its own display is block.
    const rectangle = element.getBoundingClientRect();
    if (rectangle.width === 0 && rectangle.height === 0 && element.getClientRects().length === 0)
      continue;
    // Validate all three properties before deciding whether a whole raster makes soft rules redundant.
    const before = breakValue(style, 'before');
    // After rules use the border-box bottom, without guessing proprietary page headers or footers.
    const after = breakValue(style, 'after');
    // Inside avoidance is a preference rather than a promise to split oversized native content.
    const inside = breakValue(style, 'inside');
    assertBreakValue(before, 'before');
    assertBreakValue(after, 'after');
    assertBreakValue(inside, 'inside');
    // Rasterized text never fragments internally, so its line-count preferences are redundant.
    const containingRaster = rasters.find(
      /** The selected raster root may request boundaries immediately outside its own box. */
      (operation) => operation.element.contains(element),
    );
    if (
      !containingRaster &&
      FRAGMENTABLE_DISPLAYS.has(style.display) &&
      ((style.widows && style.widows !== '2') || (style.orphans && style.orphans !== '2'))
    ) {
      throw new RenderPDFError(
        'UNSUPPORTED_CSS',
        'Nondefault CSS widows/orphans are unsupported; this renderer preserves measured text lines without a line-count pagination policy.',
      );
    }
    if (before === 'auto' && after === 'auto' && inside === 'auto') continue;
    // Both modern page and legacy always request an unconditional next physical page.
    const forcedBefore = before === 'page' || before === 'always';
    // A forced rule after the root is normalized away rather than generating an empty final page.
    const forcedAfter = after === 'page' || after === 'always';
    // Descendant rules cannot fragment a region already selected for one raster operation.
    if (containingRaster && containingRaster.element !== element) {
      if (forcedBefore || forcedAfter) {
        throw new RenderPDFError(
          'PAGINATION_FAILED',
          'A forced CSS page break lies inside an atomic raster region; move the break outside that region.',
        );
      }
      continue;
    }
    // No single line-fragment boundary can be inferred from an inline span's overall rectangle.
    if (!FRAGMENTABLE_DISPLAYS.has(style.display)) {
      throw new RenderPDFError(
        'UNSUPPORTED_CSS',
        'Explicit CSS page breaks require a block, table group or table row; inline fragments and table cells are unsupported.',
      );
    }
    // Shared measured coordinates keep CSS boundaries aligned with PDF extraction ownership.
    const bounds = sourceBounds(element, origin);
    if (forcedBefore) forcedBreaks.push(bounds.y);
    if (forcedAfter) forcedBreaks.push(bounds.y + bounds.height);
    if (inside !== 'auto' && !containingRaster) {
      preferences.set(`${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`, bounds);
    }
    for (const direction of ['previous', 'next'] as const) {
      // Boundary avoidance joins adjacent block siblings rather than pretending margins are page offsets.
      const value = direction === 'previous' ? before : after;
      if (value !== 'avoid' && value !== 'avoid-page') continue;
      // A missing adjacent block means there is no inter-block boundary to preserve.
      const adjacent = blockSibling(element, direction);
      if (!adjacent) continue;
      // Preferred unions can later relax if their total measured height exceeds one page.
      const preference = joinedBounds(bounds, sourceBounds(adjacent, origin));
      preferences.set(
        `${preference.x}:${preference.y}:${preference.width}:${preference.height}`,
        preference,
      );
    }
  }
  return { forcedBreaks, avoidBreakBounds: [...preferences.values()] };
}
