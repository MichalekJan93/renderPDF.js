import { describe, expect, it } from 'vite-plus/test';
import { paginate } from '../src/pagination';
import type { Bounds, LayoutSnapshot, TextOperation } from '../src/types';
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
