import { RenderPDFError } from './diagnostics.js';
import { computedStyle, isHtmlTag } from './dom.js';
import type { BorderOperation, Bounds } from './types.js';

/** Subpixel equality is only used to join browser-measured shared grid edges. */
const EDGE_EPSILON = 0.001;

/** One authored border competing for a measured collapsed grid edge. */
export interface TableBorderCandidate {
  /** Horizontal or vertical source-coordinate grid line. */
  direction: 'horizontal' | 'vertical';
  /** Fixed grid coordinate perpendicular to the edge. */
  position: number;
  /** Inclusive coordinate along the edge. */
  start: number;
  /** Exclusive coordinate along the edge. */
  end: number;
  /** Computed thickness; hidden borders retain priority even when their computed width is zero. */
  width: number;
  /** Supported CSS border style; hidden suppresses every competing border. */
  style: 'solid' | 'none' | 'hidden';
  /** Browser-resolved color of this candidate. */
  color: string;
  /** Cells outrank the table when equally wide solid borders compete. */
  owner: 'cell' | 'table';
  /** Owner's top grid coordinate, used for the upper-cell tie break. */
  row: number;
  /** Owner's left grid coordinate, used for direction-dependent cell tie breaks. */
  column: number;
}

/** Native border paint and replay limits for one measured collapsed table. */
export interface CollapsedTablePaint {
  /** Nonoverlapping final fills in border conflict priority order. */
  operations: BorderOperation[];
  /** Header grid bounds expanded through the outer top, left and right half-borders. */
  headerBounds?: Bounds;
  /** Continuations can reuse half-boundaries only when their horizontal winners agree. */
  repeatSafe: boolean;
}

/** Prefer hidden, then visible thickness, cell ownership, and the upper/start owner.
 * @param left First candidate on one shared grid interval.
 * @param right Second candidate on that interval or at a crossing.
 * @param direction Table direction that selects the start-side cell.
 */
function priority(
  left: TableBorderCandidate,
  right: TableBorderCandidate,
  direction: 'ltr' | 'rtl',
): number {
  const rank = (candidate: TableBorderCandidate) =>
    candidate.style === 'hidden' ? 2 : candidate.style === 'solid' && candidate.width > 0 ? 1 : 0;
  const startColumn = direction === 'rtl' ? left.column - right.column : right.column - left.column;
  return (
    rank(left) - rank(right) ||
    left.width - right.width ||
    Number(left.owner === 'cell') - Number(right.owner === 'cell') ||
    (left.direction !== right.direction
      ? Number(left.direction === 'horizontal') - Number(right.direction === 'horizontal')
      : left.direction === 'vertical'
        ? startColumn || right.row - left.row
        : right.row - left.row || startColumn)
  );
}

/** Resolve each shared interval once, including partial edges beside rowspans and colspans.
 * @param candidates Authored borders positioned on browser-measured cell grid lines.
 */
function resolveSegments(
  candidates: readonly TableBorderCandidate[],
  direction: 'ltr' | 'rtl',
): TableBorderCandidate[] {
  // Adjacent cells report the same grid line; grouping leaves their actual measured coordinate intact.
  const groups = new Map<string, TableBorderCandidate[]>();
  for (const candidate of candidates) {
    if (
      ![candidate.position, candidate.start, candidate.end, candidate.width].every(
        Number.isFinite,
      ) ||
      candidate.width < 0 ||
      candidate.end <= candidate.start
    ) {
      throw new RenderPDFError(
        'INVALID_SOURCE',
        'Collapsed border geometry must be finite and positive.',
      );
    }
    const key = `${candidate.direction}:${candidate.position.toFixed(4)}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  const resolved: TableBorderCandidate[] = [];
  for (const group of groups.values()) {
    // Every participating endpoint can change the winner along a spanning cell's longer side.
    const events = new Map<
      number,
      { starts: TableBorderCandidate[]; ends: TableBorderCandidate[] }
    >();
    for (const edge of group) {
      const start = events.get(edge.start) ?? { starts: [], ends: [] };
      start.starts.push(edge);
      events.set(edge.start, start);
      const end = events.get(edge.end) ?? { starts: [], ends: [] };
      end.ends.push(edge);
      events.set(edge.end, end);
    }
    const points = [...events.keys()].sort((left, right) => left - right);
    const active = new Set<TableBorderCandidate>();
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index]!;
      const end = points[index + 1]!;
      const event = events.get(start)!;
      for (const edge of event.ends) active.delete(edge);
      for (const edge of event.starts) active.add(edge);
      if (end - start <= EDGE_EPSILON) continue;
      // A valid table edge has at most its adjacent cells and the table competing at one coordinate.
      let winner: TableBorderCandidate | undefined;
      for (const edge of active)
        if (!winner || priority(edge, winner, direction) > 0) winner = edge;
      if (winner?.style === 'solid' && winner.width > 0) resolved.push({ ...winner, start, end });
    }
  }
  return resolved;
}

/** Remove an already painted crossing, keeping disjoint rectangular pieces for alpha-safe fills.
 * @param bounds New border rectangle that may overlap an earlier stronger border.
 * @param occupied Rectangle already assigned to an earlier border.
 */
function subtract(bounds: Bounds, occupied: Bounds): Bounds[] {
  const left = Math.max(bounds.x, occupied.x);
  const right = Math.min(bounds.x + bounds.width, occupied.x + occupied.width);
  const top = Math.max(bounds.y, occupied.y);
  const bottom = Math.min(bounds.y + bounds.height, occupied.y + occupied.height);
  if (right <= left + EDGE_EPSILON || bottom <= top + EDGE_EPSILON) return [bounds];
  return [
    { x: bounds.x, y: bounds.y, width: bounds.width, height: top - bounds.y },
    { x: bounds.x, y: bottom, width: bounds.width, height: bounds.y + bounds.height - bottom },
    { x: bounds.x, y: top, width: left - bounds.x, height: bottom - top },
    { x: right, y: top, width: bounds.x + bounds.width - right, height: bottom - top },
  ].filter((piece) => piece.width > EDGE_EPSILON && piece.height > EDGE_EPSILON);
}

/** Turn resolved centerlines into disjoint filled rectangles, never double-painting shared alpha.
 * @param segments Visible winners after shared-edge conflict resolution.
 */
function paintSegments(
  segments: readonly TableBorderCandidate[],
  direction: 'ltr' | 'rtl',
): BorderOperation[] {
  const operations: BorderOperation[] = [];
  // Index perpendicular centerlines once; endpoint lookup then examines only touching intervals.
  const lines = new Map<string, TableBorderCandidate[]>();
  for (const edge of segments) {
    const key = `${edge.direction}:${edge.position.toFixed(4)}`;
    const line = lines.get(key) ?? [];
    line.push(edge);
    lines.set(key, line);
  }
  for (const line of lines.values()) line.sort((left, right) => left.start - right.start);
  // Page-width table grids use local buckets so distant rows never participate in crossing checks.
  const buckets = new Map<string, BorderOperation[]>();
  const bucketKeys = (bounds: Bounds): string[] => {
    const keys: string[] = [];
    for (
      let x = Math.floor(bounds.x / 64);
      x <= Math.floor((bounds.x + bounds.width) / 64);
      x += 1
    ) {
      for (
        let y = Math.floor(bounds.y / 64);
        y <= Math.floor((bounds.y + bounds.height) / 64);
        y += 1
      ) {
        keys.push(`${x}:${y}`);
      }
    }
    return keys;
  };
  // Stronger strokes own intersections; equal-strength source order is stable and deterministic.
  const ordered = [...segments].sort((left, right) => priority(right, left, direction));
  for (const edge of ordered) {
    // Extend each endpoint through the perpendicular stroke's outer half, closing table corners.
    const extension = (position: number) => {
      const perpendicular = edge.direction === 'horizontal' ? 'vertical' : 'horizontal';
      const line = lines.get(`${perpendicular}:${position.toFixed(4)}`) ?? [];
      let low = 0;
      let high = line.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (line[middle]!.start <= edge.position + EDGE_EPSILON) low = middle + 1;
        else high = middle;
      }
      let half = 0;
      for (let index = low - 1; index >= 0; index -= 1) {
        const other = line[index]!;
        if (other.end < edge.position - EDGE_EPSILON) break;
        half = Math.max(half, other.width / 2);
      }
      return half;
    };
    const start = edge.start - extension(edge.start);
    const end = edge.end + extension(edge.end);
    let pieces: Bounds[] = [
      edge.direction === 'horizontal'
        ? { x: start, y: edge.position - edge.width / 2, width: end - start, height: edge.width }
        : { x: edge.position - edge.width / 2, y: start, width: edge.width, height: end - start },
    ];
    const nearby = new Set(bucketKeys(pieces[0]!).flatMap((key) => buckets.get(key) ?? []));
    for (const painted of nearby) {
      pieces = pieces.flatMap((piece) => subtract(piece, painted.bounds));
      if (pieces.length === 0) break;
    }
    for (const bounds of pieces) {
      const operation: BorderOperation = {
        kind: 'border' as const,
        bounds,
        color: edge.color,
        width: edge.width,
        direction: edge.direction,
      };
      operations.push(operation);
      for (const key of bucketKeys(bounds)) {
        const bucket = buckets.get(key) ?? [];
        bucket.push(operation);
        buckets.set(key, bucket);
      }
    }
  }
  return operations;
}

/** Resolve pure measured-border inputs without depending on browser or PDF globals.
 * @param candidates Competing authored borders with already measured grid coordinates.
 */
export function resolveCollapsedBorders(
  candidates: readonly TableBorderCandidate[],
  direction: 'ltr' | 'rtl' = 'ltr',
): BorderOperation[] {
  return paintSegments(resolveSegments(candidates, direction), direction);
}

/** Find native HTML table parts whose borders participate in one collapsed grid.
 * @param element Current element from the existing static layout traversal.
 * @param style Already computed style for this element.
 */
export function collapsedTableOwner(
  element: HTMLElement,
  style: CSSStyleDeclaration,
): HTMLTableElement | undefined {
  if (
    !['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'COL', 'COLGROUP'].includes(
      element.tagName,
    )
  )
    return undefined;
  const table = isHtmlTag(element, 'table') ? element : element.closest('table');
  return table && (element === table ? style : computedStyle(table)).borderCollapse === 'collapse'
    ? table
    : undefined;
}

/** Enforce the deliberately bounded collapsed-border contributions before native box emission.
 * @param element Native table part whose sides will be resolved together after its cells.
 * @param style Browser-computed authored sides, independent of the winning shared border.
 */
export function validateCollapsedTablePart(element: HTMLElement, style: CSSStyleDeclaration): void {
  // Only native table boxes expose the grid centerlines used by collapsed border resolution.
  const displays: Record<string, readonly string[]> = {
    TABLE: ['table', 'inline-table'],
    THEAD: ['table-header-group'],
    TBODY: ['table-row-group'],
    TFOOT: ['table-footer-group'],
    TR: ['table-row'],
    TD: ['table-cell'],
    TH: ['table-cell'],
    COL: ['table-column'],
    COLGROUP: ['table-column-group'],
  };
  if (!displays[element.tagName]?.includes(style.display)) {
    throw new RenderPDFError(
      'UNSUPPORTED_CSS',
      'Collapsed table parts require their native table-cell, table-row and table-group display modes.',
    );
  }
  for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
    const borderStyle = style[`border${side}Style`];
    const width = Number.parseFloat(style[`border${side}Width`]);
    if (!['solid', 'none', 'hidden'].includes(borderStyle)) {
      throw new RenderPDFError(
        'UNSUPPORTED_CSS',
        'Collapsed tables support only solid, none and hidden border styles.',
      );
    }
    if (
      !['TABLE', 'TD', 'TH'].includes(element.tagName) &&
      (borderStyle === 'hidden' || width > 0)
    ) {
      throw new RenderPDFError(
        'UNSUPPORTED_CSS',
        'Collapsed row, row-group, column and column-group border contributions are unsupported; put borders on cells or the table.',
      );
    }
  }
}

/** Measure cell centerlines and resolve the native table's single border paint layer.
 * @param table Connected native collapsed table with existing browser-calculated column widths.
 * @param origin Source root rectangle defining the shared CSS pixel coordinate system.
 */
export function measureCollapsedTableBorders(
  table: HTMLTableElement,
  origin: DOMRect,
): CollapsedTablePaint {
  if (
    table.parentElement?.closest('table') ||
    table.querySelector('table') ||
    table.caption ||
    !['table', 'inline-table'].includes(computedStyle(table).display)
  ) {
    throw new RenderPDFError(
      'UNSUPPORTED_ELEMENT',
      'Native collapsed borders require a table without nested tables or captions.',
    );
  }
  const candidates: TableBorderCandidate[] = [];
  const cells = Array.from(table.rows).flatMap((row) =>
    Array.from(row.cells).filter((cell) => {
      const bounds = cell.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    }),
  );
  if (cells.length === 0) return { operations: [], repeatSafe: true };
  // Cell rectangles are grid centerlines; their outer half-borders belong to the table's border box.
  const rectangles = cells.map((cell) => cell.getBoundingClientRect());
  const grid = rectangles.reduce(
    (extent, bounds) => ({
      left: Math.min(extent.left, bounds.left),
      right: Math.max(extent.right, bounds.right),
      top: Math.min(extent.top, bounds.top),
      bottom: Math.max(extent.bottom, bounds.bottom),
    }),
    {
      left: Number.POSITIVE_INFINITY,
      right: Number.NEGATIVE_INFINITY,
      top: Number.POSITIVE_INFINITY,
      bottom: Number.NEGATIVE_INFINITY,
    },
  );
  const add = (element: HTMLTableElement | HTMLTableCellElement, bounds: typeof grid) => {
    const style = computedStyle(element);
    const owner = element === table ? 'table' : 'cell';
    for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
      const horizontal = side === 'Top' || side === 'Bottom';
      candidates.push({
        direction: horizontal ? 'horizontal' : 'vertical',
        position:
          (side === 'Top'
            ? bounds.top
            : side === 'Bottom'
              ? bounds.bottom
              : side === 'Left'
                ? bounds.left
                : bounds.right) - (horizontal ? origin.top : origin.left),
        start: (horizontal ? bounds.left : bounds.top) - (horizontal ? origin.left : origin.top),
        end: (horizontal ? bounds.right : bounds.bottom) - (horizontal ? origin.left : origin.top),
        width: Number.parseFloat(style[`border${side}Width`]),
        style: style[`border${side}Style`] as TableBorderCandidate['style'],
        color: style[`border${side}Color`],
        owner,
        row: bounds.top,
        column: bounds.left,
      });
    }
  };
  add(table, grid);
  cells.forEach((cell, index) => add(cell, rectangles[index]!));
  const direction = computedStyle(table).direction === 'rtl' ? 'rtl' : 'ltr';
  const segments = resolveSegments(candidates, direction);
  const operations = paintSegments(segments, direction);
  const head = table.tHead?.getBoundingClientRect();
  if (!head || head.height <= 0) return { operations, repeatSafe: true };
  const headerBottom = head.bottom - origin.top;
  const bodyRows = Array.from(table.tBodies).flatMap((body) => Array.from(body.rows));
  const bodyBottom = bodyRows.at(-1)?.getBoundingClientRect().bottom ?? head.bottom;
  // Only boundaries that could become a continuation's first row need the same horizontal winner.
  const boundaries = [
    ...new Set([
      headerBottom,
      ...bodyRows
        .map((row) => row.getBoundingClientRect().top - origin.top)
        .filter((position) => position < bodyBottom - origin.top - EDGE_EPSILON),
    ]),
  ];
  const horizontalLines = new Map<string, TableBorderCandidate[]>();
  for (const edge of segments) {
    if (edge.direction !== 'horizontal') continue;
    const key = edge.position.toFixed(4);
    const line = horizontalLines.get(key) ?? [];
    line.push(edge);
    horizontalLines.set(key, line);
  }
  const signature = (position: number) =>
    JSON.stringify(
      (horizontalLines.get(position.toFixed(4)) ?? [])
        .sort((left, right) => left.start - right.start)
        .map(({ start, end, width, color }) => ({ start, end, width, color })),
    );
  const expected = signature(headerBottom);
  const repeatSafe = boundaries.every((position) => signature(position) === expected);
  const headerEdges = operations.filter(
    (operation) =>
      operation.bounds.y < headerBottom + EDGE_EPSILON &&
      operation.bounds.y + operation.bounds.height > head.top - origin.top - EDGE_EPSILON,
  );
  const extent = headerEdges.reduce(
    (bounds, { bounds: edge }) => ({
      left: Math.min(bounds.left, edge.x),
      right: Math.max(bounds.right, edge.x + edge.width),
      top: Math.min(bounds.top, edge.y),
    }),
    { left: head.left - origin.left, right: head.right - origin.left, top: head.top - origin.top },
  );
  return {
    operations,
    repeatSafe,
    headerBounds: {
      x: extent.left,
      y: extent.top,
      width: extent.right - extent.left,
      height: headerBottom - extent.top,
    },
  };
}
