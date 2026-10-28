import type { RegisteredFont, RenderPDFResult } from '../../src/index';

/** Fixed synthetic cases contain no uploaded documents or personal data. */
export const benchmarkCases = [
  { name: 'small-native', rows: 12, raster: false },
  { name: 'medium-native', rows: 96, raster: false },
  { name: 'large-native', rows: 384, raster: false },
  { name: 'medium-hybrid', rows: 96, raster: true },
] as const;

export interface BenchmarkSample {
  elapsedMs: number;
  pageCount: number;
  bytes: number;
  header: string;
  warningCodes: string[];
}

export interface BenchmarkFixture {
  select: (name: string) => { elements: number; rows: number; rasterRegions: number };
  run: () => Promise<BenchmarkSample>;
  lastBytes: () => number[];
}

declare global {
  interface Window {
    benchmark: BenchmarkFixture;
  }
}

/** Use the built package entry while keeping test type checking independent of dist/. */
async function initialize(): Promise<void> {
  const entry = '/dist/index.js';
  const library = (await import(/* @vite-ignore */ entry)) as typeof import('../../src/index');
  const response = await fetch('/fonts/NotoSans-Regular.ttf');
  if (!response.ok) throw new Error(`Benchmark font failed: ${response.status}`);
  const font: RegisteredFont = await library.registerFont({
    family: 'Benchmark Sans',
    data: await response.arrayBuffer(),
  });
  const source = document.querySelector<HTMLElement>('#source')!;
  let lastBytes: Uint8Array | undefined;
  window.benchmark = {
    select(name) {
      const scenario = benchmarkCases.find((candidate) => candidate.name === name);
      if (!scenario) throw new Error(`Unknown benchmark case: ${name}`);
      source.replaceChildren();
      const heading = document.createElement('h1');
      heading.textContent =
        'Synthetic document — Unicode \u0159\u00ed\u017e\u0165\u010d\u00fd\u016f\u0148';
      source.append(heading);
      const description = document.createElement('p');
      description.textContent = 'Selectable text, browser wrapping and automatic page boundaries.';
      source.append(description);
      if (scenario.raster) {
        const region = document.createElement('section');
        region.className = 'raster';
        region.textContent = 'Local raster region with an extraction-only text layer.';
        source.append(region);
      }
      for (let index = 0; index < scenario.rows; index += 1) {
        const row = document.createElement('div');
        row.className = 'row';
        for (const value of [
          String(index + 1).padStart(4, '0'),
          `Synthetic row ${index + 1}: AV To office, Unicode \u010d\u00e1\u00ed.`,
          `${(index + 1) * 17}.00`,
        ]) {
          const cell = document.createElement('span');
          cell.textContent = value;
          row.append(cell);
        }
        source.append(row);
      }
      return {
        elements: source.querySelectorAll('*').length + 1,
        rows: scenario.rows,
        rasterRegions: scenario.raster ? 1 : 0,
      };
    },
    async run() {
      const started = performance.now();
      const pdf: RenderPDFResult = await library.renderPDF(source, { fonts: [font] });
      const bytes = await pdf.toUint8Array();
      // Serialization across Playwright and independent inspection are excluded from export time.
      const elapsedMs = performance.now() - started;
      lastBytes = bytes;
      return {
        elapsedMs,
        pageCount: pdf.pageCount,
        bytes: bytes.length,
        header: new TextDecoder().decode(bytes.subarray(0, 5)),
        warningCodes: pdf.warnings.map((warning) => warning.code),
      };
    },
    lastBytes() {
      if (!lastBytes) throw new Error('Export a benchmark case before reading its PDF.');
      return Array.from(lastBytes);
    },
  };
}

void initialize();
