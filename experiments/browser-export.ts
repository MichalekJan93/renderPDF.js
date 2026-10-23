import type { RegisteredFont } from '../src/index';
import { registerFont } from '../src/index';

/** Load one explicit font program into both browser layout and the experiment font list. */
export async function loadBrowserFont(
  /** Same-origin or bundled font program location. */
  url: string,
  /** CSS family used by the measured document. */
  family: string,
  /** Explicit weight; synthetic browser styling is not admitted. */
  weight: 400 | 700,
  /** Explicit face style for browser/PDF matching. */
  style: 'normal' | 'italic' = 'normal',
): Promise<RegisteredFont> {
  // Browser and PDF receive the exact same font program bytes.
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Font could not be loaded: ${family} ${weight} ${style}.`);
  // Font data stays in this local browser session and is embedded directly in the PDF.
  const bytes = new Uint8Array(await response.arrayBuffer());
  return registerFont({ family, weight, style, data: bytes });
}
