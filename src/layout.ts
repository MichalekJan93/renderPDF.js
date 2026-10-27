import { RenderPDFError, type RenderWarning } from './diagnostics.js';
import { computedStyle, isHtmlElement, isHtmlTag, isShadowRoot } from './dom.js';
import { resolveRegisteredFont } from './fonts.js';
import { assertAutomaticRasterBoundary, automaticRasterReason } from './planner.js';
import {
  collapsedTableOwner,
  measureCollapsedTableBorders,
  validateCollapsedTablePart,
} from './table-borders.js';
import type { CollapsedTablePaint } from './table-borders.js';
import type { RegisteredFont } from './api-types.js';
import type {
  Bounds,
  BoxOperation,
  LayoutSnapshot,
  PaintOperation,
  TableHeader,
  TextOperation,
} from './types.js';

/** Grapheme boundaries keep Unicode clusters intact across browser line measurements. */
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Strong RTL letters need their own shaping run when adjacent to LTR text or digits. */
const rtlGrapheme = /[\p{Script=Arabic}\p{Script=Hebrew}]/u;
const strongGrapheme = /[\p{L}\p{N}]/u;

/** Reuse exact loaded-face metrics within one synchronous measurement only. */
interface TextMetricsCache {
  context: CanvasRenderingContext2D;
  fonts: Map<string, { ascent: number; descent: number }>;
}

/** Translate viewport geometry into the single root-relative CSS pixel system.
 * @param rectangle Browser-calculated viewport rectangle.
 * @param origin Source root's viewport rectangle.
 */
function relativeBounds(rectangle: DOMRect, origin: DOMRect): Bounds {
  if (![rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isFinite)) {
    throw new RenderPDFError(
      'INVALID_SOURCE',
      'Browser geometry must contain only finite CSS pixel values.',
    );
  }
  return {
    x: rectangle.left - origin.left,
    y: rectangle.top - origin.top,
    width: rectangle.width,
    height: rectangle.height,
  };
}

/** Follow source ancestors across an isolated preview's shadow boundary.
 * @param element Current source or ancestor whose visual parent must be inspected.
 */
function composedParent(element: HTMLElement): HTMLElement | null {
  // A shadow-root source still inherits clipping and transforms from its host.
  const tree = element.getRootNode();
  return (
    element.parentElement ?? (isShadowRoot(tree) && isHtmlElement(tree.host) ? tree.host : null)
  );
}

/** Reject CSS whose paint order or appearance this isolated experiment cannot reproduce.
 * @param element Source element inspected without modifying its styles.
 * @param style Browser-computed style for the element.
 * @param allowLocalRasterEffects Whether a checked automatic region owns the supported local effects.
 */
function validateVectorStyle(
  element: HTMLElement,
  style: CSSStyleDeclaration,
  allowLocalRasterEffects = false,
  collapsed = false,
): void {
  // Chromium clips replaced image content to its own box by default; fill embedding matches it.
  const replacedImage = isHtmlTag(element, 'img');
  // These properties require a stacking, clipping, or effects planner beyond this supported subset.
  const unsupported = [
    style.position !== 'static' && `position: ${style.position}`,
    style.zIndex !== 'auto' && `z-index: ${style.zIndex}`,
    style.transform !== 'none' && 'transform',
    style.filter !== 'none' && 'filter',
    style.backdropFilter !== 'none' && 'backdrop-filter',
    style.mixBlendMode !== 'normal' && 'mix-blend-mode',
    style.opacity !== '1' && !allowLocalRasterEffects && 'opacity',
    style.clipPath !== 'none' && 'clip-path',
    style.maskImage !== 'none' && 'mask-image',
    style.backgroundImage !== 'none' && !allowLocalRasterEffects && 'background-image',
    style.boxShadow !== 'none' && !allowLocalRasterEffects && 'box-shadow',
    style.borderRadius !== '0px' && !allowLocalRasterEffects && 'border-radius',
    style.overflowX !== 'visible' && !(replacedImage && style.overflowX === 'clip') && 'overflow-x',
    style.overflowY !== 'visible' && !(replacedImage && style.overflowY === 'clip') && 'overflow-y',
    style.cssFloat !== 'none' && 'float',
    style.order !== '0' && 'order',
    style.writingMode !== 'horizontal-tb' && 'writing-mode',
    style.textShadow !== 'none' && 'text-shadow',
    style.textDecorationLine !== 'none' && 'text-decoration',
    style.textTransform !== 'none' && 'text-transform',
    style.letterSpacing !== 'normal' && style.letterSpacing !== '0px' && 'letter-spacing',
    style.wordSpacing !== 'normal' && style.wordSpacing !== '0px' && 'word-spacing',
    style.whiteSpace !== 'normal' && 'white-space',
    style.columnCount !== 'auto' && style.columnCount !== '1' && 'columns',
    style.outlineStyle !== 'none' && 'outline',
    style.borderImageSource !== 'none' && 'border-image',
    style.boxDecorationBreak === 'clone' && 'box-decoration-break: clone',
    style.zoom !== '1' && 'zoom',
    ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'].some(
      (property) =>
        Number.parseFloat(
          style.getPropertyValue(
            property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
          ),
        ) < 0,
    ) && 'negative margins',
  ].filter(Boolean);
  // Generated content has geometry outside this experiment's DOM text traversal.
  for (const pseudo of ['::before', '::after']) {
    // An absent pseudo element reports either none or normal in Chromium.
    const content = computedStyle(element, pseudo).content;
    if (content !== 'none' && content !== 'normal') {
      unsupported.push(`generated content ${pseudo}`);
    }
  }
  if (unsupported.length > 0) {
    throw new RenderPDFError(
      'UNSUPPORTED_CSS',
      `Unsupported CSS on ${element.tagName}: ${unsupported.join(', ')}. Use a bounded data-raster subtree when safe.`,
    );
  }
  if (isHtmlTag(element, 'table') && !['separate', 'collapse'].includes(style.borderCollapse)) {
    throw new RenderPDFError(
      'UNSUPPORTED_CSS',
      'Native table snapshots require separate or collapsed borders.',
    );
  }
  if (
    ['THEAD', 'TBODY', 'TFOOT', 'TR', 'COL', 'COLGROUP'].includes(element.tagName) &&
    style.backgroundColor !== 'rgba(0, 0, 0, 0)'
  ) {
    throw new RenderPDFError(
      'UNSUPPORTED_CSS',
      'Native table snapshots require transparent row-group, row, and column backgrounds.',
    );
  }
  // The writer supports uniform, solid borders only, including an absent border.
  const sides = ['Top', 'Right', 'Bottom', 'Left'] as const;
  // Comparing normalized computed values prevents silently dropping asymmetric borders.
  const widths = sides.map((side) => style[`border${side}Width`]);
  // Colors are relevant only when at least one border is visible.
  const colors = sides.map((side) => style[`border${side}Color`]);
  // Border styles other than solid cannot be approximated by one rectangle.
  const styles = sides.map((side) => style[`border${side}Style`]);
  if (collapsed) validateCollapsedTablePart(element, style);
  if (
    !collapsed &&
    (widths.some((width) => width !== widths[0]) ||
      (widths[0] !== '0px' &&
        (colors.some((color) => color !== colors[0]) ||
          styles.some((borderStyle) => borderStyle !== 'solid'))))
  ) {
    throw new RenderPDFError(
      'UNSUPPORTED_CSS',
      'Unsupported CSS: only uniform solid borders are supported.',
    );
  }
  // A union rectangle would incorrectly fill gaps between wrapped inline backgrounds and borders.
  if (
    !allowLocalRasterEffects &&
    (style.backgroundColor !== 'rgba(0, 0, 0, 0)' || widths[0] !== '0px') &&
    Array.from(element.getClientRects()).filter(
      (rectangle) => rectangle.width > 0 && rectangle.height > 0,
    ).length > 1
  ) {
    throw new RenderPDFError(
      'UNSUPPORTED_CSS',
      'Fragmented inline backgrounds and borders require an explicit containing raster region.',
    );
  }
}

/** Reject formatting modes whose boxes have no supported native paint representation.
 * @param element Current source element, including browser-replaced images.
 * @param style Browser-computed formatting mode.
 */
function validateDisplay(element: HTMLElement, style: CSSStyleDeclaration): void {
  if (
    !isHtmlTag(element, 'img') &&
    ![
      'block',
      'flow-root',
      'inline',
      'inline-block',
      'flex',
      'inline-flex',
      'grid',
      'inline-grid',
      'table',
      'inline-table',
      'table-caption',
      'table-header-group',
      'table-row-group',
      'table-footer-group',
      'table-row',
      'table-cell',
      'table-column-group',
      'table-column',
    ].includes(style.display)
  ) {
    throw new RenderPDFError('UNSUPPORTED_CSS', `Unsupported CSS display: ${style.display}.`);
  }
}

/** Measure wrapped browser lines without computing an independent typography layout.
 * @param node Text node whose parent provides the effective font and color.
 * @param origin Source root's viewport rectangle.
 * @param fonts Exact registered faces available to the PDF writer.
 * @param cache Canvas font metrics already checked during this synchronous snapshot.
 * @param invisible Whether text belongs to an already rasterized subtree.
 */
function measureText(
  node: Text,
  origin: DOMRect,
  fonts: readonly RegisteredFont[],
  cache: TextMetricsCache,
  invisible: boolean,
): TextOperation[] {
  // A detached text node has no browser-resolved font or meaningful geometry.
  const parent = node.parentElement;
  if (!parent || !node.data.replace(/[\t\n\r\f ]+/g, '')) return [];
  // All runs of this text node share the parent's computed font face.
  const style = computedStyle(parent);
  // Browser and PDF face selection share CSS weight matching without accepting unknown families.
  const face = resolveRegisteredFont(style, fonts);
  if (
    style.writingMode !== 'horizontal-tb' ||
    style.textTransform !== 'none' ||
    style.whiteSpace !== 'normal' ||
    node.data.includes('\u00ad') ||
    style.hyphens === 'auto' ||
    (style.letterSpacing !== 'normal' && style.letterSpacing !== '0px') ||
    (style.wordSpacing !== 'normal' && style.wordSpacing !== '0px') ||
    style.fontVariantCaps !== 'normal' ||
    style.fontVariantAlternates !== 'normal' ||
    style.fontVariantLigatures !== 'normal' ||
    style.fontVariantNumeric !== 'normal' ||
    style.fontVariantEastAsian !== 'normal' ||
    style.fontVariantPosition !== 'normal' ||
    style.fontFeatureSettings !== 'normal' ||
    style.fontVariationSettings !== 'normal' ||
    (style.fontStretch !== '100%' && style.fontStretch !== 'normal') ||
    (style.fontSizeAdjust !== 'none' && style.fontSizeAdjust !== undefined) ||
    !['auto', 'geometricPrecision'].includes(style.textRendering)
  ) {
    throw new RenderPDFError(
      'UNSUPPORTED_CSS',
      'Unsupported CSS: text requires horizontal layout with normal whitespace, spacing, font variants and OpenType features, without automatic hyphenation or soft hyphens.',
    );
  }
  // FontFaceSet confirms this exact registered face has finished loading.
  const fontSize = Number.parseFloat(style.fontSize);
  // Canvas font metrics approximate a baseline that Range does not expose.
  const fontDescription = `${face.style} ${face.weight} ${fontSize}px "${face.family}"`;
  let metrics = cache.fonts.get(fontDescription);
  if (!metrics) {
    // FontFaceSet.check alone also succeeds for unknown families resolved through fallback.
    const loadedFace = Array.from(node.ownerDocument.fonts).some((browserFace) => {
      // Normalize author-provided aliases before comparing the explicit face contract.
      const browserWeight =
        browserFace.weight === 'normal'
          ? 400
          : browserFace.weight === 'bold'
            ? 700
            : Number(browserFace.weight);
      return (
        browserFace.family.replace(/^['"]|['"]$/g, '').toLowerCase() ===
          face.family.toLowerCase() &&
        browserWeight === face.weight &&
        browserFace.style === face.style &&
        browserFace.status === 'loaded'
      );
    });
    if (!loadedFace || !node.ownerDocument.fonts.check(fontDescription, node.data))
      throw new RenderPDFError('MISSING_FONT', `Browser font is not loaded: ${fontDescription}.`);
    cache.context.font = fontDescription;
    // Font bounding metrics cover accents consistently across lines, unlike actual ink bounds.
    const measured = cache.context.measureText(node.data);
    // The browser's em-box ascent and descent are preferable to guessing from font size.
    const ascent = measured.fontBoundingBoxAscent;
    // Range height is rounded by Chromium, so center the metric box within it.
    const descent = measured.fontBoundingBoxDescent;
    if (!Number.isFinite(ascent) || !Number.isFinite(descent))
      throw new RenderPDFError(
        'UNSUPPORTED_CSS',
        'Font bounding metrics are unavailable in this browser.',
      );
    metrics = { ascent, descent };
    cache.fonts.set(fontDescription, metrics);
  }
  const { ascent, descent } = metrics;
  // Grapheme boundaries preserve surrogate pairs and combining marks in every script.
  const segments = graphemes.segment(node.data);
  // A reusable Range reads browser-produced geometry, not a synthetic line-breaking algorithm.
  const range = node.ownerDocument.createRange();
  // Line ranges are collected before their complete text and horizontal extent are measured.
  const lines: { start: number; end: number; top: number }[] = [];
  // Each grapheme's visible rectangle identifies the line selected by browser layout.
  for (const segment of segments) {
    range.setStart(node, segment.index);
    range.setEnd(node, segment.index + segment.segment.length);
    // Collapsed whitespace produces empty rectangles and should not create phantom runs.
    const rectangles = Array.from(range.getClientRects());
    const rectangle = rectangles.find((item) => item.width > 0 && item.height > 0);
    if (!rectangle) {
      // Chromium can assign a ligature's entire width to an earlier text node.
      if (
        /[^\t\n\r\f ]/.test(segment.segment) &&
        rectangles.some((item) => item.height > 0 && item.width === 0)
      ) {
        throw new RenderPDFError(
          'UNSUPPORTED_CSS',
          'Text shaping crosses an inline boundary or uses an unsupported zero-width glyph. Keep each shaped word in one text node.',
        );
      }
      continue;
    }
    // Adjacent visible glyphs with matching tops belong to one browser line.
    const previous = lines.at(-1);
    if (previous && Math.abs(previous.top - rectangle.top) < 0.5) {
      previous.end = segment.index + segment.segment.length;
    } else {
      lines.push({
        start: segment.index,
        end: segment.index + segment.segment.length,
        top: rectangle.top,
      });
    }
  }
  return lines.flatMap((line) => {
    // CSS-collapsible edge spaces have no glyph origin in PDF.js; retain only interior spaces.
    let start = line.start;
    // End offsets remain exclusive and are adjusted independently of non-breaking spaces.
    let end = line.end;
    while (start < end && /[\t\n\r\f ]/.test(node.data[start]!)) start += 1;
    while (end > start && /[\t\n\r\f ]/.test(node.data[end - 1]!)) end -= 1;
    if (start === end) return [];
    range.setStart(node, start);
    range.setEnd(node, end);
    // Source offsets remain available for independent per-run Range measurements.
    const sourceLine = node.data.slice(start, end);
    // Collapse only CSS normal-whitespace characters; preserve non-breaking spaces.
    const text = sourceLine.replace(/[\t\n\r\f ]+/g, ' ');
    // Whole-line bounds remain the atomic pagination interval and verification metadata.
    const bounds = relativeBounds(range.getBoundingClientRect(), origin);
    // Measured run origins prevent endpoint fitting from accumulating drift across a line.
    const runs = Array.from(sourceLine.matchAll(/[^\t\n\r\f ]+/g)).flatMap((match) => {
      const pieces: { text: string; offset: number }[] = [];
      let begin = 0;
      let direction: 'ltr' | 'rtl' | undefined;
      for (const segment of graphemes.segment(match[0])) {
        const next = rtlGrapheme.test(segment.segment)
          ? 'rtl'
          : strongGrapheme.test(segment.segment)
            ? 'ltr'
            : undefined;
        if (direction && next && next !== direction) {
          pieces.push({
            text: match[0].slice(begin, segment.index),
            offset: start + match.index + begin,
          });
          begin = segment.index;
        }
        if (next) direction = next;
      }
      pieces.push({ text: match[0].slice(begin), offset: start + match.index + begin });
      return pieces.map((piece) => {
        range.setStart(node, piece.offset);
        range.setEnd(node, piece.offset + piece.text.length);
        // The browser already resolved bidi placement for each shaped fragment.
        const runBounds = relativeBounds(range.getBoundingClientRect(), origin);
        return { text: piece.text, x: runBounds.x, width: runBounds.width };
      });
    });
    return [
      {
        kind: 'text' as const,
        bounds,
        text,
        runs,
        baseline: bounds.y + (bounds.height - ascent - descent) / 2 + ascent,
        fontSize,
        family: face.family,
        weight: face.weight,
        style: face.style,
        kerning: style.fontKerning !== 'none',
        color: style.color,
        invisible,
      },
    ];
  });
}

/** Validate source ownership, font descriptors, and ancestor effects before browser measurement.
 * @param root Connected HTMLElement whose browser layout belongs to this document.
 * @param fonts Explicit faces available to text measurement and PDF embedding.
 * @param fallback Captured raster policy that must remain stable throughout preparation.
 */
function validateLayoutSource(
  root: HTMLElement,
  fonts: readonly RegisteredFont[],
  fallback: 'auto' | 'strict',
  repeatTableHeaders = false,
): void {
  if (fallback !== 'auto' && fallback !== 'strict') {
    throw new RenderPDFError('INVALID_OPTIONS', 'Raster fallback must be auto or strict.');
  }
  if (typeof repeatTableHeaders !== 'boolean') {
    throw new RenderPDFError('INVALID_OPTIONS', 'Table header repetition must be a boolean.');
  }
  if (
    !root ||
    !isHtmlElement(root) ||
    !root.ownerDocument.defaultView ||
    !root.isConnected ||
    fonts.length === 0
  )
    throw new RenderPDFError(
      'INVALID_SOURCE',
      'A connected source root and registered fonts are required.',
    );
  // Duplicate descriptors could select different browser/PDF programs nondeterministically.
  const faceDescriptors = new Set(
    fonts.map((font) => `${font.family.toLowerCase()}:${font.weight}:${font.style}`),
  );
  if (faceDescriptors.size !== fonts.length) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'Registered fonts require unique family/weight/style descriptors.',
    );
  }
  // Ancestor effects can alter pixels without changing local descendant computed styles.
  for (let ancestor = composedParent(root); ancestor; ancestor = composedParent(ancestor)) {
    // Exporting a clipped/transformed application viewport requires a richer scene model.
    const ancestorStyle = computedStyle(ancestor);
    if (
      ancestorStyle.transform !== 'none' ||
      ancestorStyle.filter !== 'none' ||
      ancestorStyle.opacity !== '1' ||
      ancestorStyle.clipPath !== 'none' ||
      ancestorStyle.maskImage !== 'none' ||
      ancestorStyle.mixBlendMode !== 'normal' ||
      ancestorStyle.zoom !== '1' ||
      ancestorStyle.overflowX !== 'visible' ||
      ancestorStyle.overflowY !== 'visible'
    ) {
      throw new RenderPDFError(
        'UNSUPPORTED_CSS',
        'Unsupported CSS: source ancestors must not transform, clip, blend, or fade the source.',
      );
    }
  }
}

/** Collect replayable native headers while keeping the browser's original column geometry.
 * @param root Entire connected source whose measured operations retain DOM paint order.
 * @param origin Source rectangle shared by all original paint coordinates.
 * @param operations Complete original display list; repeated lists keep these exact references.
 * @param headerPaint Descendant operations recorded during each visible THEAD traversal.
 * @param elementBoxes Native ancestor backgrounds needed underneath transparent header cells.
 */
function measureTableHeaders(
  root: HTMLElement,
  origin: DOMRect,
  operations: PaintOperation[],
  headerPaint: Map<HTMLTableSectionElement, PaintOperation[]>,
  elementBoxes: Map<HTMLElement, BoxOperation>,
  collapsedTables: Map<HTMLTableElement, CollapsedTablePaint>,
): TableHeader[] {
  // Root tables participate just like tables nested in an ordinary document wrapper.
  const tables = Array.from(root.querySelectorAll('table'));
  if (isHtmlTag(root, 'table')) tables.unshift(root);
  // One page reserves one full-width header band; concurrent tables cannot share that contract.
  const headers: TableHeader[] = [];
  for (const table of tables) {
    // Tables without a visible original header or body do not need a continuation header.
    const head = table.tHead;
    if (!head || computedStyle(head).display === 'none') continue;
    const collapsed = collapsedTables.get(table);
    const bounds = collapsed?.headerBounds ?? relativeBounds(head.getBoundingClientRect(), origin);
    if (bounds.width <= 0 || bounds.height <= 0) continue;
    const bodyRows = Array.from(table.tBodies).flatMap((body) =>
      Array.from(body.rows).filter((row) => row.getBoundingClientRect().height > 0),
    );
    if (bodyRows.length === 0) continue;
    if (collapsed && !collapsed.repeatSafe) {
      throw new RenderPDFError(
        'UNSUPPORTED_CSS',
        'Repeated collapsed headers require matching horizontal border winners at the header/body boundary and all body row boundaries.',
      );
    }
    if (
      table.parentElement?.closest('table') ||
      table.querySelector('table') ||
      Array.from(table.children).filter((child) => child.tagName === 'THEAD').length !== 1 ||
      computedStyle(table).display !== 'table' ||
      computedStyle(head).display !== 'table-header-group'
    ) {
      throw new RenderPDFError(
        'UNSUPPORTED_ELEMENT',
        'Repeated headers require a standalone native table with one THEAD and no nested tables.',
      );
    }
    // Header rowspans and raster captures do not have an independently replayable native band.
    if (
      Array.from(head.rows).some((row) =>
        Array.from(row.cells).some((cell) => cell.rowSpan !== 1),
      ) ||
      operations.some(
        (operation) =>
          operation.kind === 'raster' &&
          (operation.element.contains(head) || head.contains(operation.element)),
      )
    ) {
      throw new RenderPDFError(
        'UNSUPPORTED_ELEMENT',
        'Repeated table headers do not support header rowspans or rasterized headers and ancestors.',
      );
    }
    // Include the browser's inter-group border spacing in every repeated header's reserved height.
    const bodyStart = relativeBounds(bodyRows[0]!.getBoundingClientRect(), origin).y;
    const lastRow = relativeBounds(bodyRows.at(-1)!.getBoundingClientRect(), origin);
    const bodyEnd = lastRow.y + lastRow.height;
    const painted = headerPaint.get(head);
    if (
      !painted ||
      bodyStart < bounds.y + bounds.height - 0.1 ||
      bodyEnd <= bodyStart ||
      painted.some(
        (operation) =>
          operation.kind !== 'border' &&
          (operation.bounds.y < bounds.y - 0.1 ||
            // Continuations may reuse the source row gap, so every repeated glyph must fit THEAD itself.
            operation.bounds.y + operation.bounds.height > bounds.y + bounds.height + 0.1 ||
            operation.bounds.x < bounds.x - 0.1 ||
            operation.bounds.x + operation.bounds.width > bounds.x + bounds.width + 0.1),
      ) ||
      bodyRows.some((row) =>
        Array.from(row.cells).some((cell) => {
          // Existing body-only rowspans stay atomic; crossing a repeated section edge is unsafe.
          const cellBounds = relativeBounds(cell.getBoundingClientRect(), origin);
          return cellBounds.y < bodyStart - 0.1 || cellBounds.y + cellBounds.height > bodyEnd + 0.1;
        }),
      )
    ) {
      throw new RenderPDFError(
        'UNSUPPORTED_CSS',
        'Repeated table headers require a separate, ordered header band without overflowing paint or cells spanning header/body boundaries.',
      );
    }
    if (
      headers.some(
        (header) => Math.min(header.bodyEnd, bodyEnd) - Math.max(header.bounds.y, bounds.y) > 0.01,
      )
    ) {
      throw new RenderPDFError(
        'UNSUPPORTED_CSS',
        'Repeated headers do not support tables whose vertical continuation intervals overlap.',
      );
    }
    // Replay ancestor boxes in their original order, clipped by the writer to this header band.
    const included = new Set<PaintOperation>(painted);
    for (let ancestor = head.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const box = elementBoxes.get(ancestor);
      if (box) included.add(box);
      if (ancestor === root) break;
    }
    headers.push({
      bounds,
      bodyStart,
      bodyEnd,
      operations: operations.filter((operation) => included.has(operation)),
    });
  }
  return headers;
}

/** Prepare browser resources, then snapshot the supported static DOM subset without changing it.
 * @param root Connected, visible HTMLElement whose existing browser layout is exported.
 * @param fonts Explicit faces used both by the browser and PDF embedding.
 * @param options Whether safe local effects may choose raster boundaries automatically.
 */
export async function snapshotLayout(
  root: HTMLElement,
  fonts: readonly RegisteredFont[],
  options: {
    /** Strict mode keeps native errors unless a boundary has explicit data-raster markup. */
    fallback?: 'auto' | 'strict';
    /** Reserve and replay a native THEAD on each body continuation page. */
    repeatTableHeaders?: boolean;
  } = {},
): Promise<LayoutSnapshot> {
  // Capture the caller's policy before yielding, and reject invalid input before waiting on resources.
  const fallback = options.fallback ?? 'auto';
  const repeatTableHeaders = options.repeatTableHeaders ?? false;
  validateLayoutSource(root, fonts, fallback, repeatTableHeaders);
  await root.ownerDocument.fonts.ready;
  // Image decoding completes before any geometry is measured.
  const images = Array.from(root.querySelectorAll('img'));
  if (isHtmlTag(root, 'img')) images.unshift(root);
  await Promise.all(
    images.map(async (image) => {
      try {
        await image.decode();
      } catch (cause) {
        throw new RenderPDFError('RESOURCE_LOAD_FAILED', 'Source image could not be decoded.', {
          cause,
        });
      }
    }),
  );
  return measurePreparedLayout(root, fonts, { fallback, repeatTableHeaders });
}

/** Measure settled browser resources synchronously so a source guard can share the same task.
 * @param root Connected, visible HTMLElement with its fonts and source images already prepared.
 * @param fonts Exact registered faces used both by the browser and PDF embedding.
 * @param options Whether safe local effects may choose raster boundaries automatically.
 */
export function measurePreparedLayout(
  root: HTMLElement,
  fonts: readonly RegisteredFont[],
  options: {
    /** Strict mode keeps native errors unless a boundary has explicit data-raster markup. */
    fallback?: 'auto' | 'strict';
    /** Reserve and replay a native THEAD on each body continuation page. */
    repeatTableHeaders?: boolean;
  } = {},
): LayoutSnapshot {
  // Capture the policy once; this path deliberately performs no asynchronous resource preparation.
  const fallback = options.fallback ?? 'auto';
  const repeatTableHeaders = options.repeatTableHeaders ?? false;
  validateLayoutSource(root, fonts, fallback, repeatTableHeaders);
  // One origin is shared by vector text, image bounds, and raster regions.
  const origin = root.getBoundingClientRect();
  if (origin.width <= 0 || origin.height <= 0)
    throw new RenderPDFError(
      'INVALID_SOURCE',
      'The source root must have positive visible dimensions.',
    );
  // Canvas is never appended, so measurement leaves the application DOM unchanged.
  const contextCandidate = root.ownerDocument.createElement('canvas').getContext('2d');
  if (!contextCandidate)
    throw new RenderPDFError('INVALID_SOURCE', 'Canvas font measurement is unavailable.');
  // Capture the checked context as a non-null value for the recursive visitor.
  const cache: TextMetricsCache = { context: contextCandidate, fonts: new Map() };
  // The list's order is the paint order for this deliberately restricted static subset.
  const operations: PaintOperation[] = [];
  // Record native ownership only when the caller explicitly requests repeated table headers.
  const headerPaint = new Map<HTMLTableSectionElement, PaintOperation[]>();
  const elementBoxes = new Map<HTMLElement, BoxOperation>();
  // A collapsed grid paints one resolved border layer after every cell's background and text.
  const collapsedTables = new Map<HTMLTableElement, CollapsedTablePaint>();
  // Browser rows and rowspan cells are indivisible intervals for the existing page mapper.
  const atomicBounds: Bounds[] = [];
  // Outer collapsed half-strokes extend only their first and last row's atomic interval.
  const tableRows = new Map<HTMLTableRowElement, Bounds>();
  // Approximate baseline and shaping behavior must remain visible to experiment users.
  const warnings: RenderWarning[] = [
    {
      code: 'TEXT_METRICS_APPROXIMATED',
      message:
        'Baselines are estimated from Canvas font metrics; browser and PDF shaping engines may still differ for some scripts or font features.',
    },
  ];

  /** Walk a subtree once; raster descendants contribute only invisible extraction text.
   * @param element Current HTML element in static DOM paint order.
   * @param insideRaster Whether an ancestor already emitted the visible raster image.
   * @param insideAutomatic Whether automatic capture must retain the stricter native safety guards.
   */
  function visit(element: HTMLElement, insideRaster: boolean, insideAutomatic = false): void {
    // A header's own box and descendants form one contiguous section of the original paint list.
    const operationStart = operations.length;
    // Display-none descendants have no paint or extraction contribution.
    const style = computedStyle(element);
    if (style.display === 'none') return;
    const collapsed = collapsedTableOwner(element, style);
    if (style.visibility !== 'visible') {
      if (!insideRaster || insideAutomatic)
        throw new RenderPDFError(
          'UNSUPPORTED_CSS',
          'Unsupported CSS: visibility overrides are not supported.',
        );
      warnings.push({
        code: 'RASTER_TEXT_OMITTED',
        message: `Raster text extraction omitted for visibility-controlled subtree ${element.tagName}.`,
      });
      return;
    }
    if (
      (!insideRaster || insideAutomatic) &&
      ![
        'MAIN',
        'BODY',
        'SECTION',
        'ARTICLE',
        'DIV',
        'SPAN',
        'P',
        'H1',
        'H2',
        'H3',
        'H4',
        'H5',
        'H6',
        'STRONG',
        'EM',
        'B',
        'I',
        'IMG',
        'FONT',
        'CENTER',
        'BR',
        'HR',
        'TABLE',
        'THEAD',
        'TBODY',
        'TFOOT',
        'TR',
        'TH',
        'TD',
        'CAPTION',
        'COLGROUP',
        'COL',
      ].includes(element.tagName)
    ) {
      throw new RenderPDFError(
        'UNSUPPORTED_ELEMENT',
        `Native snapshots do not support ${element.tagName}.`,
      );
    }
    // Explicit boundaries preserve the application's existing opt-in capture policy in either mode.
    const explicitRaster = !insideRaster && element.hasAttribute('data-raster');
    // Only the current element's effects can select its subtree; ordinary parents remain native.
    const automaticReason =
      !insideRaster && !explicitRaster && fallback === 'auto'
        ? automaticRasterReason(style)
        : undefined;
    // Every descendant of an automatic region must retain native positioning and paint-order safety.
    const automatic = insideAutomatic || automaticReason !== undefined;
    if (automatic) {
      if (insideAutomatic) automaticRasterReason(style);
      validateVectorStyle(element, style, true, collapsed !== undefined);
      validateDisplay(element, style);
    }
    if (
      insideRaster &&
      (style.transform !== 'none' ||
        style.writingMode !== 'horizontal-tb' ||
        style.opacity === '0' ||
        style.clipPath !== 'none' ||
        style.maskImage !== 'none' ||
        style.overflowX !== 'visible' ||
        style.overflowY !== 'visible')
    ) {
      warnings.push({
        code: 'RASTER_TEXT_OMITTED',
        message: `Raster text extraction omitted for transformed, clipped, hidden, or masked subtree ${element.tagName}.`,
      });
      return;
    }
    // Root-relative geometry is measured from the original browser layout.
    const bounds = relativeBounds(element.getBoundingClientRect(), origin);
    if (
      !insideRaster &&
      (bounds.x < -0.1 ||
        bounds.y < -0.1 ||
        bounds.x + bounds.width > origin.width + 0.1 ||
        bounds.y + bounds.height > origin.height + 0.1)
    ) {
      throw new RenderPDFError(
        'SOURCE_OVERFLOW',
        'Source content must fit within the root border box.',
      );
    }
    // One chosen boundary owns all visible descendants exactly once, regardless of nested markers.
    const raster = explicitRaster || automaticReason !== undefined;
    if (raster && collapsed && !isHtmlTag(element, 'table')) {
      throw new RenderPDFError(
        'UNSUPPORTED_CSS',
        'Collapsed table cells and internal groups cannot be independently rasterized.',
      );
    }
    if (raster) {
      if (
        style.position !== 'static' ||
        style.transform !== 'none' ||
        style.mixBlendMode !== 'normal'
      ) {
        throw new RenderPDFError(
          'UNSUPPORTED_CSS',
          'A raster boundary must be static, untransformed, and independently compositable.',
        );
      }
      if (automaticReason !== undefined) assertAutomaticRasterBoundary(element, style);
      operations.push({ kind: 'raster', bounds, element });
      warnings.push({
        code: 'RASTER_FALLBACK',
        message: `${automaticReason === undefined ? 'An explicit raster subtree' : `Automatic raster fallback on ${element.tagName} for ${automaticReason}`} uses invisible PDF text for extraction where supported; generated content and clipped or transformed text are not represented.`,
      });
      if (
        style.overflowX !== 'visible' ||
        style.overflowY !== 'visible' ||
        style.clipPath !== 'none' ||
        style.maskImage !== 'none' ||
        style.opacity === '0'
      ) {
        warnings.push({
          code: 'RASTER_TEXT_OMITTED',
          message: `Raster text extraction omitted for clipped, masked, or hidden boundary ${element.tagName}.`,
        });
        return;
      }
    } else if (!insideRaster) {
      validateVectorStyle(element, style, false, collapsed !== undefined);
      validateDisplay(element, style);
      if (
        isHtmlTag(element, 'tr') ||
        ((isHtmlTag(element, 'td') || isHtmlTag(element, 'th')) && element.rowSpan !== 1)
      ) {
        const atomic = { ...bounds };
        atomicBounds.push(atomic);
        if (isHtmlTag(element, 'tr')) tableRows.set(element, atomic);
      }
      if (isHtmlTag(element, 'img')) {
        if (style.objectFit !== 'fill' || style.borderTopWidth !== '0px')
          throw new RenderPDFError(
            'UNSUPPORTED_CSS',
            'Image boxes require object-fit: fill without borders.',
          );
        if (
          ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].some(
            (property) =>
              Number.parseFloat(
                style.getPropertyValue(
                  property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
                ),
              ) !== 0,
          ) ||
          style.backgroundColor !== 'rgba(0, 0, 0, 0)'
        ) {
          throw new RenderPDFError(
            'UNSUPPORTED_CSS',
            'Image boxes require zero padding and a transparent background.',
          );
        }
        operations.push({ kind: 'image', bounds, element });
      } else if (!['BR', 'COL', 'COLGROUP'].includes(element.tagName)) {
        const box: BoxOperation = {
          kind: 'box',
          bounds,
          background: style.backgroundColor,
          borderColor: style.borderTopColor,
          borderWidth: collapsed ? 0 : Number.parseFloat(style.borderTopWidth),
        };
        operations.push(box);
        if (repeatTableHeaders) elementBoxes.set(element, box);
      }
    }
    // Raster descendants retain semantic text without emitting duplicate visible boxes or images.
    const invisible = insideRaster || raster;
    if (!invisible || automatic) {
      // Overlapping sibling border boxes need CSS paint phases that DFS cannot guarantee.
      const siblingBounds = Array.from(element.children)
        .filter(
          (child): child is HTMLElement =>
            isHtmlElement(child) &&
            !(collapsed && ['COL', 'COLGROUP'].includes(child.tagName)) &&
            computedStyle(child).display !== 'none' &&
            computedStyle(child).visibility !== 'hidden',
        )
        .map((child) => child.getBoundingClientRect());
      for (let firstIndex = 0; firstIndex < siblingBounds.length; firstIndex += 1) {
        // The second box is checked only once against each earlier sibling.
        for (
          let secondIndex = firstIndex + 1;
          secondIndex < siblingBounds.length;
          secondIndex += 1
        ) {
          // Positive-area overlap is unsafe; touching edges and zero-area inline boxes are fine.
          const first = siblingBounds[firstIndex]!;
          // Each index comes from the checked array bounds above.
          const second = siblingBounds[secondIndex]!;
          if (
            Math.min(first.right, second.right) - Math.max(first.left, second.left) > 0.1 &&
            Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > 0.1
          ) {
            throw new RenderPDFError(
              'UNSUPPORTED_CSS',
              'Overlapping sibling boxes are unsupported; isolate them in one raster subtree.',
            );
          }
        }
      }
    }
    // Child nodes, including inline text, retain source order within the restricted paint model.
    for (const child of element.childNodes) {
      if (child.nodeType === 3)
        operations.push(...measureText(child as Text, origin, fonts, cache, invisible));
      else if (isHtmlElement(child)) visit(child, invisible, automatic);
      else if (child.nodeType === 1) {
        const foreign = child as Element;
        if (invisible)
          warnings.push({
            code: 'RASTER_TEXT_OMITTED',
            message: `Raster text extraction omitted for ${foreign.tagName}.`,
          });
        else
          throw new RenderPDFError(
            'UNSUPPORTED_ELEMENT',
            `Cannot snapshot ${foreign.tagName}; use a raster subtree.`,
          );
      }
    }
    if (
      repeatTableHeaders &&
      ['THEAD', 'TBODY', 'TFOOT'].includes(element.tagName) &&
      element.tagName === 'THEAD'
    ) {
      headerPaint.set(element as HTMLTableSectionElement, operations.slice(operationStart));
    }
    if (!invisible && isHtmlTag(element, 'table') && collapsed) {
      const paint = measureCollapsedTableBorders(element, origin);
      collapsedTables.set(element, paint);
      // Avoid the JavaScript argument-count limit when a long table creates many border segments.
      for (const operation of paint.operations) operations.push(operation);
      // Include the table's outer half-borders in the neighboring row, avoiding border-only pages.
      const rows = Array.from(element.rows).filter((row) => tableRows.has(row));
      const firstRow = rows[0] ? tableRows.get(rows[0]) : undefined;
      const lastRow = rows.at(-1) ? tableRows.get(rows.at(-1)!) : undefined;
      const extent = paint.operations.reduce(
        (bounds, { bounds: border }) => ({
          top: Math.min(bounds.top, border.y),
          bottom: Math.max(bounds.bottom, border.y + border.height),
        }),
        { top: firstRow?.y ?? 0, bottom: lastRow ? lastRow.y + lastRow.height : 0 },
      );
      if (firstRow && extent.top < firstRow.y) {
        firstRow.height += firstRow.y - extent.top;
        firstRow.y = extent.top;
      }
      if (lastRow) lastRow.height = Math.max(lastRow.height, extent.bottom - lastRow.y);
      const head = element.tHead;
      if (repeatTableHeaders && head && paint.headerBounds) {
        const bounds = paint.headerBounds;
        const included = paint.operations.filter(
          (border) =>
            border.bounds.y < bounds.y + bounds.height + 0.001 &&
            border.bounds.y + border.bounds.height > bounds.y - 0.001,
        );
        headerPaint.set(head, [...(headerPaint.get(head) ?? []), ...included]);
      }
    }
  }
  visit(root, false);
  // Element-only sibling checks cannot detect a direct text node overlapping a later block.
  const earlierText: TextOperation[] = [];
  for (const operation of operations) {
    if (operation.kind === 'text') {
      if (!operation.invisible) earlierText.push(operation);
      continue;
    }
    if (operation.kind === 'box') {
      // Fully transparent boxes without a border cannot obscure previously emitted text.
      const alpha = operation.background.startsWith('rgba(')
        ? Number(operation.background.slice(operation.background.lastIndexOf(',') + 1, -1))
        : 1;
      if (alpha === 0 && operation.borderWidth === 0) continue;
    }
    // Browser block backgrounds and inline content have separate paint phases beyond DFS order.
    const bounds = operation.bounds;
    if (
      earlierText.some(
        (text) =>
          Math.min(text.bounds.x + text.bounds.width, bounds.x + bounds.width) -
            Math.max(text.bounds.x, bounds.x) >
            0.1 &&
          Math.min(text.bounds.y + text.bounds.height, bounds.y + bounds.height) -
            Math.max(text.bounds.y, bounds.y) >
            0.1,
      )
    ) {
      throw new RenderPDFError(
        'UNSUPPORTED_CSS',
        'Text overlaps later visible paint whose CSS paint phases cannot be represented safely; use an explicit containing raster region.',
      );
    }
  }
  // A long unbroken text node can overflow even when its parent element's border box fits.
  if (
    operations.some((operation) => {
      // Extraction-only raster text already follows the subtree's explicitly diagnosed policy.
      if (operation.kind === 'text' && operation.invisible) return false;
      // All visible paint must fit the source before the writer applies a physical page clip.
      const bounds = operation.bounds;
      return (
        bounds.x < -0.1 ||
        bounds.y < -0.1 ||
        bounds.x + bounds.width > origin.width + 0.1 ||
        bounds.y + bounds.height > origin.height + 0.1
      );
    })
  ) {
    throw new RenderPDFError(
      'SOURCE_OVERFLOW',
      'Visible source text or paint overflows the root border box.',
    );
  }
  return {
    width: origin.width,
    height: origin.height,
    operations,
    warnings,
    atomicBounds,
    ...(repeatTableHeaders
      ? {
          tableHeaders: measureTableHeaders(
            root,
            origin,
            operations,
            headerPaint,
            elementBoxes,
            collapsedTables,
          ),
        }
      : {}),
  };
}
