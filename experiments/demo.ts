import './demo.css';
import { runExperiment } from './pdf';
import type { ExperimentResult } from './pdf';
import { snapshotLayout } from '../src/layout';
import { captureRaster } from '../src/raster';
import type { RegisteredFont } from '../src/index';
import { loadBrowserFont } from './browser-export';
import { renderPDF } from '../src/index';

/** Only the development demo exposes these hooks for independent browser tests. */
declare global {
  interface Window {
    /** Experimental browser integration hooks; not a package API. */
    phase0: {
      /** Register the same exact font programs at each conversion boundary. */
      fonts: RegisteredFont[];
      /** Run the controlled fixture, optionally omitting its invisible text. */
      run: (includeRasterText?: boolean) => Promise<ExperimentResult>;
      /** Inspect source coordinates without generating a PDF. */
      snapshotLayout: typeof snapshotLayout;
      /** Exercise bounded raster behavior independently. */
      captureRaster: typeof captureRaster;
    };
  }
}

/** Load explicit static font programs into the live browser before measurement. */
async function loadFonts(): Promise<RegisteredFont[]> {
  // Browser and PDF must receive exactly the same bytes and face descriptors.
  const definitions = [
    { file: 'Regular', weight: 400, style: 'normal' },
    { file: 'Bold', weight: 700, style: 'normal' },
    { file: 'Italic', weight: 400, style: 'italic' },
  ] as const;
  return Promise.all(
    definitions.map((definition) =>
      loadBrowserFont(
        `/fonts/NotoSans-${definition.file}.ttf`,
        'Noto Sans',
        definition.weight,
        definition.style,
      ),
    ),
  );
}

/** Install the self-contained bitmap and wire the browser-only experiment button. */
async function initialize(): Promise<void> {
  // All UI references remain outside the DOM subtree being exported.
  const source = document.querySelector<HTMLElement>('#source')!;
  const button = document.querySelector<HTMLButtonElement>('#export')!;
  const status = document.querySelector<HTMLElement>('#status')!;
  // A generated local PNG also verifies the native PDF image path without network assets.
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 40;
  // The bitmap's simple colors make missing or displaced images easy to measure.
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#db503a';
  context.fillRect(0, 0, 64, 40);
  context.fillStyle = '#204c8c';
  context.fillRect(24, 8, 32, 24);
  document.querySelector<HTMLImageElement>('#bitmap')!.src = canvas.toDataURL('image/png');
  // Register all faces before publishing integration hooks or enabling export.
  const fonts = await loadFonts();
  await document.fonts.ready;
  window.phase0 = {
    fonts,
    run: (includeRasterText = true) => runExperiment(source, fonts, includeRasterText),
    snapshotLayout,
    captureRaster,
  };
  button.disabled = false;
  status.textContent = 'Připraveno. Omezený Phase 0 experiment; nejde o obecný HTML renderer.';
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Vytváření PDF v prohlížeči…';
    try {
      // A Blob download exercises the complete browser path without a print dialog.
      const result = await renderPDF(source, { fonts });
      await result.download('renderpdf-phase0.pdf');
      status.textContent = `${result.pageCount} stránky, ${(await result.toUint8Array()).length.toLocaleString('cs')} bajtů. ${result.warnings.map((warning) => warning.message).join(' ')}`;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      button.disabled = false;
    }
  });
}

initialize().catch((error: unknown) => {
  // Surface font/bootstrap failures instead of leaving the demo in a loading state.
  document.querySelector<HTMLElement>('#status')!.textContent = String(error);
});
