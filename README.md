<p align="center">
  <img src="https://raw.githubusercontent.com/MichalekJan93/renderPDF.js/main/assets/renderpdf-logo.png" alt="RenderPDF.js logo" width="560" />
</p>

# RenderPDF.js

**Create PDFs from HTML, images or code, and merge or split existing PDFs.**

[![npm version](https://img.shields.io/npm/v/renderpdf-js)](https://www.npmjs.com/package/renderpdf-js)
[![CI](https://github.com/MichalekJan93/renderPDF.js/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/MichalekJan93/renderPDF.js/actions/workflows/check.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/MichalekJan93/renderPDF.js/blob/main/LICENSE)

RenderPDF.js is a JavaScript and TypeScript library for creating PDF documents,
converting HTML and images, and working with existing PDF pages. It runs locally,
without a conversion server.

HTML exports use the browser's layout, keep text selectable and split content
across pages. Document creation and PDF composition also work in Node.js,
without a DOM.

**Experimental.** The full browser suite targets Google Chrome. Focused HTML
export tests also pass in Microsoft Edge, Playwright Firefox and Playwright
WebKit, including PDF downloads, page mapping, selectable Unicode text and local
raster comparisons. A separate manual export passed in Safari 26.2. These are
bounded tests, not a general HTML/CSS compatibility guarantee. Supported behavior
and limits are [described below](#supported-scope).

## Features

- Create documents with text, images, vector graphics, links and form fields.
- Merge PDFs, extract selected pages and split documents without rasterizing them.
- Export supported HTML/CSS with selectable text and automatic pagination.
- Convert PNG/JPEG and multipage TIFF files to PDF.
- Add repeated table headers, page text, page numbers and document properties.
- Use the DevExtreme PDF exporter through an optional compatibility adapter.
- ESM package with TypeScript declarations, cancellation and conversion progress.

See the [API guide](https://github.com/MichalekJan93/renderPDF.js/blob/main/API.md)
for methods, coordinate conventions and compatibility limits.
The [changelog](https://github.com/MichalekJan93/renderPDF.js/blob/main/CHANGELOG.md)
records what changed in each published version, where and why.

## Getting started

```sh
npm install renderpdf-js
```

For browser applications, use an ESM bundler such as Vite.
The [playground](https://github.com/MichalekJan93/renderPDF.js/tree/main/playground)
provides HTML upload/editing, JSON options, a live preview, export diagnostics
and timed RenderPDF.js/jsPDF comparisons from a source checkout.

## Measured HTML comparison

We compared the [source build at `78fe8c1`](https://github.com/MichalekJan93/renderPDF.js/commit/78fe8c1f03be721dc6b0d5a88e1f1bfd0cadd885)
with jsPDF 4.2.1 `html()` in headless Brave 147 on one Apple M4 Pro (October 2026).
Both used A4, 24 CSS px margins and the same explicit font bytes for each input.
Times are medians of five exports through Blob serialization; bold marks the
better measured result.

| Test                                                                                           |           RenderPDF.js |                  jsPDF |
| ---------------------------------------------------------------------------------------------- | ---------------------: | ---------------------: |
| 24 short fixtures (up to 4 pages): faster median                                               |              **21/24** |                   3/24 |
| 24 short fixtures: smaller PDF                                                                 |              **22/24** |                   2/24 |
| 16 one-page fixtures: closer browser pixels                                                    |              **16/16** |                   0/16 |
| [200-row directory](playground/src/examples/example-1.html): time / PDF bytes                  |     1.21 s / 405,837 B | **0.68 s / 320,758 B** |
| [1,000-row inventory](playground/src/examples/example-2.html), matched fonts: time / PDF bytes | 1.74 s / **415,956 B** | **1.64 s** / 620,478 B |

Both exporters retained all 460 text markers in the short documents, although
marker page placement differed in four. The longer examples were separate runs:
PDF.js found all 200 complete directory IDs and 1,000 complete inventory names
in RenderPDF.js output, while one ID and one name were incomplete in the inspected
jsPDF outputs. The visual count covers only one-page cases compared at equal scale.
These are results for the linked source build and these fixtures on one machine;
that build has not yet been published to npm.

## Create a document

```ts
import { createDocument } from 'renderpdf-js';

const document = await createDocument({ unit: 'mm', format: 'A4' });
const page = document.addPage();
page.drawText('Invoice', { x: 20, y: 25, fontSize: 18 });
page.drawRectangle({ x: 20, y: 35, width: 170, height: 20, stroke: '#333333' });

const pdf = await document.toResult();
await pdf.download('invoice.pdf');
```

Coordinates start at the top-left; text `y` is its baseline. Font sizes always use
points. The document API works without a DOM. Built-in Helvetica, Times and Courier
cover basic text; provide TTF/OTF bytes in `fonts` for characters outside their
limited sets. Fonts accept bytes, bare base64 or a font data URL. A variable TTF is
accepted only at its upright default axes and declared default weight. Fonts are
prepared before drawing. After `toResult()`, the document is
immutable.

Use `pdf.toUint8Array()` or `pdf.toBlob()` outside the browser; `download()` is a
browser action.

## Combine and split PDFs

```ts
import { mergePDFs, extractPDFPages, splitPDF } from 'renderpdf-js';

const combined = await mergePDFs([firstFile, secondFile], { flattenForms: true });
await combined.download('combined.pdf');

const selected = await extractPDFPages(firstFile, [3, 1]);
const individualPages = await splitPDF(firstFile);
```

Inputs can be `File`/`Blob`, `ArrayBuffer`, `Uint8Array` or a completed export result.
Page numbers are one-based. Pages retain their native text, vectors, sizes and
rotation. `flattenForms: true` turns ordinary prepared AcroForm appearances into
page paint before composition; the default still rejects interactive fields. XFA,
signed, encrypted PDFs and unsupported destinations fail explicitly. Flattening
removes interactivity. Document-level bookmarks, signatures and
metadata are not merged. See the [composition limits](https://github.com/MichalekJan93/renderPDF.js/blob/main/API.md#pdf-composition).

## DevExtreme integration

`createJsPDFAdapter()` provides the synchronous drawing and text measurement
contract used by the DevExtreme PDF exporter. Supply fonts when creating it, pass
the result as `jsPDFDocument`, then **await** `save()` or `output('blob')`.
The adapter covers the tested exporter contract; it does not emulate every jsPDF
plugin or its synchronous serialization. The [API guide](https://github.com/MichalekJan93/renderPDF.js/blob/main/API.md#devextreme-adapter)
includes an example and the optional integration test command. DevExtreme is not
a dependency of this library.

## HTML usage

Select a connected element and export it. Font files are optional:

```ts
import { renderPDF } from 'renderpdf-js';

const source = document.querySelector<HTMLElement>('#invoice');
if (!source) throw new Error('Invoice element was not found.');

const pdf = await renderPDF(source, {
  format: 'A4',
  margin: 24,
});

for (const warning of pdf.warnings) {
  if (warning.code === 'FONT_SUBSTITUTED') console.warn(warning.message);
}
await pdf.download('invoice.pdf');
```

Without `fonts`, the library bundles the licensed `RenderPDF Base` Noto Sans
regular, bold and italic faces ([SIL OFL license](assets/NotoSans-OFL.txt)).
If the source requests a face outside this base family or its available
weights and styles, export continues and returns a `FONT_SUBSTITUTED` warning
in both `pdf.warnings` and `onWarning`. This is a diagnostic for the application,
not a thrown error.

A connected source keeps its browser layout: substituted PDF glyph widths and
wrapping can differ from the visible element. Use `renderHTML` when a copied
document may be laid out again with the substitute face. If a substituted
text node is inside a raster region, direct `renderPDF` rejects with
`RASTER_FAILED` instead of combining a bitmap in the original font with PDF
text in the substitute font; `renderHTML` can relayout its isolated copy.

For `renderPDF`, the bundled fallback registers up to three reusable `FontFace`
objects in the source document's `FontFaceSet` for that document's lifetime;
the source DOM is unchanged. `renderHTML` owns a temporary iframe and releases
its font registrations when the export finishes.

For exact font output, supply licensed TTF/OTF bytes and ensure the source CSS
uses the same family. Choose `fontMismatch: 'error'` to reject any missing face:

```ts
import { registerFont, renderPDF } from 'renderpdf-js';

const source = document.querySelector<HTMLElement>('#invoice');
if (!source) throw new Error('Invoice element was not found.');
const response = await fetch('/fonts/MyFont-Regular.ttf');
if (!response.ok) throw new Error('The document font could not be loaded.');
const regular = await registerFont({
  family: 'Document Sans',
  data: await response.arrayBuffer(),
});
const pdf = await renderPDF(source, {
  fonts: [regular],
  fontMismatch: 'error',
});
```

Register every family and style used by the source, including italic faces.
Available static weights follow CSS nearest-face matching: a requested weight of
`600` can select a registered `700` face. A regular-only family does not silently
stand in for bold or italic text: strict mode throws `MISSING_FONT`, while
fallback mode reports `FONT_SUBSTITUTED`. TTF/OTF data can be bytes, bare base64
or a font data URL. Variable TTF files are supported only at their upright
default axes and declared default weight; other axis values, system fonts,
WOFF/WOFF2 and font collections remain unsupported. Disable optical sizing for
a variable font with an `opsz` axis so browser and PDF outlines use the same
instance. The selected face must contain every character in its text run;
there is no automatic per-glyph fallback. A missing character fails with
`MISSING_GLYPH`, even in font fallback mode.

Keep the source connected and unchanged during export. `registerFont({ ..., document:
source.ownerDocument })` registers a face in an iframe's own `FontFaceSet`; the same
handles belong in that source's `renderPDF` options. The default preserves source
width and fails when it exceeds the page's content width (about **745.7 CSS
pixels** for A4 with default margins). `fit: 'width'` instead keeps the browser's
original wrapping and uniformly reduces PDF paint and page mapping.

### Convert an HTML string

`renderHTML(fullHtmlDocument)` also works without font files. It creates a
temporary isolated document and lays it out with the bundled base face when a
requested CSS family is unavailable. To supply exact fonts, page bands and
layout options:

```ts
import { renderHTML } from 'renderpdf-js';

const pdf = await renderHTML(fullHtmlDocument, {
  fonts: [{ family: 'Document Sans', data: fontBytes }],
  sourceWidth: 1200,
  fit: 'width',
  orientation: 'auto',
  fontFallback: 'Document Sans',
  header: { height: 36, html: '<div style="font-family:Document Sans">Account statement</div>' },
  footer: { height: 28, left: 'Printed by: Example', right: 'Page {pageNumber}/{pageCount}' },
});
```

The default `isolation: 'iframe'` accepts a full HTML document. Use
`isolation: 'shadow'` for a fragment. Both run in a temporary sandboxed iframe;
their DOM and font faces are released after export. `sourceWidth` is the browser
layout width before PDF fitting. In fallback mode, `renderHTML` changes the
copied elements' CSS family before browser layout and reports `FONT_SUBSTITUTED`.
This cannot preserve an unprovided system font such as Tahoma. With supplied
fonts, `fontFallback` selects a registered substitute family. HTML header/footer
fragments live in separate shadow roots: include their CSS inline or in each fragment. Scripts,
frames, templates, customized built-ins, active attributes and refresh metadata
are rejected. Ordinary image and CSS URLs may still trigger browser requests.

## Standalone image files

`imageToPDF` accepts a `File`, `Blob`, `ArrayBuffer` or `Uint8Array`. It detects
the format from the file contents and requires no HTML element or fonts.

```ts
import { imageToPDF } from 'renderpdf-js';

const fileInput = document.querySelector<HTMLInputElement>('#image');
const file = fileInput?.files?.[0];
if (!file) throw new Error('Select a PNG, JPEG or TIFF file.');

const pdf = await imageToPDF(file, { format: 'A4', margin: 24 });
await pdf.download('document.pdf');
```

PNG and JPEG produce one page. Each main TIFF frame produces a page in file order.
Images are centered and scaled to fit within the margins, preserving their aspect
ratio; small images can be enlarged. TIFF/EXIF orientations, including mirrored
orientations and PNG `eXIf`, are applied. JPEG compressed bytes are preserved.
Image text remains a bitmap; there is no OCR.

See [image format limits](#image-format-limits) for supported TIFF profiles.
TIFF support applies to this API; HTML `<img>` elements accept PNG/JPEG.

## API parameters

The tables list public conversion and document settings, accepted values and
defaults. HTML and standalone-image dimensions use **CSS pixels**:
`1 px = 0.75 PDF pt`. Custom paper dimensions include margins. Document drawing
uses its selected `unit`; font sizes in that API always use points.
Required values have no implicit substitute.

### `renderPDF(element, options)`

| Name                 | Info                                                                                            | Allowed settings                                                                                                      | Default setting                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `element`            | Existing browser layout. Keep it connected and stable until completion.                         | Positive-size `HTMLElement`, including one in an accessible same-origin iframe.                                       | Required.                                                               |
| `fonts`              | Exact faces used by source text and page bands.                                                 | Array of `registerFont()` handles belonging to the source document.                                                   | Bundled `RenderPDF Base` Noto Sans faces.                               |
| `fontMismatch`       | Missing CSS face policy; fallback returns `FONT_SUBSTITUTED`, error throws `MISSING_FONT`.      | `'fallback'` or `'error'`.                                                                                            | `'fallback'` without fonts or with `fontFallback`; otherwise `'error'`. |
| `fontFallback`       | Preferred substitute family in fallback mode; direct DOM layout remains unchanged.              | Family included in `fonts`, or bundled `RenderPDF Base`.                                                              | Bundled `RenderPDF Base` when fallback is selected.                     |
| `format`             | Paper size including margins.                                                                   | `'A4'`, `'A3'`, `'Letter'`, or `{ width, height }` with finite positive CSS-pixel dimensions.                         | `'A4'`.                                                                 |
| `orientation`        | Selects paper axes without reflowing the source.                                                | `'portrait'`, `'landscape'`, or `'auto'` based on measured source width.                                              | `'portrait'`.                                                           |
| `margin`             | Empty edges; must leave a positive content area.                                                | Finite nonnegative number, or `{ top, right, bottom, left }` in CSS pixels.                                           | `24` on each edge.                                                      |
| `fit`                | Uniformly shrinks wide content and page mapping, retaining browser wrapping.                    | `'none'` or `'width'`.                                                                                                | `'none'`; excess width rejects.                                         |
| `pageBreak`          | Controls supported authored CSS fragmentation hints.                                            | `'css'` or `'auto'` for geometry alone.                                                                               | `'css'`.                                                                |
| `repeatTableHeaders` | Repeats supported native `thead` on continuation pages.                                         | `true` or `false`.                                                                                                    | `false`.                                                                |
| `header`             | Reserves an additional repeated band above body content.                                        | Text line, text slots or connected HTML; see band fields below.                                                       | Omitted.                                                                |
| `footer`             | Reserves an additional repeated band below body content.                                        | Same forms as `header`.                                                                                               | Omitted.                                                                |
| `fallback`           | Controls automatic selection of safe local raster regions.                                      | `'auto'` or `'strict'`; strict requires explicit `data-raster` for effects needing capture.                           | `'auto'`.                                                               |
| `strictCss`          | Rejects selected unsupported decoration instead of omitting it; independent of raster planning. | `true` or `false`. Default omission covers outer shadows and unsupported table-part backgrounds.                      | `false`.                                                                |
| `rasterScale`        | Raster pixels per CSS pixel in local regions.                                                   | Finite positive number, also bounded by each capture's dimensions and pixel budget.                                   | `2`.                                                                    |
| `verifySource`       | Checks that source styles and geometry stay stable.                                             | `'full'` or `'mutations'`; mutations skips CSSOM/computed-style fingerprints and emits `SOURCE_VERIFICATION_REDUCED`. | `'full'`.                                                               |
| `metadata`           | Copies PDF document properties before asynchronous work.                                        | Metadata object below.                                                                                                | Title `'RenderPDF.js'`; other fields omitted.                           |
| `signal`             | Cooperative cancellation between export stages.                                                 | `AbortSignal`.                                                                                                        | Omitted.                                                                |
| `onWarning`          | Observes diagnostic records also retained in the result.                                        | Synchronous `(warning: RenderWarning) => void`.                                                                       | Omitted; no console logging.                                            |
| `onProgress`         | Reports stage-local work counts, not elapsed-time percentages.                                  | Synchronous `({ stage, completed, total }) => void`.                                                                  | Omitted.                                                                |

`strictCss: false` does not promise support for arbitrary CSS. Supported table
borders still render natively. Unsafe layout, missing glyphs and invalid
resources still reject. Missing CSS faces reject in `fontMismatch: 'error'` mode;
fallback mode reports the substituted face and keeps caller-owned DOM layout.
Substituted text inside a raster region rejects with `RASTER_FAILED` for a
connected source; use `renderHTML` to relayout a copy before raster capture.
Set `strictCss: true` when omitted decoration must fail. Use `fallback`
separately to control local raster planning.

### `renderHTML(html, options)`

Accepts the `renderPDF` settings above, with these differences and additions.
The temporary isolated document and its font faces are released after export.

| Name               | Info                                                                                                          | Allowed settings                                                             | Default setting                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `html`             | HTML to parse and lay out. Active markup rejects.                                                             | Nonempty HTML string; full document in iframe mode, fragment in shadow mode. | Required.                                                                            |
| `fonts`            | Programs registered inside the temporary document.                                                            | Array of font sources below, without `document`.                             | Bundled `RenderPDF Base` Noto Sans faces.                                            |
| `isolation`        | Document parsing or shadow-root fragment; both use a sandboxed iframe.                                        | `'iframe'` or `'shadow'`.                                                    | `'iframe'`.                                                                          |
| `sourceWidth`      | Browser layout width before PDF fitting.                                                                      | Finite positive CSS-pixel number, at most `32768`.                           | Printable width rounded down; `'auto'` orientation uses portrait for initial layout. |
| `fontFallback`     | Selects a substitute family in fallback mode; copied elements are laid out again and emit `FONT_SUBSTITUTED`. | A family supplied in `fonts`, or bundled `RenderPDF Base`.                   | Bundled `RenderPDF Base` when fallback is selected.                                  |
| `header`, `footer` | Repeated bands in the isolated document.                                                                      | Text line or slots without a `font` handle, or `{ html, height }`.           | Omitted.                                                                             |

### `registerFont(source)` and font sources

| Name       | Info                                                                                                                               | Allowed settings                                                                        | Default setting           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------- |
| `family`   | Explicit CSS family used by the source.                                                                                            | Nonempty supported name; generic families and CSS descriptor injection reject.          | Required.                 |
| `data`     | Exact licensed font program; input bytes are copied.                                                                               | `Uint8Array`, `ArrayBuffer`, bare base64 or font data URL containing supported TTF/OTF. | Required.                 |
| `weight`   | Declared face weight for font selection.                                                                                           | Integer `1`–`1000`; variable TTF must declare the upright default instance's weight.    | `400`.                    |
| `style`    | Declared face style.                                                                                                               | `'normal'` or `'italic'`; variable TTF supports its upright default instance only.      | `'normal'`.               |
| `document` | Browser document whose `FontFaceSet` owns the registration. Not used by document drawing or accepted by `renderHTML` font sources. | `Document`, usually `element.ownerDocument`.                                            | Current browser document. |

System fonts, WOFF/WOFF2, collections and nondefault variable axes are unsupported.
Register every used face for exact output. Static weight selection follows CSS
nearest-face matching within the registered family; missing glyphs still reject.

### Header and footer fields

Each band uses one content form: `text`, `left`/`center`/`right`,
`element` for `renderPDF`, or `html` for `renderHTML`.

| Name                      | Info                                                                  | Allowed settings                                                                                                     | Default setting                    |
| ------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `height`                  | Reserved CSS-pixel height in addition to the outer margin.            | Finite positive number fitting the band content and leaving positive body space.                                     | Required for a band.               |
| `text`                    | One selectable line with page placeholders expanded after pagination. | String; optional `{pageNumber}` and `{pageCount}`.                                                                   | Required for the single-line form. |
| `left`, `center`, `right` | Independent lines at the corresponding horizontal positions.          | One or more strings with the same page placeholders; lines must not overlap.                                         | Omitted slots are empty.           |
| `font`                    | Exact registered text-band face in `renderPDF`.                       | A handle included in `fonts`.                                                                                        | First registered face.             |
| `fontSize`                | Text-band character size in CSS pixels.                               | Finite positive number.                                                                                              | `12`.                              |
| `align`                   | Alignment of the `text` form.                                         | `'left'`, `'center'` or `'right'`.                                                                                   | `'left'`.                          |
| `element`                 | Static HTML measured once and repeated as PDF paint.                  | Connected `HTMLElement` in the source document, outside the source subtree, fitting printable width and band height. | Required for connected HTML.       |
| `html`                    | Isolated fragment with its own inline styles; `renderHTML` only.      | Nonempty inert HTML; page placeholders are not expanded in HTML.                                                     | Required for HTML strings.         |

### `imageToPDF(source, options?)`

| Name          | Info                                                        | Allowed settings                                                                     | Default setting         |
| ------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------- |
| `source`      | Encoded image; main TIFF frames retain file order.          | `File`/`Blob`, `ArrayBuffer` or `Uint8Array` containing supported PNG, JPEG or TIFF. | Required.               |
| `format`      | Paper size in CSS pixels.                                   | Same as `renderPDF.format`.                                                          | `'A4'`.                 |
| `orientation` | Paper axes.                                                 | `'portrait'` or `'landscape'`.                                                       | `'portrait'`.           |
| `margin`      | Space around centered, proportionally fitted image content. | Same as `renderPDF.margin`.                                                          | `24` on each edge.      |
| `metadata`    | New PDF properties.                                         | Metadata object below.                                                               | Title `'RenderPDF.js'`. |
| `signal`      | Cancels between reading, decoding, embedding and writing.   | `AbortSignal`.                                                                       | Omitted.                |
| `onProgress`  | Stage-local counters; omits HTML `layout`/`pagination`.     | Synchronous progress callback.                                                       | Omitted.                |

### Metadata fields

Apply to HTML/image conversion, document creation and PDF composition.

| Name       | Info                               | Allowed settings           | Default setting   |
| ---------- | ---------------------------------- | -------------------------- | ----------------- |
| `title`    | Human-readable document title.     | Unicode string.            | `'RenderPDF.js'`. |
| `author`   | Author in PDF properties.          | Unicode string.            | Omitted.          |
| `subject`  | Subject in PDF properties.         | Unicode string.            | Omitted.          |
| `keywords` | Search terms copied before export. | Readonly array of strings. | Omitted.          |

### `createDocument(options?)` and `createJsPDFAdapter(options?)`

| Name          | Info                                                                    | Allowed settings                                                    | Default setting                               |
| ------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------- |
| `unit`        | Coordinate/dimension unit; font sizes remain points.                    | `'pt'`, `'mm'` or `'px'`.                                           | `'pt'` for documents; `'mm'` for the adapter. |
| `format`      | Default paper inherited by new pages; custom values use document units. | `'A4'`, `'A3'`, `'Letter'`, or finite positive `{ width, height }`. | `'A4'`.                                       |
| `orientation` | Default axes, overridable on each page.                                 | `'portrait'` or `'landscape'`.                                      | `'portrait'`.                                 |
| `fonts`       | Additional faces prepared before drawing and synchronous measurement.   | Font sources with `family`, `data` and optional `weight`/`style`.   | Built-in Helvetica, Times and Courier faces.  |
| `metadata`    | New PDF properties.                                                     | Metadata object above.                                              | Title `'RenderPDF.js'`.                       |
| `signal`      | Cooperative cancellation during preparation and serialization.          | `AbortSignal`.                                                      | Omitted.                                      |

`createDocument` starts without pages; the adapter creates one initial page.
`addPage()` and `insertPage()` accept `format` and `orientation` overrides and
otherwise inherit document defaults. See the
[API guide](https://github.com/MichalekJan93/renderPDF.js/blob/main/API.md)
for drawing, fields, graphics state and tested adapter methods.

### `mergePDFs`, `extractPDFPages` and `splitPDF`

| Name                 | Info                                                                                         | Allowed settings                                                                | Default setting                                     |
| -------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| `sources` / `source` | Existing PDF input; caller fetches URLs. Merge takes an array; extract/split take one input. | `File`/`Blob`, `ArrayBuffer`, `Uint8Array` or result exposing `toUint8Array()`. | Required.                                           |
| `pageNumbers`        | Extraction order, retaining duplicates.                                                      | Nonempty array of valid one-based page numbers.                                 | Required for extraction; merge/split use all pages. |
| `flattenForms`       | Paints prepared ordinary AcroForm appearances before copying, removing interactivity.        | `true` or `false`; signed/XFA forms still reject.                               | `false`; interactive fields reject.                 |
| `metadata`           | New properties; source properties are not merged.                                            | Metadata object above.                                                          | Title `'RenderPDF.js'`.                             |
| `signal`             | Cancels between loading, copying and saving.                                                 | `AbortSignal`.                                                                  | Omitted.                                            |
| `onProgress`         | Stage-local preparation/resources/pages/saving/complete counters.                            | Synchronous progress callback.                                                  | Omitted.                                            |

See the [composition guide](https://github.com/MichalekJan93/renderPDF.js/blob/main/API.md#pdf-composition)
for input and structural limits.

### Result output

| Name                  | Info                                                     | Allowed settings                                            | Default setting                     |
| --------------------- | -------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------- |
| `download(filename?)` | Browser download of completed bytes without rerendering. | Nonempty filename without separators or control characters. | `'document.pdf'`.                   |
| `toBlob()`            | Returns a Blob from completed bytes.                     | No parameters.                                              | MIME type `'application/pdf'`.      |
| `toUint8Array()`      | Returns a defensive copy of completed bytes.             | No parameters.                                              | New independent array on each call. |

`pageCount` and `warnings` are read-only result metadata. Callback exceptions
reject the export; cooperative cancellation rejects with `AbortError`.

### Repeated table headers, headers and footers

```ts
const pdf = await renderPDF(source, {
  fonts: [regular],
  repeatTableHeaders: true,
  header: { text: 'Account statement', height: 32 },
  footer: { height: 28, left: 'Printed by: Example', right: 'Page {pageNumber} of {pageCount}' },
});
await pdf.download('statement.pdf');
```

Header and footer `height` is required and reserves space **in addition to** the
outer margins. Existing `{ text, height, align? }` usage still works. To draw
independent selectable text, supply `left`, `center` and/or `right`; each uses the
shared `font` (first registered face by default) and `fontSize` (default `12`).
`{pageNumber}` and `{pageCount}` expand after pagination. Lines cannot wrap or
overlap; a band too small for its content fails explicitly.

For custom HTML, connect a separate `HTMLElement` in the source's document and
pass `{ element, height }`. It must be outside the main source subtree and fit the
printable width and reserved height. The renderer measures this element through
the same supported HTML pipeline once, then repeats its PDF text and paint on each
page. `renderHTML` also accepts `{ html, height }` strings for bands as shown above.
HTML bands are static across pages; use a text slot for page-number placeholders.
Custom CSS remains subject to the [supported scope](#supported-scope).

### Export progress and document properties

```ts
const pdf = await renderPDF(source, {
  fonts: [regular],
  metadata: { title: 'Account statement', author: 'Example Company' },
  onProgress: ({ stage, completed, total }) => {
    console.log(stage, completed, total);
  },
});
```

Counters describe work within the current stage, rather than elapsed-time
percentages. HTML stages are `preparing`, `layout`, `pagination`, `resources`,
`pages`, `saving` and `complete`. Image conversion omits `layout` and `pagination`.
Callbacks are synchronous; a thrown callback error rejects the export. Cancellation
is cooperative between stages and rejects with `AbortError`, without a partial PDF.

## Output and errors

Both functions return the same result:

```ts
await pdf.download('document.pdf');
const blob = await pdf.toBlob();
const bytes = await pdf.toUint8Array();
console.log(pdf.pageCount, pdf.warnings);
```

These output methods reuse the completed PDF. `RenderPDFError`, exported from the
package, exposes a `code` and `message` for conversion failures. Warnings are
available through `onWarning` for HTML exports and `pdf.warnings`. Unsupported
input still fails explicitly when it cannot be represented safely. A missing CSS
face throws `MISSING_FONT` in `fontMismatch: 'error'` mode; fallback mode returns
`FONT_SUBSTITUTED` through the warning channels and completes if the substitute
contains the required glyphs. `MISSING_GLYPH` remains an error in either mode.
With the default
`strictCss: false`, selected unsupported decoration is omitted as described above.

## Supported scope

HTML rendering supports static blocks, inline content, nonoverlapping Flexbox and
Grid layouts, horizontal text in the scripts listed below, solid backgrounds,
uniform solid borders, simple rounded solid boxes and native tables with
`rowspan` and `colspan`.

### Text and languages

Horizontal HTML text is verified in Chromium with selectable PDF text for these
scripts when the bundled or supplied font covers the characters used:

- [x] Latin script, including diacritics
- [x] Cyrillic script
- [x] Chinese Han text, including line breaks without spaces
- [x] Arabic text without vowel marks, including right-to-left and mixed-direction runs

Set the source text's `lang` and `dir` where needed, and register suitable font
faces for each CSS `font-family`. Other scripts have not been verified. Vertical
writing modes are unsupported. HTML export subsets registered TrueType font
programs to the glyphs used in the PDF. OpenType/CFF fonts are embedded in full;
a large Chinese CFF font can therefore substantially increase PDF size. The
programmatic document API requests subsetting for embedded fonts.
Arabic vowel marks render, but PDF text extraction can move a mark around a
ligature; vocalized Arabic is not yet covered by the selectable-text guarantee.

PNG/JPEG resources can use data, blob, same-origin or CORS-readable URLs. External
images may be fetched by the browser; documents are never sent to a conversion
service. Freshly fetched image bytes receive the same structural, dimension and
PNG decompression checks as standalone image input. PNG/JPEG orientation in HTML
must be absent or `1`; normalize rotated pixels before using an `<img>` element.

Simple rounded boxes with a solid background and uniform solid border are drawn
as PDF paths, keeping descendant text selectable. Rounded boxes with other
effects, gradients, inline bitmap backgrounds, inset shadows and opacity can use
local raster fallback on supported rectangular blocks. `data-raster` selects a
region explicitly. Regions are captured once in paint order; descendant text gets
an extraction layer where safe. Raster resources must be inline bitmaps;
responsive images (`<picture>`, `<source>` and `img[srcset]`), external resources,
transforms and backdrop effects are unsupported. Outer shadows on native elements
and selected raster roots are omitted by default; `strictCss: true` rejects them.
Outer shadows on descendants inside an existing raster region still reject.
WebKit's SVG image painter drops inset box shadows. The raster fallback preserves
a single sharp, rectangular inset stroke without an existing border by painting
an equivalent inner outline in its temporary clone. Other inset shadows in
WebKit, including blurred, layered or descendant inset shadows, fail with
`RASTER_FAILED` rather than silently producing incomplete pixels.
Inline event handlers and custom elements, including customized built-ins, are
rejected before capture so cloning cannot repeat their application callbacks.
Wrapped inline backgrounds or borders require a containing raster region; inline
and table-internal raster boundaries are unsupported.

### Pagination and tables

The default `pageBreak: 'css'` respects block/table-row `break-before: page`,
`break-after: page`, their legacy `page-break-*: always` aliases and
`break-inside: avoid/avoid-page`. Before/after avoidance keeps adjacent complete
block siblings together when they fit.

Text lines, images, raster regions, table rows and spanning cells stay whole.
Content taller than a page, or a forced break through an indivisible item, fails
with `PAGINATION_FAILED`. An avoid preference that cannot be honored can be relaxed
with a `BREAK_AVOID_RELAXED` warning. Parity/column breaks, inline/cell break rules,
widow/orphan policies and cloned page decorations are unsupported.

<details>
<summary>Table restrictions</summary>

Collapsed tables support solid, none and hidden borders on cells and the outer
table, including different widths, colors and transparency. Shared borders are
painted once. Row, row-group, column and column-group border contributions, other
border styles, captions, nested collapsed tables and altered table-part display
modes are unsupported.

Repeated headers require a visible native `thead` followed by body rows. The
header reserves space on continuation pages and stays with the first body row.
Headers and rows must fit on a page. Nested tables, raster headers, overlapping
table ranges, header rowspans and cells spanning the header/body boundary are
unsupported. Header paint must fit its measured box. Table footers are not repeated.
Collapsed tables also require matching resolved horizontal borders at every
possible header/body continuation boundary.

</details>

### Text and layout limits

Default kerning, ligatures and combining marks are supported. Keep shaped text runs
in one text node; cross-inline ligatures and zero-width fragments are unsupported.
Custom font features/variants, stretched faces, font-size adjustment, automatic
hyphenation and soft hyphens are unsupported.
Exact text appearance can vary between shaping engines.

Arbitrary CSS stacking and overlapping paint are unsupported. Pause animations
and keep source styles, geometry and registered fonts stable during export.
Changes to the source fail with `SOURCE_CHANGED`. `verifySource: 'mutations'` is an
explicit faster mode that checks observed DOM/stylesheet mutations but can miss
CSSOM edits and computed-style-only changes; it emits
`SOURCE_VERIFICATION_REDUCED`.

### Image format limits

- **PNG:** static images only; APNG is rejected.
- **JPEG:** 8-bit baseline, extended and progressive grayscale, RGB or CMYK.
- **TIFF:** classic stripped TIFF in either byte order; common bilevel/grayscale,
  palette and 8-bit RGB/RGBA profiles. Compression: uncompressed, CCITT RLE/Group
  3/Group 4, LZW, PackBits and Deflate. Limited to **40 million pixels per frame**
  and **1,000 main frames**.

BigTIFF, tiled TIFF, SubIFDs/RAW layouts, planar-separated samples, 16-bit/float
samples and JPEG-compressed TIFF fail with `UNSUPPORTED_IMAGE`. The TIFF decoder
uses a bounded packed-raster implementation for CCITT runs; the remaining TIFF
codec/color-conversion dependency loads only when needed. Structural checks
reject malformed input, but cannot identify every damaged JPEG scan or all
possible unsupported image features.

### Existing PDF input limits

Composition checks the input container before the PDF backend loads it. Each
object/xref stream may expand to at most **2 MiB**, with **16 MiB** total decoded
structural streams, **100,000 structural entries**, **2 million container tokens**
and **64 levels of container nesting** per composition. Page and form ownership
trees must be acyclic, consistent and at most 64 levels deep. The existing
1,000-page and encoded-input limits also apply.

The supported profile requires a standalone PDF header line at byte zero,
unsigned decimal structural indexes, uppercase hexadecimal name escapes, direct
stream lengths and direct stream types when present. Object/xref streams support no filter or
one direct `FlateDecode` filter without decoding parameters. Indirect control
values, duplicate dictionary keys and unsupported structural filters fail with
`INVALID_SOURCE`. Some otherwise valid PDFs therefore need normalization by
their owner before composition.

Additional/chained page, annotation and form actions are rejected; copied URI
links support HTTP, HTTPS, mailto and tel only. Composition preserves PDF paint
and resources and is not a general sanitizer for every PDF viewer feature.

## Development

Use Node.js 22.18+ (22.x), 24.11+ (24.x) or 26+. `.node-version` records the
verified runtime.

```sh
npm ci
npm run build
npm run check
```

`npm run check` runs formatting, lint, types, unit tests, browser tests, build and
package checks. Google Chrome must be available for browser tests, either as an
installed app or through `RENDERPDF_CHROME_EXECUTABLE`. Vite+ provides
the development toolchain; Playwright and PDF.js are used for testing.
`npm run test:cross-browser` runs the focused Edge, Firefox and WebKit matrix;
its browser prerequisites and limits are in [tests/README.md](tests/README.md).

Run `npm run dev` to serve synthetic test fixtures. The independent
[playground](https://github.com/MichalekJan93/renderPDF.js/tree/main/playground)
tests the packaged library. See the
[benchmark guide](https://github.com/MichalekJan93/renderPDF.js/blob/main/BENCHMARKS.md)
for `npm run benchmark` and timing reports.

To create a local package, create `artifacts/` if needed, then run
`npm pack --pack-destination artifacts`. Only the library build, declarations,
package metadata, README, API guide, changelog, license and logo are packaged. Keep private documents
and generated files out of Git.

## License

[MIT](https://github.com/MichalekJan93/renderPDF.js/blob/main/LICENSE).
Third-party dependencies retain their own licenses: `utif2` uses MIT and `pako`
retains MIT/Zlib notices. Noto Sans, Noto Serif, Arabic and CJK test fonts retain the
[SIL Open Font License](https://github.com/MichalekJan93/renderPDF.js/blob/main/public/fonts/README.md)
and are not included in the npm package.

See [tests/README.md](tests/README.md) for commands, coverage by file, verification
methods and remaining coverage limits.
