import { RenderPDFError } from './diagnostics.js';
import type { RenderWarning } from './diagnostics.js';
import type { Bounds, LayoutSnapshot } from './types.js';

/** Browser-measured coordinates may differ by less than one hundredth of a CSS pixel. */
const BREAK_EPSILON = 0.01;

/** One source-coordinate interval mapped into a PDF page. */
export interface PageSlice {
  /** Inclusive source top in CSS pixels. */
  start: number;
  /** Exclusive source bottom in CSS pixels. */
  end: number;
}

/** Reject invalid or out-of-source intervals before trying to partition coordinates. */
function assertInterval(
  /** Atomic or preferred interval measured in source CSS pixels. */
  bounds: Bounds,
  /** Finite measured source height, in CSS pixels. */
  sourceHeight: number,
  /** Diagnostic prefix distinguishing required from preferred geometry. */
  category: string,
): void {
  if (
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
    bounds.width < 0 ||
    bounds.height < 0 ||
    bounds.y < -BREAK_EPSILON ||
    bounds.y + bounds.height > sourceHeight + BREAK_EPSILON
  ) {
    throw new RenderPDFError(
      'PAGINATION_FAILED',
      `${category} geometry must be finite, nonnegative and within the source height.`,
    );
  }
}

/** Determine whether a boundary would split positive vertical content. */
function crosses(
  /** Source interval that must or should stay together. */
  bounds: Bounds,
  /** Candidate page end in CSS pixels. */
  end: number,
): boolean {
  return bounds.y < end - BREAK_EPSILON && bounds.y + bounds.height > end + BREAK_EPSILON;
}

/** Move a natural boundary before every intersected required interval. */
function atomicCut(
  /** Initial page end, in source CSS pixels. */
  target: number,
  /** Inclusive page start, in source CSS pixels. */
  start: number,
  /** Intrinsically indivisible text, image, raster, row and spanning-cell bounds. */
  atomic: readonly Bounds[],
): number {
  // A cut only moves backward through a finite set of interval origins.
  let end = target;
  for (;;) {
    // Reduce directly to avoid argument-count limits on very long documents.
    const next = atomic.reduce(
      /** Every crossing required interval must start on the next page. */
      (candidate, bounds) => (crosses(bounds, end) ? Math.min(candidate, bounds.y) : candidate),
      end,
    );
    if (next === end) return end;
    if (next <= start + BREAK_EPSILON) {
      throw new RenderPDFError(
        'PAGINATION_FAILED',
        'Overlapping atomic items cannot fit on one page.',
      );
    }
    end = next;
  }
}

/** Map one continuous source into pages with required cuts and best-effort CSS avoidance. */
export function paginate(
  /** Browser-measured display list plus optional CSS page-break metadata. */
  snapshot: LayoutSnapshot,
  /** Usable height after top/bottom page margins, in CSS pixels. */
  contentHeight: number,
  /** Optional observer for a preference that cannot fit without splitting native content. */
  onWarning?: (warning: RenderWarning) => void,
): PageSlice[] {
  if (!Number.isFinite(contentHeight) || contentHeight <= 0) {
    throw new RenderPDFError(
      'PAGINATION_FAILED',
      'Page content height must be finite and positive.',
    );
  }
  if (!Number.isFinite(snapshot.height) || snapshot.height <= 0) {
    throw new RenderPDFError('PAGINATION_FAILED', 'Source height must be finite and positive.');
  }
  // Page intervals share source coordinates with every paint operation.
  const slices: PageSlice[] = [];
  // Text/images and measured table intervals must retain the same indivisible page ownership.
  const atomic = [
    ...snapshot.operations
      .filter((operation) => operation.kind !== 'box')
      .map((operation) => operation.bounds),
    ...(snapshot.atomicBounds ?? []),
  ];
  for (const bounds of atomic) {
    assertInterval(bounds, snapshot.height, 'Atomic');
    if (bounds.height > contentHeight + BREAK_EPSILON) {
      throw new RenderPDFError(
        'PAGINATION_FAILED',
        'An atomic item is taller than one page; this renderer cannot split it.',
      );
    }
  }
  // Validate before sorting: NaN and outside coordinates must never look like absent CSS rules.
  const requestedBreaks = snapshot.forcedBreaks ?? [];
  for (const position of requestedBreaks) {
    if (!Number.isFinite(position) || position < 0 || position > snapshot.height) {
      throw new RenderPDFError(
        'PAGINATION_FAILED',
        'Forced page breaks must lie within the finite source height.',
      );
    }
  }
  // Root edges and coincident rules do not create blank pages.
  const forcedBreaks = [...new Set(requestedBreaks)]
    .filter(
      /** A forced cut at either root edge has no content on one side. */
      (position) => position > BREAK_EPSILON && position < snapshot.height - BREAK_EPSILON,
    )
    .sort(
      /** Source order determines which required boundary is encountered next. */
      (left, right) => left - right,
    )
    .filter(
      /** Subpixel-coincident browser boundaries represent one physical page cut. */
      (position, index, positions) =>
        index === 0 || position - positions[index - 1]! > BREAK_EPSILON,
    );
  for (const position of forcedBreaks) {
    if (
      atomic.some(
        /** Explicit CSS cuts must never split extraction lines or indivisible table/image content. */
        (bounds) => crosses(bounds, position),
      )
    ) {
      throw new RenderPDFError(
        'PAGINATION_FAILED',
        'A forced CSS page break crosses an atomic text, image, raster, table row or spanning cell.',
      );
    }
  }
  // Report at most once even when several oversized or overlapping preferences must relax.
  let avoidRelaxed = false;
  /** Notify the caller without mutating the browser snapshot or silently losing a CSS preference. */
  function warnAvoidRelaxed(): void {
    if (avoidRelaxed) return;
    avoidRelaxed = true;
    onWarning?.({
      code: 'BREAK_AVOID_RELAXED',
      message:
        'A CSS break-avoid preference could not fit on one page and was relaxed; native text, images and table rows remain indivisible.',
    });
  }
  // Required CSS cuts take precedence over any soft interval containing that boundary.
  const preferred: Bounds[] = [];
  for (const bounds of snapshot.avoidBreakBounds ?? []) {
    assertInterval(bounds, snapshot.height, 'Preferred break-avoid');
    if (
      forcedBreaks.some(
        /** An explicit page break wins over an ancestor's avoid preference. */
        (position) => crosses(bounds, position),
      )
    )
      continue;
    if (bounds.height > contentHeight + BREAK_EPSILON) {
      warnAvoidRelaxed();
      continue;
    }
    preferred.push(bounds);
  }
  // Reuse the finite preference set while required bounds continue to govern every fallback cut.
  const protectedBounds = [...atomic, ...preferred];
  // The next slice always begins exactly where the previous slice ended.
  let start = 0;
  // Each required break is consumed once; natural pages may precede it.
  let forcedIndex = 0;
  while (start < snapshot.height) {
    // Ignore already consumed required cuts without producing zero-length pages.
    while (
      forcedBreaks[forcedIndex] !== undefined &&
      forcedBreaks[forcedIndex]! <= start + BREAK_EPSILON
    )
      forcedIndex += 1;
    // A required boundary ends the page only when it lies within the usable height.
    const forced = forcedBreaks[forcedIndex] ?? snapshot.height;
    // Atomic content is always respected, independently of optional avoidance preferences.
    const target = Math.min(start + contentHeight, forced, snapshot.height);
    // Forced cuts were globally checked against every intrinsic atomic interval above.
    const requiredEnd = atomicCut(target, start, atomic);
    // Moving preferences must never erase or pull back an explicit reachable CSS break.
    let end = requiredEnd;
    if (Math.abs(target - forced) > BREAK_EPSILON) {
      for (;;) {
        // Include required bounds again because an avoid shift can enter a preceding text line.
        const next = protectedBounds.reduce(
          /** Each intersected interval contributes a strictly earlier possible boundary. */
          (candidate, bounds) => (crosses(bounds, end) ? Math.min(candidate, bounds.y) : candidate),
          end,
        );
        if (next === end) break;
        if (next <= start + BREAK_EPSILON) {
          // Incompatible soft intervals relax together; the already validated atomic cut is safe.
          warnAvoidRelaxed();
          end = requiredEnd;
          break;
        }
        end = next;
      }
    }
    slices.push({ start, end });
    start = end;
  }
  return slices;
}
