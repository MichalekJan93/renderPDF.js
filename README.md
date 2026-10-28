<p align="center">
  <img src="assets/renderpdf-logo.png" alt="RenderPDF.js logo" width="560" />
</p>

# RenderPDF.js

An open-source TypeScript library for converting HTML/CSS to PDF in the browser,
with selectable text, local raster fallbacks and automatic pagination. The browser
calculates layout; RenderPDF.js uses its measured text, box, image and table
coordinates to write the PDF. Conversion runs entirely on the client.

The renderer is experimental and supports the bounded subset described below.
Chromium is the verified browser; Firefox/Safari compatibility has not been
established.

## Getting started

Development requires Node.js 22.18+ on the 22.x release line, 24.11+ on 24.x, or
26+. The `.node-version` file records the verified 22.22.0 runtime. From a local checkout:

```sh
npm ci
npm run build
```

The build creates an ESM entry at `dist/index.js` and TypeScript declarations.
Use a bundler to resolve the library's three runtime dependencies.

The npm package is currently unpublished and marked `private` to prevent accidental
publishing. The examples below use the local build.

## Usage

Use this import in an application entry beside the generated `dist/` directory.

```ts
import { registerFont, renderPDF, RenderPDFError } from './dist/index.js';

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
    strictCss: false,
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

## API parameters

### `renderPDF(element, options)`

The first row describes the source argument; the remaining rows are fields of
the second `options` argument. Dimensions and margins use CSS pixels,
with `1 CSS px = 0.75 PDF pt`. Required values have no implicit substitute.

| Name          | Info                                                                                                                                                                                                                                                                                                                     | Allowed settings                                                                                                               | Default setting                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `element`     | Existing browser layout to export. Keep it connected and stable until the promise settles; the renderer does not resize or reflow it.                                                                                                                                                                                    | A positive-size `HTMLElement` in the current browser document with supported static content.                                   | Required.                                  |
| `fonts`       | Exact faces for browser text, PDF embedding and local raster text. Register every used family, weight and style.                                                                                                                                                                                                         | A nonempty array of handles returned by `registerFont()` in the current document, with unique family/weight/style descriptors. | Required; no system-font discovery.        |
| `format`      | Physical paper size, including margins. Custom dimensions are CSS pixels.                                                                                                                                                                                                                                                | `'A4'`, `'A3'`, `'Letter'`, or `{ width, height }` with finite positive dimensions.                                            | `'A4'`.                                    |
| `orientation` | Selects the paper axes. Landscape swaps the base width/height, including custom sizes; source width and line wrapping remain unchanged.                                                                                                                                                                                  | `'portrait'` or `'landscape'`.                                                                                                 | `'portrait'`.                              |
| `margin`      | Empty space at page edges, in CSS pixels. The margins must leave a positive content area.                                                                                                                                                                                                                                | A finite nonnegative number for all edges, or a complete `{ top, right, bottom, left }` object with finite nonnegative values. | `24` on every edge.                        |
| `rasterScale` | Physical bitmap pixels per CSS pixel inside local raster regions. Higher values can improve detail and increase memory, PDF size and conversion time.                                                                                                                                                                    | A finite number greater than `0`, subject to the per-capture canvas budget below.                                              | `2`.                                       |
| `fallback`    | Controls automatic selection of local raster regions. `'auto'` selects safe effects; `'strict'` uses only elements explicitly marked `data-raster`.                                                                                                                                                                      | `'auto'` or `'strict'`.                                                                                                        | `'auto'`.                                  |
| `strictCss`   | Controls the documented decorative omissions: outer box shadows and native table row/group/column backgrounds can disappear; collapsed borders use measured cell boxes without the collapsed-border paint algorithm. `true` rejects those cases. Other unsupported CSS and unsafe content can still fail in either mode. | `false` or `true`.                                                                                                             | `false`, allowing these omissions.         |
| `pageBreak`   | `'css'` honors supported forced page breaks and keep-together preferences. `'auto'` ignores authored fragmentation hints and fills pages from measured geometry. Neither mode cuts an atomic text line, image, raster region, table row or rowspan cell.                                                                 | `'css'` or `'auto'`.                                                                                                           | `'css'`.                                   |
| `signal`      | Cooperatively cancels preparation and later rendering stages. Cancellation rejects with `AbortError` and returns no partial PDF.                                                                                                                                                                                         | An `AbortSignal`, usually `controller.signal` from an `AbortController`.                                                       | Not set; no caller-requested cancellation. |
| `onWarning`   | Receives approximation, raster-fallback and pagination warnings. Warnings are also retained in `result.warnings`.                                                                                                                                                                                                        | A synchronous `(warning: RenderWarning) => void` callback.                                                                     | Not set; no automatic console logging.     |

`fallback: 'strict'` and `strictCss: true` are independent controls. The first
requires explicit markers for raster capture; the second rejects the listed
decorative omissions. With `fallback: 'strict'` and `strictCss: false`, an
unmarked box shadow is omitted even when it is inset. Use `data-raster` to retain
supported inset shadows in that mode. Neither option enables general CSS support.
An outer shadow on a selected raster root may be omitted, while unsafe effects
inside its descendants can still fail.

Use `pageBreak: 'auto'` to fill available page space when the HTML contains
`break-before: page` or `page-break-before: always` that you want to ignore.
This also ignores `break-inside: avoid` and other authored keep-together hints;
table rows and the other intrinsic atomic items remain undivided.

Each local raster capture is limited to `8192` physical pixels per axis and
`16,777,216` total physical pixels. Increasing `rasterScale` can exceed those
limits even when the HTML element fits on a PDF page.

### `registerFont(source)`

| Name     | Info                                                                                                                                          | Allowed settings                                                                                                                                         | Default setting |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `family` | Application-owned CSS family used in both the source and the registered handle. Names are trimmed and matched without case sensitivity.       | A nonempty custom name using ASCII letters, digits, spaces, hyphens or underscores. Generic families and CSS-wide keywords are rejected.                 | Required.       |
| `data`   | Exact static font program. The registration copies the bytes and rejects conflicting programs for an existing family/weight/style descriptor. | A nonempty `Uint8Array` or `ArrayBuffer` containing a static TTF/OTF font. URL strings, WOFF/WOFF2, font collections and variable fonts are unsupported. | Required.       |
| `weight` | Numeric weight of the supplied static face; provide a separate program for each used weight.                                                  | An integer from `1` to `1000`, such as `400` or `700`.                                                                                                   | `400`.          |
| `style`  | Style of the supplied face; use a separate italic program instead of browser synthesis.                                                       | `'normal'` or `'italic'`.                                                                                                                                | `'normal'`.     |

### PDF output and per-element raster control

| Name                         | Info                                                                                                                                                                                 | Allowed settings                                                                               | Default setting                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `result.download(filename)`  | Downloads the already generated PDF. The method neither rerenders the source nor adds a filename extension.                                                                          | A nonempty filename without `/`, `\` or ASCII control characters. Include `.pdf` when desired. | `'document.pdf'`.                                  |
| HTML `data-raster` attribute | Explicitly selects a subtree for one local raster capture. This is an HTML attribute, not a `renderPDF` option. The selected subtree must satisfy the raster safety and size limits. | Add the attribute, for example `<div data-raster>...</div>`, or leave it absent.               | Absent; `fallback` determines automatic selection. |

`result.toBlob()` and `result.toUint8Array()` take no parameters. They return the
same completed PDF in different forms without another conversion. `pageCount`
and `warnings` are read-only result metadata.

## Supported scope

- Static block, inline, nonoverlapping Flexbox and Grid geometry with horizontal
  Latin text, including Czech diacritics.
- Solid backgrounds, uniform solid rectangular borders and browser-measured
  padding, margins and alignment.
- Native PNG/JPEG images loaded from data, blob, same-origin or CORS-readable URLs.
  Other image formats fail explicitly. External images can require a browser
  fetch at export time; document data is never submitted to a conversion service.
  JPEG EXIF orientation must be absent or 1; normalize rotated image pixels first.
- Legacy `FONT`, `CENTER`, inline `SMALL` and simple tables with separate borders. Table rows and
  rowspan cells remain atomic; oversized atomic content fails.
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
  transforms and effects outside the border box are rejected. An outer shadow on
  a selected raster root is omitted by default because it exceeds the captured box.
  Wrapped native inline backgrounds/borders need an explicit containing raster;
  a single union rectangle cannot reproduce their separate line fragments.
- Explicit `data-raster` remains available. `fallback: 'strict'` disables automatic
  selection while honoring these caller-selected boundaries. Neither mode silently
  substitutes a whole-document screenshot when a local feature cannot be rendered.
- `strictCss: true` rejects the decorative CSS omissions listed here.
  The default `false` omits outer box shadows and table row/group backgrounds;
  collapsed table borders are rendered using the measured cell boxes without
  reproducing the collapsed-border painting algorithm. These omissions do not
  change the source DOM. `strictCss` is independent of the raster `fallback` mode.
- `pageBreak: 'css'` (default) respects block/table-row `break-before: page` and
  `break-after: page`, their legacy `page-break-*: always` aliases, and
  `break-inside: avoid/avoid-page`. Before/after avoidance conservatively keeps
  adjacent complete block siblings together when they fit. `pageBreak: 'auto'`
  ignores authored fragmentation hints and uses only measured atomic geometry.

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

PDF text uses browser word origins and approximate baseline/word-width fitting.
Exact within-word kerning, arbitrary ligatures, complex shaping, bidi and variable
font instances are not a fidelity promise. There is no arbitrary CSS/stacking
engine, collapsed table borders, repeated table headers or header/footer engine.
Pagination is a measured source-to-page mapping, not full CSS Paged Media: parity
breaks (`left/right/recto/verso`), column breaks, inline/cell break directives,
margin-break rules, widow/orphan line-count policies and cloned page decorations
are unsupported. Nondefault native `widows`/`orphans` and
`box-decoration-break: clone` fail explicitly. Default line-count values are not
enforced. Unsupported layout, text ownership, font and resource behavior can still
fail in the default CSS omission mode; the renderer never drops document text to
force an export.
Direct text overlapping later visible paint is also rejected when the simple
ordered paint list cannot reproduce the browser's block/inline paint phases.

## Development

Source code lives in `src/`. Browser regression pages live in `tests/fixtures/`;
their measurement helpers in `experiments/` use the same rendering pipeline as
the public API. `npm run dev` serves these fixtures for development, while
`npm run build` builds only the library.

Open `/tests/fixtures/rendering.html` for a basic export,
`/tests/fixtures/hybrid.html` for mixed native/raster pagination, or
`/tests/fixtures/document.html` for a local HTML chooser and PDF download.

Vite+ provides the development server, builds, Oxlint, Oxfmt and Vitest. Shared
lint, format and unit-test settings live in `vite.config.ts`; the library build
uses `vite.library.config.ts` and TypeScript to generate declarations. The toolchain
is installed locally by `npm ci`; a global Vite+ installation is optional.

The local document fixture deliberately uses one explicitly stated font family;
the reusable API supports multiple families. Private documents and local system
font programs belong only in ignored `artifacts/`; regression tests use synthetic
documents and do not require them.

Run `npm run check` before submitting a change. It checks types, lint, unit tests,
browser tests, builds, formatting and package contents. Browser tests require an installed Google
Chrome and use synthetic fixtures, Playwright and PDF.js; those tools never run in
conversion code. Generated PDFs, screenshots and reports stay outside versioned
source files.

See [tests/README.md](tests/README.md) for the test commands, coverage by file,
verification methods and remaining coverage limits.

### Local package

`npm pack --pack-destination artifacts` builds the library and checks its contents
before creating a local archive. Create the `artifacts/` directory first if it is
absent. The package includes the ESM entry, TypeScript declarations, package metadata,
README, MIT license and README logo. Demos, test fonts, source files and local
documents are excluded by an explicit `files` allowlist.

`npm run check:package` checks the current build through npm's dry-run inventory;
run `npm run build:library` first when no build exists. The check rejects missing
entry points, empty files and unexpected contents. Packaging does not publish the
library; `private: true` remains enabled.

## License

RenderPDF.js is licensed under the [MIT License](LICENSE). Bundled Noto Sans test
fonts retain their [SIL Open Font License](public/fonts/OFL.txt); they are not
bundled into the library entry. Third-party dependencies retain their own licenses.
