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
To try HTML preview and PDF download, run the independent
[playground](playground/README.md).

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

## Supported scope

- Static block, inline, nonoverlapping Flexbox and Grid geometry with horizontal
  Latin text, including Czech diacritics.
- Solid backgrounds, uniform solid rectangular borders and browser-measured
  padding, margins and alignment.
- Native PNG/JPEG images loaded from data, blob, same-origin or CORS-readable URLs.
  Other image formats fail explicitly. External images can require a browser
  fetch at export time; document data is never submitted to a conversion service.
  JPEG EXIF orientation must be absent or 1; normalize rotated image pixels first.
- Legacy `FONT`, `CENTER` and simple tables with separate borders. Table rows and
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
engine, collapsed table borders, repeated table headers or header/footer engine.
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
wrapped mixed-font lines on multiple pages. The [benchmark guide](BENCHMARKS.md)
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
library; `private: true` remains enabled.

## License

RenderPDF.js is licensed under the [MIT License](LICENSE). Bundled Noto Sans and Noto Serif test
fonts retain their [SIL Open Font License](public/fonts/README.md); they are not
bundled into the library entry. Third-party dependencies retain their own licenses.
