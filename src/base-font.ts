import type { FontSource, RegisteredFont } from './api-types.js';
import regularData from './assets/fonts/NotoSans-Regular.ttf?url';
import boldData from './assets/fonts/NotoSans-Bold.ttf?url';
import italicData from './assets/fonts/NotoSans-Italic.ttf?url';

/** Distinct CSS family owned by the library's bundled, SIL OFL licensed Noto Sans faces. */
export const BASE_FONT_FAMILY = 'RenderPDF Base';

// Vite serves source assets by URL in development and inlines them in the npm build.
const requestedAssets = new Map<string, Promise<ArrayBuffer>>();

// A document owns its FontFaceSet, so repeated exports can reuse its exact registered handles.
const registeredDocuments = new WeakMap<Document, Promise<readonly RegisteredFont[]>>();

/** Return an inlined font program or load the development asset before registration. */
function baseFontData(
  /** Build-time data URL or same-origin development asset URL. */
  url: string,
  /** Public-boundary error constructor supplied without importing the core diagnostic module. */
  loadError: () => Error,
): string | Promise<ArrayBuffer> {
  if (url.startsWith('data:')) return url;
  let pending = requestedAssets.get(url);
  if (!pending) {
    pending = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error('Font asset request failed.');
        return response.arrayBuffer();
      })
      .catch(() => {
        requestedAssets.delete(url);
        throw loadError();
      });
    requestedAssets.set(url, pending);
  }
  return pending;
}

/** Register bundled static faces in the document that the browser will actually lay out.
 * @param fontDocument Source document; iframe exports must not register on their parent document.
 */
export async function loadBaseFonts(
  /** Browser document whose FontFaceSet owns these programs. */
  fontDocument: Document,
  /** Existing public registration boundary, passed in to keep this lazy chunk self-contained. */
  register: (source: FontSource) => Promise<RegisteredFont>,
  /** Typed font-load error supplied by the calling API boundary. */
  loadError: () => Error,
): Promise<readonly RegisteredFont[]> {
  const cached = registeredDocuments.get(fontDocument);
  if (cached) return cached;
  // Build-time asset inlining makes these data URLs independent of application paths and networks.
  const pending = Promise.all([
    baseFontData(regularData, loadError),
    baseFontData(boldData, loadError),
    baseFontData(italicData, loadError),
  ]).then(([regular, bold, italic]) =>
    Promise.all([
      register({
        family: BASE_FONT_FAMILY,
        data: regular,
        weight: 400,
        style: 'normal',
        document: fontDocument,
      }),
      register({
        family: BASE_FONT_FAMILY,
        data: bold,
        weight: 700,
        style: 'normal',
        document: fontDocument,
      }),
      register({
        family: BASE_FONT_FAMILY,
        data: italic,
        weight: 400,
        style: 'italic',
        document: fontDocument,
      }),
    ]),
  );
  registeredDocuments.set(fontDocument, pending);
  void pending.catch(() => registeredDocuments.delete(fontDocument));
  return pending;
}
