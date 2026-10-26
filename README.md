<p align="center">
  <img src="https://raw.githubusercontent.com/MichalekJan93/renderPDF.js/main/assets/renderpdf-logo.png" alt="RenderPDF.js logo" width="560" />
</p>

# RenderPDF.js

An open-source TypeScript library for converting HTML/CSS and standalone images
to PDF in the browser. HTML exports retain selectable text, local raster fallbacks
and automatic pagination. The browser calculates HTML layout; RenderPDF.js uses
its measured text, box, image and table coordinates to write the PDF. Standalone
PNG/JPEG and multipage TIFF files use a separate image API. Conversion runs
entirely on the client.

The renderer is experimental and supports the bounded subset described below.
Chromium is the verified browser; Firefox/Safari compatibility has not been
established.

## Getting started

Install the library in a browser application with a bundler, such as Vite:

```sh
npm install renderpdf-js
```

The package provides an ESM entry and TypeScript declarations. Version 0.x is
experimental; review the supported scope and limits before using it for documents.
To try HTML preview and PDF download from a source checkout, run the independent
[playground](https://github.com/MichalekJan93/renderPDF.js/tree/main/playground).

## Standalone image files

`imageToPDF` is available from version 0.2.0. It accepts one `File`/`Blob`, `ArrayBuffer` or
`Uint8Array`; actual file signatures determine the format, not filenames or MIME
labels. No HTML element or registered fonts are needed.

```ts
import { imageToPDF } from 'renderpdf-js';

const file = fileInput.files?.[0];
if (!file) throw new Error('Select a PNG, JPEG or TIFF file.');

const pdf = await imageToPDF(file, {
  format: 'A4',
  margin: 24,
  metadata: { title: 'Scanned document' },
  onProgress: ({ stage, completed, total }) => {
    statusElement.textContent = `${stage}: ${completed}/${total}`;
  },
});
await pdf.download('document.pdf');
```

PNG/JPEG produce one PDF page. Every main linked TIFF frame produces its own page
in file order. Images fit completely inside the selected paper's margins, retain
their aspect ratio and are centered; fitting can enlarge a small image. The
defaults are A4 portrait and 24 CSS-pixel margins. A3, Letter, landscape,
asymmetric margins and custom paper sizes use the same settings as HTML exports.
TIFF/EXIF orientations 1–8, including mirrored orientations and PNG `eXIf`, are
applied when painting the page. JPEG compressed bytes remain unchanged.

The result has the same `pageCount`, `download()`, `toBlob()` and
`toUint8Array()` methods as HTML exports. Image text remains part of the bitmap;
this API does not perform OCR. Metadata and mutable input bytes are copied before
the first asynchronous stage. Cancellation uses `signal`. Progress stages are
`preparing`, `resources`, `pages`, `saving` and `complete`; image conversion does
not emit HTML layout/pagination stages. Resource/page totals equal the number of
image frames. A failed or canceled conversion returns no partial PDF.

Supported TIFF input is classic TIFF with strips and either byte order, using
uncompressed, CCITT RLE/Group 3/Group 4, LZW, PackBits or Deflate compression.
The bounded decoder supports common bilevel/grayscale, palette and 8-bit RGB/RGBA
profiles, including associated alpha normalization. Other modes, including
BigTIFF, tiles, SubIFDs/RAW layouts, planar-separated samples, 16-bit/float samples
and JPEG-compressed TIFF, fail with `UNSUPPORTED_IMAGE`. Frames are limited to
40 million pixels each and TIFF files to 1,000 main frames. PNG must be static;
APNG is rejected explicitly. JPEG supports 8-bit baseline/extended/progressive
grayscale, RGB and CMYK frames.

Malformed headers, checksums and out-of-file offsets are rejected. JPEG entropy
validation and detection of every corrupt CCITT bitstream remain decoder-limited;
structural checks do not prove that every damaged scan is recoverable. TIFF
pixels are decoded one frame at a time with the MIT-licensed `utif2` dependency,
which loads only when TIFF decoding is requested. The HTML `<img>` pipeline still
accepts native PNG/JPEG resources; standalone TIFF support does not change it.

## HTML usage

Import the public API from the installed package in your application's browser entry:

```ts
import { registerFont, renderPDF, RenderPDFError } from 'renderpdf-js';

// Fetch a licensed static TTF/OTF program owned by the application.
const response = await fetch('/fonts/MyFont-Regular.ttf');
if (!response.ok) throw new Error('The document font could not be loaded.');
// Register before displaying/measuring the source; use a family owned by this registration.
const regular = await registerFont({
  family: 'Document Sans',
  data: await response.arrayBuffer(),
});
// The source stays connected and keeps its existing browser-calculated dimensions.
const source = document.querySelector<HTMLElement>('#invoice');
if (!source) throw new Error('Invoice element was not found.');
source.style.fontFamily = 'Document Sans';

try {
  // At the default A4 margins the source must fit within approximately 745.7 CSS pixels.
  const pdf = await renderPDF(source, {
    fonts: [regular],
    format: 'A4',
    orientation: 'portrait',
    margin: 24,
    rasterScale: 2,
    fallback: 'auto',
    pageBreak: 'css',
    onWarning: (warning) => console.info(warning.code, warning.message),
  });
  await pdf.download('invoice.pdf');
  // Independent byte and Blob forms do not render the source again.
  const bytes = await pdf.toUint8Array();
  // Applications can preview, store or upload this Blob themselves if required.
  const blob = await pdf.toBlob();
  console.info(pdf.pageCount, bytes.byteLength, blob.type);
} catch (error) {
  if (error instanceof RenderPDFError) console.error(error.code, error.message);
  else throw error;
}
```

Register each used family, weight and style explicitly, including bold headings.
`registerFont({ family, data, weight: 700, style: 'normal' })` registers a bold
program; italic uses `style: 'italic'`. The first computed CSS family must match a
provided handle. System fonts cannot be recovered through browser layout APIs.
Registration copies bytes, rejects conflicting browser faces and reuses identical
registrations. Importing the module is safe without a DOM; conversion and font
registration require a browser document.
Variable fonts, WOFF/WOFF2 and font collections are rejected; supply static
TTF/OTF instances. Do not remove or replace registered browser faces during use.

### Repeated table headers and page text

Repeated table headers and page text are available from version 0.2.0.

```ts
const pdf = await renderPDF(source, {
  fonts: [regular],
  margin: 24,
  repeatTableHeaders: true,
  header: { text: 'Account statement', height: 32, fontSize: 12 },
  footer: {
    text: 'Page {pageNumber} of {pageCount}',
    height: 28,
    fontSize: 11,
    align: 'right',
  },
});
await pdf.download('statement.pdf');
```

`repeatTableHeaders` defaults to `false`, preserving existing exports. Enabling it
repeats native `thead` paint and selectable text on continuation pages of a table.
The header's measured height and spacing reduce the available body space on those
pages. The original header stays together with the first body row. Body rows and
spanning cells remain indivisible; a header and row that cannot fit fail with
`PAGINATION_FAILED`. Repeated headers require nonnested native tables with a
visible `thead` followed by body rows; raster headers, overlapping table ranges,
header rowspans and cells spanning the header/body boundary are unsupported. Table footers are
not repeated.
Header paint must fit inside the measured `thead` box; text overflowing into its
surrounding spacing fails explicitly instead of being clipped on continuation pages.

`header` and `footer` each reserve their required `height` in CSS pixels **in
addition to** the page's outer margins. They accept one plain Latin text line,
including Czech diacritics, with `{pageNumber}` and `{pageCount}` placeholders.
The text is black, vertically centered, and remains selectable. `fontSize`
defaults to 12 CSS pixels and `align` to `'left'`; `'center'` and `'right'` are
also supported. `font` can select a registered handle included in `fonts`, and
otherwise defaults to the first supplied face. Band text never wraps or shrinks
silently: text that exceeds its reserved height or available width fails with
`SOURCE_OVERFLOW`. Invalid settings or bands leaving no content area fail with
`INVALID_OPTIONS`. HTML templates and per-page callbacks are not supported.

### Export progress and document properties

Progress reporting and document properties are available from version 0.2.0.

```ts
const pdf = await renderPDF(source, {
  fonts: [regular],
  metadata: {
    title: 'Account statement',
    author: 'Example Company',
    subject: 'Quarterly overview',
    keywords: ['statement', 'quarterly'],
  },
  onProgress: ({ stage, completed, total }) => {
    // Keep the status element outside the document being exported.
    statusElement.textContent = `${stage}: ${completed}/${total}`;
  },
});
await pdf.download('statement.pdf');
```

Progress events are frozen records with `stage`, `completed` and `total` fields.
Stages are `preparing`, `layout`, `pagination`, `resources`, `pages`, `saving`
and `complete`, in that order. Counters describe work **within the current stage**,
not elapsed-time percentages. Preparation, layout, pagination and saving use one
work unit; resources count font programs and processed native image/raster
references, including reused image references. The page stage counts finished
physical pages; its total is known after pagination. A successful export ends
with `{ stage: 'complete', completed: 1, total: 1 }` after source validation.

Providing `onProgress` allows periodic browser task yields so status updates and
cancellation can run during export. Without it, conversion adds no progress
timers. Callbacks are synchronous notifications; thrown callback errors reject
the export with the original error. Keep the source static during callbacks as
well as asynchronous rendering. Cancellation continues to use `signal` and the
standard `AbortError`, with no partial PDF returned.

`metadata` accepts optional Unicode `title`, `author`, `subject` and `keywords`
properties. The keywords value is an array of strings. Settings and keyword
entries are copied before the first asynchronous stage; later caller edits do
not alter the current PDF. Invalid runtime values fail with `INVALID_OPTIONS`.
The default title remains `RenderPDF.js`. Metadata does not add visible page
content or change font requirements.

## Supported scope

- Static block, inline, nonoverlapping Flexbox and Grid geometry with horizontal
  Latin text, including Czech diacritics.
- Solid backgrounds, uniform solid rectangular borders and browser-measured
  padding, margins and alignment.
- Native PNG/JPEG images loaded from data, blob, same-origin or CORS-readable URLs.
  Other image formats fail explicitly. External images can require a browser
  fetch at export time; document data is never submitted to a conversion service.
  JPEG EXIF orientation must be absent or 1; normalize rotated image pixels first.
- Legacy `FONT`, `CENTER` and native tables with separate or collapsed borders.
  Collapsed borders are available from version 0.2.0. Table rows and rowspan cells remain atomic; oversized
  atomic content fails.
- A4, A3 and Letter, portrait/landscape, a numeric margin or four explicit edges.
  Custom paper uses `format: { width: 500, height: 400 }`; dimensions include
  margins. Landscape swaps the supplied base axes, including custom dimensions.
  Page dimensions and margins use CSS pixels; `1 CSS px = 0.75 PDF pt`. The renderer preserves
  source width and wrapping and fails if it exceeds the page's content width.
- Automatic local fallback for gradients, inline bitmap backgrounds, rounded
  corners, inset shadows and opacity on independently capturable rectangular
  blocks. Plain parents stay native; a selected parent owns all nested effects
  and is captured once in paint order. Descendant text adds extraction-only PDF
  objects where safe. Layout/order/overlap guards also apply inside automatic
  regions. Inline fragments and table-internal raster boundaries are rejected.
  Raster resources must be inline bitmaps; external resources, backdrop effects,
  transforms and effects outside the border box are rejected.
  Wrapped native inline backgrounds/borders need an explicit containing raster;
  a single union rectangle cannot reproduce their separate line fragments.
- Explicit `data-raster` remains available. `fallback: 'strict'` disables automatic
  selection while honoring these caller-selected boundaries. Neither mode silently
  substitutes a whole-document screenshot when a local feature cannot be rendered.
- `pageBreak: 'css'` (default) respects block/table-row `break-before: page` and
  `break-after: page`, their legacy `page-break-*: always` aliases, and
  `break-inside: avoid/avoid-page`. Before/after avoidance conservatively keeps
  adjacent complete block siblings together when they fit. `pageBreak: 'auto'`
  ignores authored fragmentation hints and uses only measured atomic geometry.

Collapsed tables support cell and outer-table borders with `solid`, `none` and
`hidden` styles, including different widths/colors on each side, transparency,
`rowspan` and `colspan`. Shared edges resolve conflicts before native painting:
hidden suppresses a border, otherwise the wider solid candidate wins; cells
outrank the table on equal widths, followed by the upper/left cell in LTR layout.
Crossing fills are partitioned so transparency is not applied twice. Original
browser column widths and selectable text are retained; no table screenshot is
used. Outer borders stay with the first/last complete rows during pagination.

Collapsed row, row-group, column and column-group border contributions, other
border styles, nested collapsed tables, captions and altered native table-part
display modes fail explicitly. Keep these contributions on cells or the table
itself. Repeated headers on collapsed tables additionally require the same
resolved horizontal border segments, widths and colors at every possible body
continuation boundary; incompatible combinations fail with `UNSUPPORTED_CSS`.
Repeated headers on tables with separate borders retain their existing scope.

Page mapping keeps consecutive source intervals: native backgrounds and boxes may
span pages, while measured text lines, images, raster regions, table rows and
rowspan cells remain atomic. Fitting avoid blocks move intact to the next page.
An oversized or incompatible avoid preference relaxes with `BREAK_AVOID_RELAXED`;
it never authorizes cutting an atomic item. Forced breaks take precedence over
soft avoidance, and coincident/root-edge rules create no empty pages. A forced
break through an atomic object, including a raster descendant or spanning cell,
fails with `PAGINATION_FAILED`. Atomic content taller than a page also fails.

Keep the source static while exporting. The renderer waits for fonts and image
decoding, observes source and stylesheet mutations, and checks computed styles and
geometry across asynchronous stages. A changed source fails with `SOURCE_CHANGED`.
Pause animations before export. Cancellation uses `signal: controller.signal` and
rejects with the standard `AbortError`; it is cooperative between rendering
stages. No partial PDF is returned. Temporary observers and download URLs are
released.

## Diagnostics and limits

`RenderPDFError.code` distinguishes invalid options/source, missing fonts/glyphs,
unsupported CSS/elements, failed resources, source changes/overflow, pagination,
raster and PDF writing failures. Warnings are available through both `onWarning`
and the immutable `result.warnings` collection, without runtime console logging.

PDF text uses browser word origins and fontkit's shaped glyph advances and offsets;
glyph outlines retain their original proportions. Default OpenType ligatures,
kerning (including `font-kerning: none`) and combining marks retain a selectable
Unicode text layer. Baselines still use Canvas font metrics. Nondefault font
features/variants, stretched faces, font-size adjustment, automatic hyphenation
and soft hyphens fail explicitly. Keep shaped words in one text node; cross-inline
ligatures and zero-width text fragments are unsupported and reject explicitly.
Exact output across shaping engines, arbitrary ligatures, complex scripts, bidi
and variable font instances are not a fidelity promise. There is no arbitrary CSS/stacking
engine. Collapsed tables, repeated table headers and plain page text
use the explicit options described above; arbitrary HTML page templates are unsupported.
Pagination is a measured source-to-page mapping, not full CSS Paged Media: parity
breaks (`left/right/recto/verso`), column breaks, inline/cell break directives,
margin-break rules, widow/orphan line-count policies and cloned page decorations
are unsupported. Nondefault native `widows`/`orphans` and
`box-decoration-break: clone` fail explicitly. Default line-count values are not
enforced. Unsupported visible behavior must fail rather than silently produce an
apparently successful export.
Direct text overlapping later visible paint is also rejected when the simple
ordered paint list cannot reproduce the browser's block/inline paint phases.

## Development

Development requires Node.js 22.18+ on the 22.x release line, 24.11+ on 24.x, or
26+. The `.node-version` file records the verified 22.22.0 runtime. From a source checkout:

```sh
npm ci
npm run build
```

Source code lives in `src/`. Browser regression pages live in `tests/fixtures/`;
their measurement helpers in `experiments/` use the same rendering pipeline as
the public API. `npm run dev` serves these fixtures for development, while
`npm run build` builds only the library.

The independent HTML editor in `playground/` installs the
packed library as an npm dependency. It provides a live preview and PDF download
without importing renderer source files.

Vite+ provides the development server, builds, Oxlint, Oxfmt and Vitest. Shared
lint, format and unit-test settings live in `vite.config.ts`; the library build
uses `vite.library.config.ts` and TypeScript to generate declarations. The toolchain
is installed locally by `npm ci`; a global Vite+ installation is optional.

The playground deliberately uses one explicitly stated font family;
the reusable API supports multiple families. Private documents and local system
font programs belong only in ignored `artifacts/`; regression tests use synthetic
documents and do not require them.

Run `npm run check` before submitting a change. It checks types, lint, unit tests,
browser tests, builds, formatting and package contents. Browser tests require an installed Google
Chrome and use synthetic fixtures, Playwright and PDF.js; those tools never run in
conversion code. Generated PDFs, screenshots and reports stay outside versioned
source files.

Typography regressions compare tight browser/PDF text crops for Noto Sans regular,
bold and italic plus Noto Serif, including Czech accents, ligatures, kerning and
wrapped mixed-font lines on multiple pages. The [benchmark guide](https://github.com/MichalekJan93/renderPDF.js/blob/main/BENCHMARKS.md)
describes repeatable exports of small, medium, large and hybrid documents.
Run `npm run benchmark` to record timings separately from correctness checks.
GitHub Actions runs the checks and preserves rendered comparisons and timing reports.

### Local package

`npm pack --pack-destination artifacts` builds the library and checks its contents
before creating a local archive. Create the `artifacts/` directory first if it is
absent. The package includes the ESM entry, TypeScript declarations, package metadata,
README, MIT license and README logo. Demos, test fonts, source files and local
documents are excluded by an explicit `files` allowlist.

`npm run check:package` checks the current build through npm's dry-run inventory;
run `npm run build:library` first when no build exists. The check rejects missing
entry points, empty files and unexpected contents. Packaging does not publish the
library. Maintainers publish a reviewed archive with
`npm publish ./artifacts/renderpdf-js-<version>.tgz --access public` after updating
the package version and verifying the packed consumer.

## License

RenderPDF.js is licensed under the [MIT License](LICENSE). The TIFF decoder
`utif2` retains its MIT license; its `pako` dependency retains its MIT/Zlib notices.
Runtime dependencies remain external to the library bundle. Bundled Noto Sans and Noto Serif test
fonts retain their [SIL Open Font License](https://github.com/MichalekJan93/renderPDF.js/blob/main/public/fonts/README.md); they are not
bundled into the library entry. Third-party dependencies retain their own licenses.
