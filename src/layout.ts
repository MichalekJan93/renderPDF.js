import { RenderPDFError, type RenderWarning } from './diagnostics.js';
import { assertAutomaticRasterBoundary, automaticRasterReason } from './planner.js';
import type { RegisteredFont } from './api-types.js';
import type { Bounds, LayoutSnapshot, PaintOperation, TextOperation } from './types.js';

/** Grapheme boundaries are locale independent for the supported Latin text. */
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

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
    element.parentElement ??
    (tree instanceof ShadowRoot && tree.host instanceof HTMLElement ? tree.host : null)
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
): void {
  // Chromium clips replaced image content to its own box by default; fill embedding matches it.
  const replacedImage = element instanceof HTMLImageElement;
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
    style.direction !== 'ltr' && 'direction',
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
    const content = getComputedStyle(element, pseudo).content;
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
  if (element instanceof HTMLTableElement && style.borderCollapse !== 'separate') {
    throw new RenderPDFError(
      'UNSUPPORTED_CSS',
      'Native table snapshots require separate borders; collapsed borders are unsupported.',
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
  if (
    widths.some((width) => width !== widths[0]) ||
    (widths[0] !== '0px' &&
      (colors.some((color) => color !== colors[0]) ||
        styles.some((borderStyle) => borderStyle !== 'solid')))
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
    !(element instanceof HTMLImageElement) &&
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
  const style = getComputedStyle(parent);
  // Normalize a quoted family name while retaining the first actual CSS choice.
  const family = style.fontFamily
    .split(',')[0]
    ?.trim()
    .replace(/^['"]|['"]$/g, '');
  // Browser computed weights are numeric even when the authored value is bold.
  const weight = Number(style.fontWeight);
  // Only explicitly supplied faces may be mapped to PDF glyphs.
  const face = fonts.find(
    (font) =>
      font.family.toLowerCase() === family?.toLowerCase() &&
      font.weight === weight &&
      font.style === style.fontStyle,
  );
  if (!face)
    throw new RenderPDFError(
      'MISSING_FONT',
      `No exact registered font face for ${style.fontFamily} ${style.fontWeight} ${style.fontStyle}.`,
    );
  if (
    style.direction !== 'ltr' ||
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
      'Unsupported CSS: text requires horizontal LTR layout with normal whitespace, spacing, font variants and OpenType features, without automatic hyphenation or soft hyphens.',
    );
  }
  // FontFaceSet confirms this exact registered face has finished loading.
  const fontSize = Number.parseFloat(style.fontSize);
  // Canvas font metrics approximate a baseline that Range does not expose.
  const fontDescription = `${face.style} ${face.weight} ${fontSize}px "${face.family}"`;
  let metrics = cache.fonts.get(fontDescription);
  if (!metrics) {
    // FontFaceSet.check alone also succeeds for unknown families resolved through fallback.
    const loadedFace = Array.from(document.fonts).some((browserFace) => {
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
    if (!loadedFace || !document.fonts.check(fontDescription, node.data))
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
  // Grapheme boundaries preserve surrogate pairs and combining Czech/Latin marks.
  const segments = graphemes.segment(node.data);
  // A reusable Range reads browser-produced geometry, not a synthetic line-breaking algorithm.
  const range = document.createRange();
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
    // Source offsets remain available for independent per-word Range measurements.
    const sourceLine = node.data.slice(start, end);
    // Collapse only CSS normal-whitespace characters; preserve non-breaking spaces.
    const text = sourceLine.replace(/[\t\n\r\f ]+/g, ' ');
    // Whole-line bounds remain the atomic pagination interval and verification metadata.
    const bounds = relativeBounds(range.getBoundingClientRect(), origin);
    // Measured word origins prevent endpoint fitting from accumulating drift across a line.
    const runs = Array.from(sourceLine.matchAll(/[^\t\n\r\f ]+/g), (match) => {
      range.setStart(node, start + match.index);
      range.setEnd(node, start + match.index + match[0].length);
      // Word origins belong to the browser; the writer preserves each word's shaped glyphs.
      const wordBounds = relativeBounds(range.getBoundingClientRect(), origin);
      return { text: match[0], x: wordBounds.x, width: wordBounds.width };
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
): void {
  if (fallback !== 'auto' && fallback !== 'strict') {
    throw new RenderPDFError('INVALID_OPTIONS', 'Raster fallback must be auto or strict.');
  }
  if (
    !(root instanceof HTMLElement) ||
    root.ownerDocument !== document ||
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
    const ancestorStyle = getComputedStyle(ancestor);
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
  } = {},
): Promise<LayoutSnapshot> {
  // Capture the caller's policy before yielding, and reject invalid input before waiting on resources.
  const fallback = options.fallback ?? 'auto';
  validateLayoutSource(root, fonts, fallback);
  await document.fonts.ready;
  // Image decoding completes before any geometry is measured.
  const images = Array.from(root.querySelectorAll('img'));
  if (root instanceof HTMLImageElement) images.unshift(root);
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
  return measurePreparedLayout(root, fonts, { fallback });
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
  } = {},
): LayoutSnapshot {
  // Capture the policy once; this path deliberately performs no asynchronous resource preparation.
  const fallback = options.fallback ?? 'auto';
  validateLayoutSource(root, fonts, fallback);
  // One origin is shared by vector text, image bounds, and raster regions.
  const origin = root.getBoundingClientRect();
  if (origin.width <= 0 || origin.height <= 0)
    throw new RenderPDFError(
      'INVALID_SOURCE',
      'The source root must have positive visible dimensions.',
    );
  // Canvas is never appended, so measurement leaves the application DOM unchanged.
  const contextCandidate = document.createElement('canvas').getContext('2d');
  if (!contextCandidate)
    throw new RenderPDFError('INVALID_SOURCE', 'Canvas font measurement is unavailable.');
  // Capture the checked context as a non-null value for the recursive visitor.
  const cache: TextMetricsCache = { context: contextCandidate, fonts: new Map() };
  // The list's order is the paint order for this deliberately restricted static subset.
  const operations: PaintOperation[] = [];
  // Browser rows and rowspan cells are indivisible intervals for the existing page mapper.
  const atomicBounds: Bounds[] = [];
  // Approximate baseline and shaping behavior must remain visible to experiment users.
  const warnings: RenderWarning[] = [
    {
      code: 'TEXT_METRICS_APPROXIMATED',
      message:
        'Baselines are estimated from Canvas font metrics; browser and PDF shaping engines may still differ for unsupported scripts or font features.',
    },
  ];

  /** Walk a subtree once; raster descendants contribute only invisible extraction text.
   * @param element Current HTML element in static DOM paint order.
   * @param insideRaster Whether an ancestor already emitted the visible raster image.
   * @param insideAutomatic Whether automatic capture must retain the stricter native safety guards.
   */
  function visit(element: HTMLElement, insideRaster: boolean, insideAutomatic = false): void {
    // Display-none descendants have no paint or extraction contribution.
    const style = getComputedStyle(element);
    if (style.display === 'none') return;
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
      validateVectorStyle(element, style, true);
      validateDisplay(element, style);
    }
    if (
      insideRaster &&
      (style.transform !== 'none' ||
        style.writingMode !== 'horizontal-tb' ||
        style.direction !== 'ltr' ||
        style.opacity === '0' ||
        style.clipPath !== 'none' ||
        style.maskImage !== 'none' ||
        style.overflowX !== 'visible' ||
        style.overflowY !== 'visible')
    ) {
      warnings.push({
        code: 'RASTER_TEXT_OMITTED',
        message: `Raster text extraction omitted for transformed, clipped, hidden, masked, or non-LTR subtree ${element.tagName}.`,
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
      validateVectorStyle(element, style);
      validateDisplay(element, style);
      if (
        element instanceof HTMLTableRowElement ||
        (element instanceof HTMLTableCellElement && element.rowSpan !== 1)
      ) {
        atomicBounds.push(bounds);
      }
      if (element instanceof HTMLImageElement) {
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
        operations.push({
          kind: 'box',
          bounds,
          background: style.backgroundColor,
          borderColor: style.borderTopColor,
          borderWidth: Number.parseFloat(style.borderTopWidth),
        });
      }
    }
    // Raster descendants retain semantic text without emitting duplicate visible boxes or images.
    const invisible = insideRaster || raster;
    if (!invisible || automatic) {
      // Overlapping sibling border boxes need CSS paint phases that DFS cannot guarantee.
      const siblingBounds = Array.from(element.children)
        .filter(
          (child): child is HTMLElement =>
            child instanceof HTMLElement &&
            getComputedStyle(child).display !== 'none' &&
            getComputedStyle(child).visibility !== 'hidden',
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
      if (child instanceof Text)
        operations.push(...measureText(child, origin, fonts, cache, invisible));
      else if (child instanceof HTMLElement) visit(child, invisible, automatic);
      else if (child instanceof Element) {
        if (invisible)
          warnings.push({
            code: 'RASTER_TEXT_OMITTED',
            message: `Raster text extraction omitted for ${child.tagName}.`,
          });
        else
          throw new RenderPDFError(
            'UNSUPPORTED_ELEMENT',
            `Cannot snapshot ${child.tagName}; use a raster subtree.`,
          );
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
  return { width: origin.width, height: origin.height, operations, warnings, atomicBounds };
}
