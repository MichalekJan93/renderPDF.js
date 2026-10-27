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

**Experimental.** HTML rendering is tested in Google Chrome; a basic export with
Czech text also passed in Microsoft Edge. Firefox and Safari have not been
verified. Supported HTML and CSS are [described below](#supported-scope).

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
provides an HTML editor, preview and PDF download from a source checkout.

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
cover basic text; provide TTF/OTF bytes in `fonts` for Czech and other Unicode
characters. Fonts accept bytes, bare base64 or a font data URL. A variable TTF is
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

Register a font, select an existing element and export it:

```ts
import { registerFont, renderPDF } from 'renderpdf-js';

// Supply a licensed static TTF/OTF file from your application.
const response = await fetch('/fonts/MyFont-Regular.ttf');
if (!response.ok) throw new Error('The document font could not be loaded.');

const regular = await registerFont({
  family: 'Document Sans',
  data: await response.arrayBuffer(),
});

const source = document.querySelector<HTMLElement>('#invoice');
if (!source) throw new Error('Invoice element was not found.');
source.style.fontFamily = 'Document Sans';

const pdf = await renderPDF(source, {
  fonts: [regular],
  format: 'A4',
  margin: 24,
});

await pdf.download('invoice.pdf');
```

Register every font family and style used by the source, including italic faces.
Available static weights follow CSS nearest-face matching: a requested weight of
`600` can select a registered `700` face. The first computed CSS font family must
still match a registered family. TTF/OTF data can be bytes, bare base64 or a font
data URL. Variable TTF files are supported only at their upright default axes and
declared default weight; other axis values, system fonts, WOFF/WOFF2 and font
collections remain unsupported. Disable optical sizing for a variable font with
an `opsz` axis so browser and PDF outlines use the same instance.

Keep the source connected and unchanged during export. `registerFont({ ..., document:
source.ownerDocument })` registers a face in an iframe's own `FontFaceSet`; the same
handles belong in that source's `renderPDF` options. The default preserves source
width and fails when it exceeds the page's content width (about **745.7 CSS
pixels** for A4 with default margins). `fit: 'width'` instead keeps the browser's
original wrapping and uniformly reduces PDF paint and page mapping.

### Convert an HTML string

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
layout width before PDF fitting. `fontFallback` explicitly lays out copied
elements whose first computed family is unregistered and reports
`FONT_SUBSTITUTED`; it changes their appearance, so it cannot preserve an
unprovided system font such as Tahoma. HTML header/footer fragments live in
separate shadow roots: include their CSS inline or in each fragment. Scripts,
frames, active attributes and refresh metadata are rejected. Ordinary image and
CSS URLs may still trigger browser requests.

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

## Options

Both conversion functions accept these settings:

| Option        | Default                 | Description                                                           |
| ------------- | ----------------------- | --------------------------------------------------------------------- |
| `format`      | `'A4'`                  | `'A4'`, `'A3'`, `'Letter'` or `{ width, height }`.                    |
| `orientation` | `'portrait'`            | `'portrait'` or `'landscape'`; HTML also accepts `'auto'`.            |
| `margin`      | `24`                    | One value or `{ top, right, bottom, left }`.                          |
| `metadata`    | Title: `'RenderPDF.js'` | Unicode `title`, `author`, `subject` and `keywords` (a string array). |
| `onProgress`  | —                       | Receives `{ stage, completed, total }`.                               |
| `signal`      | —                       | An `AbortSignal` for cancellation.                                    |

Dimensions and margins use **CSS pixels**: `1 px = 0.75 PDF pt`. Custom paper
dimensions include margins; landscape swaps the supplied width and height.

HTML exports also accept:

| Option               | Default  | Description                                                                            |
| -------------------- | -------- | -------------------------------------------------------------------------------------- |
| `fonts`              | Required | Registered faces used by the source and page text.                                     |
| `fit`                | `'none'` | `'width'` uniformly shrinks wide HTML after browser layout.                            |
| `pageBreak`          | `'css'`  | Honor supported CSS breaks, or use `'auto'` for geometry alone.                        |
| `repeatTableHeaders` | `false`  | Repeat native `thead` groups on continuation pages.                                    |
| `header`, `footer`   | —        | One line, left/center/right text, or connected HTML repeated on every page.            |
| `fallback`           | `'auto'` | Rasterize supported local effects; `'strict'` requires explicit `data-raster` regions. |
| `rasterScale`        | `2`      | Raster pixels per CSS pixel.                                                           |
| `verifySource`       | `'full'` | `'mutations'` skips CSSOM fingerprints and can miss stylesheet changes.                |
| `onWarning`          | —        | Receives export warnings.                                                              |

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
input fails explicitly instead of silently producing a whole-page screenshot.

## Supported scope

HTML rendering supports static blocks, inline content, nonoverlapping Flexbox and
Grid layouts, horizontal Latin text (including Czech diacritics), solid backgrounds,
rectangular borders and native tables with `rowspan` and `colspan`.

PNG/JPEG resources can use data, blob, same-origin or CORS-readable URLs. External
images may be fetched by the browser; documents are never sent to a conversion
service. JPEG orientation in HTML must be absent or `1`; normalize rotated pixels
before using them in an `<img>` element.

Gradients, rounded corners, inline bitmap backgrounds, inset shadows and opacity
can use local raster fallback on supported rectangular blocks. `data-raster`
selects a region explicitly. Regions are captured once in paint order; descendant
text gets an extraction layer where safe. Raster resources must be inline bitmaps;
external resources, transforms, backdrop effects and effects outside the border
box are unsupported. Wrapped inline backgrounds or borders require a containing
raster region; inline and table-internal raster boundaries are unsupported.

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

Default kerning, ligatures and combining marks are supported. Keep shaped words in
one text node; cross-inline ligatures and zero-width fragments are unsupported.
Complex scripts, bidirectional text, custom font features/variants, stretched
faces, font-size adjustment, automatic hyphenation and soft hyphens are unsupported.
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
loads only when needed. Structural checks reject malformed input, but cannot
identify every damaged JPEG scan or CCITT bitstream.

## Development

Use Node.js 22.18+ (22.x), 24.11+ (24.x) or 26+. `.node-version` records the
verified runtime.

```sh
npm ci
npm run build
npm run check
```

`npm run check` runs formatting, lint, types, unit tests, browser tests, build and
package checks. Google Chrome must be installed for browser tests. Vite+ provides
the development toolchain; Playwright and PDF.js are used for testing.

Run `npm run dev` to serve synthetic test fixtures. The independent
[playground](https://github.com/MichalekJan93/renderPDF.js/tree/main/playground)
tests the packaged library. See the
[benchmark guide](https://github.com/MichalekJan93/renderPDF.js/blob/main/BENCHMARKS.md)
for `npm run benchmark` and timing reports.

To create a local package, create `artifacts/` if needed, then run
`npm pack --pack-destination artifacts`. Only the library build, declarations,
package metadata, README, license and logo are packaged. Keep private documents
and generated files out of Git.

## License

[MIT](https://github.com/MichalekJan93/renderPDF.js/blob/main/LICENSE).
Third-party dependencies retain their own licenses: `utif2` uses MIT and `pako`
retains MIT/Zlib notices. Noto Sans and Noto Serif test fonts retain the
[SIL Open Font License](https://github.com/MichalekJan93/renderPDF.js/blob/main/public/fonts/README.md)
and are not included in the npm package.
