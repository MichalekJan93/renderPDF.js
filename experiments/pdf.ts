import { renderDocument } from '../src/render-pdf';
import type { RegisteredFont } from '../src/api-types';

/** Internal geometry evidence used only by development comparisons. */
export type ExperimentResult = Awaited<ReturnType<typeof renderDocument>> & {
  /** Local browser export used by the original structural regression probe. */
  blob: Blob;
};

/** Preserve Phase 0 measurement hooks while exercising the actual reusable renderer. */
export async function runExperiment(
  /** Source region seen in the browser reference. */
  root: HTMLElement,
  /** Exact font handles shared by browser layout and PDF output. */
  fonts: readonly RegisteredFont[],
  /** Disable extraction-only text for independent visible-composition comparison. */
  includeRasterText = true,
): Promise<ExperimentResult> {
  // No second renderer lives in the experiment; only evidence and Blob creation are adapted.
  const output = await renderDocument(root, { fonts }, includeRasterText);
  return {
    ...output,
    blob: new Blob([Uint8Array.from(output.bytes)], { type: 'application/pdf' }),
  };
}
