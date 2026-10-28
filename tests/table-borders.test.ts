import { describe, expect, it } from 'vite-plus/test';
import { resolveCollapsedBorders } from '../src/table-borders';
import type { TableBorderCandidate } from '../src/table-borders';

/** Build one authored shared edge; fixtures supply geometry independently of the resolver. */
function edge(overrides: Partial<TableBorderCandidate> = {}): TableBorderCandidate {
  return {
    direction: 'horizontal',
    position: 20,
    start: 0,
    end: 100,
    width: 2,
    style: 'solid',
    color: 'rgb(10, 20, 30)',
    owner: 'cell',
    row: 0,
    column: 0,
    ...overrides,
  };
}

describe('native collapsed border conflicts', () => {
  it('paints the wider shared edge once at its original centerline and preserves its color', () => {
    // Neighboring cells provide competing sides, not two overlapping PDF strokes.
    expect(
      resolveCollapsedBorders([
        edge({ width: 2, color: 'rgb(0, 0, 255)' }),
        edge({ width: 6, color: 'rgba(255, 0, 0, 0.5)', row: 20 }),
      ]),
    ).toEqual([
      {
        kind: 'border',
        bounds: { x: 0, y: 17, width: 100, height: 6 },
        width: 6,
        color: 'rgba(255, 0, 0, 0.5)',
        direction: 'horizontal',
      },
    ]);
  });

  it('lets hidden suppress every width and treats none as absent', () => {
    // Hidden retains its suppression semantics even though browsers compute its width as zero.
    expect(
      resolveCollapsedBorders([edge({ width: 20 }), edge({ style: 'hidden', width: 0 })]),
    ).toEqual([]);
    expect(resolveCollapsedBorders([edge({ style: 'none', width: 0 }), edge()])).toHaveLength(1);
  });

  it('prefers a cell to an equal table border, then the top or inline-start cell', () => {
    // Color tie-breaking follows table element priority and table direction.
    const table = edge({ owner: 'table', color: 'table' });
    const upper = edge({ color: 'upper' });
    const lower = edge({ row: 20, color: 'lower' });
    expect(resolveCollapsedBorders([table, lower, upper])[0]!.color).toBe('upper');
    const left = edge({ direction: 'vertical', row: 20, column: 0, color: 'left' });
    const right = edge({ direction: 'vertical', row: 0, column: 20, color: 'right' });
    expect(resolveCollapsedBorders([right, left])[0]!.color).toBe('left');
    expect(resolveCollapsedBorders([right, left], 'rtl')[0]!.color).toBe('right');
  });

  it('splits a spanning side only where neighboring winners actually change', () => {
    // A rowspanning cell competes with two independently styled neighboring cells.
    const operations = resolveCollapsedBorders([
      edge({ direction: 'vertical', start: 0, end: 60, width: 2, column: 0 }),
      edge({ direction: 'vertical', start: 0, end: 30, width: 4, color: 'top', column: 20 }),
      edge({ direction: 'vertical', start: 30, end: 60, width: 6, color: 'bottom', column: 20 }),
    ]);
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ color: 'top', bounds: { x: 18, y: 0, width: 4, height: 30 } }),
        expect.objectContaining({
          color: 'bottom',
          bounds: { x: 17, y: 30, width: 6, height: 30 },
        }),
      ]),
    );
    expect(operations).toHaveLength(2);
  });

  it('extends the outer half-border through corners and partitions crossing alpha exactly once', () => {
    // Filled rectangles close the outer corner, while every shared pixel has exactly one owner.
    const operations = resolveCollapsedBorders([
      edge({ position: 0, start: 0, end: 100, width: 4, color: 'rgba(255, 0, 0, 0.5)' }),
      edge({
        direction: 'vertical',
        position: 0,
        start: 0,
        end: 100,
        width: 4,
        color: 'rgba(255, 0, 0, 0.5)',
      }),
    ]);
    expect(operations.some(({ bounds }) => bounds.x === -2 && bounds.y === -2)).toBe(true);
    for (let first = 0; first < operations.length; first += 1) {
      const bounds = operations[first]!.bounds;
      for (const other of operations.slice(first + 1)) {
        const width =
          Math.min(bounds.x + bounds.width, other.bounds.x + other.bounds.width) -
          Math.max(bounds.x, other.bounds.x);
        const height =
          Math.min(bounds.y + bounds.height, other.bounds.y + other.bounds.height) -
          Math.max(bounds.y, other.bounds.y);
        expect(Math.max(0, width) * Math.max(0, height)).toBe(0);
      }
    }
  });

  it('rejects invalid measured coordinates before creating PDF border paint', () => {
    expect(() => resolveCollapsedBorders([edge({ width: -1 })])).toThrow('finite and positive');
    expect(() => resolveCollapsedBorders([edge({ position: Number.NaN })])).toThrow(
      'finite and positive',
    );
    expect(() => resolveCollapsedBorders([edge({ end: 0 })])).toThrow('finite and positive');
  });
});
