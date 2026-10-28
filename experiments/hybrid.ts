import './hybrid.css';
import { loadBrowserFont } from './browser-export';
import { renderPDF } from '../src/index';

/** Wire the combined hybrid/pagination demo through the public browser-only library. */
async function initializeHybrid(): Promise<void> {
  // Controls remain outside the document so status and disabled states cannot alter exported markup.
  const button = document.querySelector<HTMLButtonElement>('#hybrid-export')!;
  // One live region exposes setup errors, rendering diagnostics and successful downloads.
  const status = document.querySelector<HTMLElement>('#hybrid-status')!;
  // The original continuous document stays at its authored width throughout export.
  const source = document.querySelector<HTMLElement>('#hybrid-source')!;
  // Regular and bold programs are explicitly registered for matching browser/PDF typography.
  const fonts = await Promise.all([
    loadBrowserFont('/fonts/NotoSans-Regular.ttf', 'Noto Sans', 400),
    loadBrowserFont('/fonts/NotoSans-Bold.ttf', 'Noto Sans', 700),
  ]);
  button.disabled = false;
  status.textContent = 'Ready. Custom page: 500 × 460 CSS px, 20px margins.';
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Creating PDF…';
    try {
      // No data-raster markers or source mutations are needed for the automatic effects.
      const result = await renderPDF(source, {
        fonts,
        format: { width: 500, height: 460 },
        margin: 20,
        fallback: 'auto',
        pageBreak: 'css',
      });
      await result.download('renderpdf-hybrid-pages.pdf');
      // The count describes local fallback choices without implying pixel-identical typography.
      const regions = result.warnings.filter(
        (warning) => warning.code === 'RASTER_FALLBACK',
      ).length;
      status.textContent = `${result.pageCount} pages · ${regions} local raster regions. Text metrics remain approximate.`;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      button.disabled = false;
    }
  });
}

initializeHybrid().catch((error: unknown) => {
  // Bootstrap failures must remain visible rather than presenting an apparently ready button.
  document.querySelector<HTMLElement>('#hybrid-status')!.textContent = String(error);
});
