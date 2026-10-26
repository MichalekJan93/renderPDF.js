<p align="center">
  <img src="https://raw.githubusercontent.com/MichalekJan93/renderPDF.js/main/assets/renderpdf-logo.png" alt="RenderPDF.js logo" width="560" />
</p>

# RenderPDF.js

**Convert HTML, PNG, JPEG and multipage TIFF to PDF in the browser.**

[![npm version](https://img.shields.io/npm/v/renderpdf-js)](https://www.npmjs.com/package/renderpdf-js)
[![CI](https://github.com/MichalekJan93/renderPDF.js/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/MichalekJan93/renderPDF.js/actions/workflows/check.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](https://github.com/MichalekJan93/renderPDF.js/blob/main/LICENSE)

HTML exports use the browser's layout, keep text selectable and split content
across pages. Conversion runs locally, without a conversion server.

**Experimental.** Chromium is the verified browser. Firefox and Safari have not
been verified. HTML rendering supports the [subset described below](#supported-scope).

## Features

- Selectable HTML text with embedded fonts, native boxes, images and tables.
- Automatic pagination, repeated table headers, page headers and page numbers.
- PNG/JPEG conversion and one PDF page per frame of a multipage TIFF.
- Paper sizes, margins, document properties, progress events and cancellation.
- ESM package with TypeScript declarations.

## Getting started

```sh
npm install renderpdf-js
```

Use the package in a browser application with an ESM bundler, such as Vite.
The [playground](https://github.com/MichalekJan93/renderPDF.js/tree/main/playground)
provides an HTML editor, preview and PDF download from a source checkout.

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

Register every font family, weight and style used by the source, including bold
and italic faces. For example, add `weight: 700` when registering a bold font.
The first computed CSS font family must match a registered face. Static TTF/OTF
files are required; system fonts, variable fonts, WOFF/WOFF2 and font collections
are unsupported.

Keep the source connected to the document and unchanged during export. Its width
and wrapping are preserved, so it must already fit the page's content width:
about **745.7 CSS pixels** for A4 with the default margins. Oversized HTML is not
automatically scaled down.

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
| `orientation` | `'portrait'`            | `'portrait'` or `'landscape'`.                                        |
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
| `pageBreak`          | `'css'`  | Honor supported CSS breaks, or use `'auto'` for geometry alone.                        |
| `repeatTableHeaders` | `false`  | Repeat native `thead` groups on continuation pages.                                    |
| `header`, `footer`   | —        | One plain text line in a reserved area on every page.                                  |
| `fallback`           | `'auto'` | Rasterize supported local effects; `'strict'` requires explicit `data-raster` regions. |
| `rasterScale`        | `2`      | Raster pixels per CSS pixel.                                                           |
| `onWarning`          | —        | Receives export warnings.                                                              |

### Repeated table headers and page text

```ts
const pdf = await renderPDF(source, {
  fonts: [regular],
  repeatTableHeaders: true,
  header: { text: 'Account statement', height: 32 },
  footer: {
    text: 'Page {pageNumber} of {pageCount}',
    height: 28,
    fontSize: 11,
    align: 'right',
  },
});
await pdf.download('statement.pdf');
```

Header and footer `height` is required and reserves space **in addition to** the
outer margins. Each accepts one plain Latin text line, including Czech diacritics,
with `{pageNumber}` and `{pageCount}` placeholders. Text stays selectable and does
not wrap. `fontSize` defaults to `12`, `align` to `'left'`, and `font` to the first
face in `fonts`. Alignment can also be `'center'` or `'right'`. Text that does not
fit fails explicitly. HTML page templates and per-page callbacks are unsupported.

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
Changes to the source fail with `SOURCE_CHANGED`.

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
