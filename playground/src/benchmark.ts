import { jsPDF, type HTMLFontFace } from 'jspdf';
import {
  renderPDF,
  type RegisteredFont,
  type RenderPDFOptions,
  type RenderProgress,
  type RenderStage,
} from 'renderpdf-js';
import { contentWidthPx } from './preview';

// Registered handles own immutable bytes; avoid converting the same TTF on later comparisons.
const jsPdfFontData = new WeakMap<RegisteredFont, string>();

/** Provide jsPDF's public virtual filesystem with the exact registered TTF program. */
function binaryFontData(
  /** Face already registered from the same bytes for browser layout and RenderPDF.js. */
  font: RegisteredFont,
): string {
  const cached = jsPdfFontData.get(font);
  if (cached !== undefined) return cached;
  // The public handle returns a byte copy, so read it once for this conversion.
  const bytes = font.bytes;
  // jsPDF's HTML fontFaces path accepts TrueType, but does not add OpenType/CFF URLs.
  if (
    bytes.length < 4 ||
    new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0) !== 0x00010000
  ) {
    throw new Error('jsPDF HTML comparison requires TTF font files; OTF faces are unsupported.');
  }
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 16_384)));
  }
  const data = chunks.join('');
  jsPdfFontData.set(font, data);
  return data;
}

/** Measured wall time between the first and final progress notification for one stage. */
export interface RenderPhaseMeasurement {
  /** Public pipeline stage, excluding the completion notification. */
  stage: Exclude<RenderStage, 'complete'>;
  /** Elapsed time while this stage was reporting work. */
  durationMs: number;
}

/** Breakdown of a profiled RenderPDF.js export, including time outside reported stages. */
export interface RenderTimingBreakdown {
  /** Stages in pipeline order; any missing terminal notification is counted as other time. */
  phases: readonly RenderPhaseMeasurement[];
  /** Setup, work between stages, progress scheduling and final checks inside renderPDF(). */
  otherMs: number;
  /** Time spent converting the completed result to a browser Blob. */
  blobMs: number;
}

/** One completed browser export, measured through PDF byte serialization. */
export interface ExportMeasurement {
  /** Elapsed conversion time, excluding preview preparation and browser download handling. */
  durationMs: number;
  /** Serialized PDF bytes ready for a local download. */
  blob: Blob;
  /** Number of pages reported by the producing library. */
  pageCount: number;
  /** Diagnostics from RenderPDF.js, if available. */
  warnings: readonly { code: string; message: string }[];
  /** Optional stage timings; collecting progress notifications adds scheduling overhead. */
  timing?: RenderTimingBreakdown;
}

// RenderPDF.js reports these stages in order; completion has no measured work interval.
const renderPhaseOrder: readonly Exclude<RenderStage, 'complete'>[] = [
  'preparing',
  'layout',
  'pagination',
  'resources',
  'pages',
  'saving',
];

/** Export the connected preview through the installed RenderPDF.js package. */
export async function measureRenderPdf(
  /** The same laid-out source shown in the preview. */
  source: HTMLElement,
  /** Exact source faces only; an empty collection lets RenderPDF.js load its base font. */
  fonts: readonly RegisteredFont[],
  /** Validated JSON settings from the playground options editor. */
  options: RenderPDFOptions,
  /** Collect optional stage timings; off for the regular comparison. */
  profileStages = false,
): Promise<ExportMeasurement> {
  // Progress timings are opt-in because callbacks add browser scheduling to the conversion.
  const phaseStartsAtMs = new Map<RenderStage, number>();
  const phaseDurationsMs = new Map<RenderStage, number>();
  // Serialization is included; the download action is excluded for both libraries.
  const startedAtMs = performance.now();
  const result = await renderPDF(source, {
    ...options,
    // Omit the option entirely for documents such as Example 2 with no exact face.
    ...(fonts.length > 0 ? { fonts } : {}),
    ...(profileStages
      ? {
          onProgress(progress: RenderProgress): void {
            // Complete is a point notification; each work stage has a start and final count.
            if (progress.stage === 'complete') return;
            const observedAtMs = performance.now();
            if (progress.completed === 0 && !phaseStartsAtMs.has(progress.stage)) {
              phaseStartsAtMs.set(progress.stage, observedAtMs);
            }
            if (progress.completed === progress.total) {
              const phaseStartedAtMs = phaseStartsAtMs.get(progress.stage);
              if (phaseStartedAtMs !== undefined) {
                phaseDurationsMs.set(progress.stage, observedAtMs - phaseStartedAtMs);
              }
            }
          },
        }
      : {}),
  });
  // The library has finished PDF serialization before returning; Blob creation is separate.
  const renderedAtMs = performance.now();
  const blob = await result.toBlob();
  const finishedAtMs = performance.now();
  // Sum only completed intervals; all setup and unreported work remains in the other bucket.
  const phases = renderPhaseOrder.flatMap((stage): RenderPhaseMeasurement[] => {
    const durationMs = phaseDurationsMs.get(stage);
    return durationMs === undefined ? [] : [{ stage, durationMs }];
  });
  const phaseTotalMs = phases.reduce((sumMs, phase) => sumMs + phase.durationMs, 0);
  return {
    durationMs: finishedAtMs - startedAtMs,
    blob,
    pageCount: result.pageCount,
    warnings: result.warnings,
    ...(profileStages
      ? {
          timing: {
            phases,
            otherMs: Math.max(0, renderedAtMs - startedAtMs - phaseTotalMs),
            blobMs: finishedAtMs - renderedAtMs,
          },
        }
      : {}),
  };
}

/** Export the same styled preview through jsPDF's official HTML conversion plugin. */
export async function measureJsPdf(
  /** The preview wrapper includes its own stylesheet when jsPDF clones the element. */
  container: HTMLElement,
  /** Exact TTF faces used by the connected preview source. */
  fonts: readonly RegisteredFont[],
): Promise<ExportMeasurement> {
  // A4 and all margins match RenderPDF.js: 24 CSS px = 18 PDF pt.
  const startedAtMs = performance.now();
  const document = new jsPDF({
    orientation: 'portrait',
    unit: 'pt',
    format: 'a4',
    // Compress PDF streams and avoid embedding unused faces in the optimized baseline.
    compress: true,
    putOnlyUsedFonts: true,
  });
  // fontFaces may only name files visible to the same jsPDF instance; its VFS avoids URLs.
  const fontFaces = fonts.map((font, index) => {
    if (font.weight < 100 || font.weight > 900 || font.weight % 100 !== 0) {
      throw new Error(
        'jsPDF HTML comparison requires font face weights from 100 to 900 in steps of 100.',
      );
    }
    const name = `renderpdf-face-${index}.ttf`;
    document.addFileToVFS(name, binaryFontData(font));
    return {
      family: font.family,
      weight: font.weight as NonNullable<HTMLFontFace['weight']>,
      style: font.style,
      src: [{ url: name, format: 'truetype' as const }],
    };
  });
  await document.html(container, {
    // jsPDF applies margin to x/y itself; zero avoids counting the edge twice.
    x: 0,
    y: 0,
    margin: 18,
    width: contentWidthPx * 0.75,
    windowWidth: contentWidthPx,
    autoPaging: 'text',
    html2canvas: {
      logging: false,
      async onclone(clonedDocument: Document): Promise<void> {
        // html2canvas's iframe does not inherit programmatically loaded preview faces.
        // Register the same exact bytes there before it measures and paints the clone.
        for (const font of fonts) {
          const face = new FontFace(font.family, Uint8Array.from(font.bytes).buffer, {
            weight: String(font.weight),
            style: font.style,
          });
          await face.load();
          clonedDocument.fonts.add(face);
        }
        await clonedDocument.fonts.ready;
      },
    },
    // The same exact bytes and CSS descriptors used by the preview and RenderPDF.js.
    fontFaces,
  });
  const blob = document.output('blob');
  return {
    durationMs: performance.now() - startedAtMs,
    blob,
    pageCount: document.getNumberOfPages(),
    warnings: [],
  };
}
