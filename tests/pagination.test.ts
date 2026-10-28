import { describe, expect, it } from 'vite-plus/test';
import { paginate } from '../src/pagination';
import type { Bounds, LayoutSnapshot, TableHeader, TextOperation } from '../src/types';
import type { RenderWarning } from '../src/diagnostics';

/** Construct a measured atomic text interval for coordinate-partition checks. */
function textAt(
  /** Inclusive source top of this synthetic browser text line, in CSS pixels. */
  y: number,
  /** Measured line height used as an indivisible vertical interval. */
  height = 20,
): TextOperation {
  return {
    kind: 'text',
    bounds: { x: 0, y, width: 100, height },
    text: 'Text',
    runs: [{ text: 'Text', x: 0, width: 100 }],
    baseline: y + 15,
    fontSize: 16,
    family: 'Fixture Sans',
    weight: 400,
    style: 'normal',
    color: 'rgb(0, 0, 0)',
    invisible: false,
  };
}

/** Construct an empty measured source for CSS boundary metadata regression checks. */
function emptySource(
  /** Total source extent, in CSS pixels. */
  height = 240,
): LayoutSnapshot {
  return { width: 100, height, operations: [], warnings: [] };
}

/** Construct a measured block preference without inventing browser layout behavior. */
function blockAt(
  /** Inclusive source top, in CSS pixels. */
  y: number,
  /** Complete vertical extent that CSS prefers to keep together. */
  height: number,
): Bounds {
  return { x: 0, y, width: 100, height };
}

/** Construct a native header and atomic body rows without relying on a browser layout algorithm. */
function tableSource(
  /** Original THEAD top; preceding source content can force the table onto another page. */
  top: number,
  /** Header band height, including any spacing before the first body row. */
  headerHeight: number,
  /** Positive browser-measured row heights in their original source order. */
  rowHeights: readonly number[],
  /** Content after the final body row, such as a footer or another document section. */
  trailingHeight = 0,
): { snapshot: LayoutSnapshot; header: TableHeader } {
  // Original header text stays in the main paint list; continuations reference it without cloning.
  const heading = textAt(top, headerHeight);
  const rows: Bounds[] = [];
  let position = top + headerHeight;
  for (const height of rowHeights) {
    rows.push(blockAt(position, height));
    position += height;
  }
  const header: TableHeader = {
    bounds: blockAt(top, headerHeight),
    bodyStart: top + headerHeight,
    bodyEnd: position,
    operations: [heading],
  };
  return {
    snapshot: {
      width: 100,
      height: position + trailingHeight,
      operations: [heading],
      warnings: [],
      atomicBounds: rows,
      tableHeaders: [header],
    },
    header,
  };
}

describe('shared page/source coordinate mapping', () => {
  it('moves cuts before text and partitions every source pixel once', () => {
    // A line crossing the nominal break stays entirely on the next page.
    const snapshot: LayoutSnapshot = {
      width: 100,
      height: 180,
      operations: [textAt(90)],
      warnings: [],
    };
    expect(paginate(snapshot, 100)).toEqual([
      { start: 0, end: 90 },
      { start: 90, end: 180 },
    ]);
  });

  it('rechecks overlapping atomic intervals after moving a cut', () => {
    // Moving before the second line must not split the first overlapping line.
    const snapshot: LayoutSnapshot = {
      width: 100,
      height: 180,
      operations: [textAt(70, 25), textAt(90)],
      warnings: [],
    };
    expect(paginate(snapshot, 100)[0]).toEqual({ start: 0, end: 70 });
  });

  it('rejects oversized atomic content and invalid page dimensions', () => {
    // Tall objects need a future fragmentation policy, never silent clipping.
    const snapshot: LayoutSnapshot = {
      width: 100,
      height: 180,
      operations: [textAt(0, 110)],
      warnings: [],
    };
    expect(() => paginate(snapshot, 100)).toThrow('taller');
    expect(() => paginate(snapshot, Number.NaN)).toThrow('positive');
  });

  it('keeps a complete table row and its spanning cell on the same page', () => {
    // Rowspans may join several row intervals without changing browser cell coordinates.
    const snapshot: LayoutSnapshot = {
      width: 100,
      height: 180,
      operations: [textAt(75, 10), textAt(95, 10)],
      warnings: [],
      atomicBounds: [
        { x: 0, y: 70, width: 100, height: 20 },
        { x: 0, y: 90, width: 100, height: 20 },
        { x: 0, y: 70, width: 20, height: 40 },
      ],
    };
    expect(paginate(snapshot, 100)).toEqual([
      { start: 0, end: 70 },
      { start: 70, end: 170 },
      { start: 170, end: 180 },
    ]);
  });

  it('rejects a spanning table cell taller than a page and invalid row geometry', () => {
    // Unsupported row fragmentation fails before composing a partially clipped table.
    const snapshot: LayoutSnapshot = {
      width: 100,
      height: 180,
      operations: [],
      warnings: [],
      atomicBounds: [{ x: 0, y: 0, width: 20, height: 110 }],
    };
    expect(() => paginate(snapshot, 100)).toThrow('taller');
    snapshot.atomicBounds = [{ x: 0, y: Number.NaN, width: 20, height: 20 }];
    expect(() => paginate(snapshot, 100)).toThrow('Atomic geometry');
  });

  it('honors ordered forced boundaries without blank root-edge or duplicate pages', () => {
    // Duplicate before/after rules can map to the same source coordinate.
    const snapshot = emptySource();
    snapshot.forcedBreaks = [240, 160, 0, 60, 60, 160];
    expect(paginate(snapshot, 100)).toEqual([
      { start: 0, end: 60 },
      { start: 60, end: 160 },
      { start: 160, end: 240 },
    ]);
  });

  it('inserts natural pages before a required boundary beyond one page height', () => {
    // A forced break does not enlarge the preceding page beyond its usable height.
    const snapshot = emptySource(350);
    snapshot.forcedBreaks = [250];
    expect(paginate(snapshot, 100)).toEqual([
      { start: 0, end: 100 },
      { start: 100, end: 200 },
      { start: 200, end: 250 },
      { start: 250, end: 350 },
    ]);
  });

  it('rejects forced boundaries through text lines and table rowspans', () => {
    // An explicit break cannot split selectable extraction geometry or an indivisible spanning cell.
    const snapshot = emptySource();
    snapshot.operations = [textAt(50, 20)];
    snapshot.forcedBreaks = [60];
    expect(() => paginate(snapshot, 100)).toThrowError(
      expect.objectContaining({
        code: 'PAGINATION_FAILED',
        message: expect.stringContaining('forced CSS'),
      }),
    );
    snapshot.operations = [];
    snapshot.atomicBounds = [blockAt(50, 90)];
    expect(() => paginate(snapshot, 100)).toThrow('forced CSS');
  });

  it('keeps a fitting avoid-inside block together at a natural boundary', () => {
    // The preferred block moves to the next page while every source coordinate remains covered once.
    const snapshot = emptySource(180);
    snapshot.avoidBreakBounds = [blockAt(70, 60)];
    expect(paginate(snapshot, 100)).toEqual([
      { start: 0, end: 70 },
      { start: 70, end: 170 },
      { start: 170, end: 180 },
    ]);
  });

  it('rechecks required text after moving a cut before a fitting avoidance block', () => {
    // The avoid origin lies inside a preceding line, so both must move together to a safe boundary.
    const snapshot = emptySource(180);
    snapshot.operations = [textAt(60, 20)];
    snapshot.avoidBreakBounds = [blockAt(70, 60)];
    expect(paginate(snapshot, 100)[0]).toEqual({ start: 0, end: 60 });
  });

  it('gives forced cuts precedence over soft ancestor avoidance', () => {
    // No empty page or backward move should be created to satisfy a rule overridden by an explicit cut.
    const snapshot = emptySource(180);
    snapshot.forcedBreaks = [90];
    snapshot.avoidBreakBounds = [blockAt(50, 80)];
    expect(paginate(snapshot, 100)).toEqual([
      { start: 0, end: 90 },
      { start: 90, end: 180 },
    ]);
    // Even an oversized ancestor preference is explicitly overridden rather than silently relaxed.
    snapshot.avoidBreakBounds = [blockAt(0, 180)];
    // No avoid-relaxation warning is needed when the CSS forced-break rule itself determines the cut.
    const warnings: RenderWarning[] = [];
    expect(paginate(snapshot, 100, (warning) => warnings.push(warning))).toHaveLength(2);
    expect(warnings).toEqual([]);
  });

  it('relaxes oversized avoidance once while preserving intrinsic atomic lines', () => {
    // Large native backgrounds can fragment; this does not grant permission to split their text lines.
    const snapshot = emptySource();
    snapshot.operations = [textAt(90, 20)];
    snapshot.avoidBreakBounds = [blockAt(0, 240), blockAt(20, 200)];
    // Diagnostics are observable without mutating the snapshot's input warning list.
    const warnings: RenderWarning[] = [];
    expect(paginate(snapshot, 100, (warning) => warnings.push(warning))).toEqual([
      { start: 0, end: 90 },
      { start: 90, end: 190 },
      { start: 190, end: 240 },
    ]);
    expect(warnings).toEqual([expect.objectContaining({ code: 'BREAK_AVOID_RELAXED' })]);
    expect(snapshot.warnings).toEqual([]);
  });

  it('relaxes jointly incompatible avoid preferences without looping or splitting text', () => {
    // Individually fitting overlapping preferences can still form a union larger than one page.
    const snapshot = emptySource();
    snapshot.operations = [textAt(95, 10)];
    snapshot.avoidBreakBounds = [blockAt(0, 80), blockAt(60, 80), blockAt(130, 80)];
    // One warning describes the export even if several natural pages relax the same preference chain.
    const warnings: RenderWarning[] = [];
    expect(paginate(snapshot, 100, (warning) => warnings.push(warning))).toEqual([
      { start: 0, end: 95 },
      { start: 95, end: 195 },
      { start: 195, end: 240 },
    ]);
    expect(warnings).toHaveLength(1);
  });

  it('rejects invalid source extents and out-of-range page metadata', () => {
    // Invalid inputs must fail before a loop can produce missing or non-finite page intervals.
    const snapshot = emptySource();
    for (const height of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => paginate({ ...snapshot, height }, 100)).toThrow('Source height');
    }
    for (const position of [-1, 241, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => paginate({ ...snapshot, forcedBreaks: [position] }, 100)).toThrow(
        'Forced page breaks',
      );
    }
    snapshot.avoidBreakBounds = [blockAt(230, 20)];
    expect(() => paginate(snapshot, 100)).toThrow('within the source');
  });
});

describe('repeated native table header pagination', () => {
  it('reserves header height on every continuation without changing consecutive source intervals', () => {
    // The first page fits two rows; later pages reserve the same twenty-pixel header before rows.
    const { snapshot, header } = tableSource(0, 20, [30, 30, 30, 30, 30]);
    expect(paginate(snapshot, 100)).toEqual([
      { start: 0, end: 80 },
      { start: 80, end: 140, header, headerHeight: 20 },
      { start: 140, end: 170, header, headerHeight: 20 },
    ]);
  });

  it('keeps the original header with at least the first complete body row', () => {
    // Only thirty pixels remain before the first natural cut, too little for header plus first row.
    const { snapshot, header } = tableSource(70, 20, [30, 30, 30]);
    expect(paginate(snapshot, 100)).toEqual([
      { start: 0, end: 70 },
      { start: 70, end: 150 },
      { start: 150, end: 180, header, headerHeight: 20 },
    ]);
  });

  it('includes the gap between THEAD and the first body row in the repeated height', () => {
    // Five pixels of inter-group spacing consume capacity even though the header's box is shorter.
    const { snapshot, header } = tableSource(0, 25, [30, 30, 30, 30, 30]);
    header.bounds.height = 20;
    snapshot.operations[0]!.bounds.height = 20;
    expect(paginate(snapshot, 100)).toEqual([
      { start: 0, end: 85 },
      { start: 85, end: 145, header, headerHeight: 25 },
      { start: 145, end: 175, header, headerHeight: 25 },
    ]);
  });

  it('counts inter-row border spacing only once when a repeated header and row fit exactly', () => {
    // Two source pixels precede the next row, so the repeated header reserves twenty rather than twenty-two.
    const { snapshot, header } = tableSource(0, 20, [78, 78]);
    header.bodyStart = 22;
    header.bodyEnd = 180;
    snapshot.height = 180;
    snapshot.atomicBounds = [blockAt(22, 78), blockAt(102, 78)];
    expect(paginate(snapshot, 100)).toEqual([
      { start: 0, end: 100 },
      { start: 100, end: 180, header, headerHeight: 20 },
    ]);
  });

  it('keeps body-only rowspans and the first header in one complete atomic cluster', () => {
    // A cell joins the first two rows; neither the span nor the original heading may be orphaned.
    const { snapshot, header } = tableSource(40, 20, [30, 30, 30, 30]);
    snapshot.atomicBounds!.push(blockAt(60, 60));
    expect(paginate(snapshot, 100)).toEqual([
      { start: 0, end: 40 },
      { start: 40, end: 120 },
      { start: 120, end: 180, header, headerHeight: 20 },
    ]);
  });

  it('honors forced body-row boundaries while preserving continuation capacity', () => {
    // A forced break after the first row still reserves header space on each following page.
    const { snapshot, header } = tableSource(0, 20, [30, 30, 30, 30, 30]);
    snapshot.forcedBreaks = [50];
    expect(paginate(snapshot, 100)).toEqual([
      { start: 0, end: 50 },
      { start: 50, end: 110, header, headerHeight: 20 },
      { start: 110, end: 170, header, headerHeight: 20 },
    ]);
    // An explicit request to separate the original header from every body row is incompatible.
    snapshot.forcedBreaks = [20];
    expect(() => paginate(snapshot, 100)).toThrow('forced CSS');
  });

  it('stops repeating after the last body row, including pages starting with a table footer', () => {
    // Body end is exclusive, so TFOOT or later document content never gains a stale THEAD.
    const { snapshot, header } = tableSource(0, 20, [30, 30, 30, 30, 30], 50);
    snapshot.forcedBreaks = [header.bodyEnd];
    expect(paginate(snapshot, 100)).toEqual([
      { start: 0, end: 80 },
      { start: 80, end: 140, header, headerHeight: 20 },
      { start: 140, end: 170, header, headerHeight: 20 },
      { start: 170, end: 220 },
    ]);
  });

  it('fails when a later atomic row cannot fit beside its repeated header', () => {
    // Ninety pixels fit a bare page but exceed the eighty pixels left below a repeated THEAD.
    const { snapshot } = tableSource(0, 20, [20, 90]);
    expect(() => paginate(snapshot, 100)).toThrowError(
      expect.objectContaining({
        code: 'PAGINATION_FAILED',
        message: expect.stringContaining('repeated table header'),
      }),
    );
    // The original header plus its first row must fit even before any continuation exists.
    expect(() => paginate(tableSource(0, 20, [90]).snapshot, 100)).toThrow('first atomic body row');
  });

  it('rejects body rowspan clusters that exceed the remaining continuation capacity', () => {
    // Each row fits independently, but a spanning cell joins two later rows into one tall cluster.
    const { snapshot } = tableSource(0, 20, [20, 45, 45]);
    snapshot.atomicBounds!.push(blockAt(40, 90));
    expect(() => paginate(snapshot, 100)).toThrowError(
      expect.objectContaining({ code: 'PAGINATION_FAILED' }),
    );
  });

  it('rejects an empty continuation caused by a body gap taller than its remaining capacity', () => {
    // A continuation may not render a repeated heading alone while advancing through empty spacing.
    const { snapshot, header } = tableSource(0, 20, [20]);
    snapshot.height = 300;
    header.bodyEnd = 300;
    snapshot.atomicBounds!.push(blockAt(280, 20));
    expect(() => paginate(snapshot, 100)).toThrow('complete atomic body row');
  });

  it('relaxes avoidance against the reduced continuation height without splitting rows', () => {
    // The preference fits a bare page, but not a continuation with its twenty-pixel header.
    const { snapshot, header } = tableSource(
      0,
      20,
      Array.from({ length: 11 }, () => 20),
    );
    snapshot.avoidBreakBounds = [blockAt(100, 100)];
    const warnings: RenderWarning[] = [];
    expect(paginate(snapshot, 100, (warning) => warnings.push(warning))).toEqual([
      { start: 0, end: 100 },
      { start: 100, end: 180, header, headerHeight: 20 },
      { start: 180, end: 240, header, headerHeight: 20 },
    ]);
    expect(warnings).toEqual([expect.objectContaining({ code: 'BREAK_AVOID_RELAXED' })]);
  });

  it('rejects overlapping continuation tables and invalid header metadata explicitly', () => {
    // Side-by-side tables cannot share the single repeated band reserved for a continuation page.
    const { snapshot, header } = tableSource(0, 20, [30, 30, 30]);
    snapshot.tableHeaders = [header, { ...header, bounds: { ...header.bounds, x: 50 } }];
    expect(() => paginate(snapshot, 100)).toThrow('must not overlap');
    snapshot.tableHeaders = [{ ...header, bodyStart: Number.NaN }];
    expect(() => paginate(snapshot, 100)).toThrow('finite body row bounds');
    snapshot.tableHeaders = [header];
    snapshot.atomicBounds = [];
    expect(() => paginate(snapshot, 100)).toThrow('atomic first body row');
  });
});
