# Test coverage and execution

The suite checks the supported browser renderer, standalone image conversion,
programmatic document drawing, PDF composition, public diagnostics, source
ownership and npm package boundaries. The regular suite has 16 unit-test files
and 16 Chromium spec files. Parameterized cases expand into more tests; runner
output is the source of truth for their current count.

All versioned inputs are synthetic. Regular checks require no private documents,
system font programs, local `docs/` directory or separately installed DevExtreme.
Playwright, PDF.js, PNG processing and pixel comparisons are development tools;
they are not conversion runtime services.

Maintained fixture prose, controls and diagnostics use English. Clearly labeled
Unicode regression samples retain Latin diacritics, Cyrillic, Chinese and Arabic
to test exact registered faces, shaping and PDF extraction. Third-party font
copyright names and license notices are preserved.

## Prerequisites

Run commands from the repository root after `npm ci`. Use the Node.js version
described in the root [README](../README.md); `.node-version` records the verified
runtime. Browser tests use Chromium with `channel: 'chrome'`, so install Google
Chrome. Downloading Playwright's separate Chromium alone does not satisfy this
configuration.

The regular Playwright configuration starts its own Vite server at
`http://127.0.0.1:5183` with a strict port and does not reuse an existing server.
Leave that port available and allow loopback access. The JPEG resource test also
opens an OS-assigned loopback port for a real CORS boundary. The default is one
worker, a 1000 × 900 CSS-pixel viewport and device scale factor 1.

Start no separate server for these commands. Avoid source edits during browser
tests: Vite can reload an active fixture and invalidate a test.

## Commands

| Command                                             | What it runs                                                                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                                     | Required gate: formatting, lint, strict types, unit tests, regular Chromium tests, library/declaration build and actual package inventory validation. |
| `npm test -- --run`                                 | All unit tests once.                                                                                                                                  |
| `npm test -- --run tests/pagination.test.ts`        | One unit file.                                                                                                                                        |
| `npm test -- --run -t "keeps a complete table row"` | Unit cases matching a name.                                                                                                                           |
| `npm run test:browser`                              | Regular Chromium suite and its automatically managed server.                                                                                          |
| `npm run test:browser -- tests/browser/api.spec.ts` | One browser spec.                                                                                                                                     |
| `npm run test:browser -- --grep "CSS page breaks"`  | Matching browser test names.                                                                                                                          |
| `npm run test:browser -- --headed`                  | Visible Chrome run.                                                                                                                                   |
| `npm run test:browser -- --list`                    | Discover regular browser tests without running them.                                                                                                  |
| `npm run typecheck`                                 | Strict TypeScript only.                                                                                                                               |
| `npm run lint`                                      | Source lint rules.                                                                                                                                    |
| `npm run format:check`                              | Formatting validation without rewriting files.                                                                                                        |
| `npm run build`                                     | Library JavaScript and declarations, including type checking.                                                                                         |
| `npm run check:package`                             | Validate npm's actual dry-run inventory; requires an existing build.                                                                                  |
| `npm run benchmark`                                 | Separate built-library timing suite, described below.                                                                                                 |
| `npm run test:devextreme`                           | Optional integration with a separately installed DevExtreme package.                                                                                  |

Unit files match `tests/**/*.test.ts` in `vite.config.ts`. Regular browser specs
are selected from `tests/browser` by `playwright.config.ts`. The benchmark and
DevExtreme configurations use separate directories and are outside the root
`npm run check` command.

## Unit-test coverage

| File                                                 | Assertions covered                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [fonts.test.ts](fonts.test.ts)                       | Owned font-byte copies, descriptor deduplication/concurrency, failed-decoder retry, external conflicts, strict base64, static/variable font guards, CSS weight selection and current-document handles. Browser decoding is mocked here; real outlines are tested in Chromium.                                             |
| [images.test.ts](images.test.ts)                     | Native PNG/JPEG recognition, supported HTML-image orientation, malformed/truncated EXIF and unsupported resources.                                                                                                                                                                                                        |
| [page.test.ts](page.test.ts)                         | Standard/custom paper geometry, CSS-pixel margins, landscape axes and invalid public rendering options.                                                                                                                                                                                                                   |
| [pagination.test.ts](pagination.test.ts)             | Consecutive source intervals, atomic lines/images/rows/rowspans, forced CSS cuts, avoid relaxation, repeated-header capacity and border-spacing accounting, invalid/oversized geometry. These are synthetic measured coordinates, not a CSS layout engine.                                                                |
| [package.test.ts](package.test.ts)                   | Required public files/declarations, unintended/private/development files, duplicate/malformed inventory entries and byte counts. The generated package is checked separately by `check:package`.                                                                                                                          |
| [compose-pdf.test.ts](compose-pdf.test.ts)           | Merge/extract/split, selection order/duplicates, native text/vector retention, Unicode, copied bytes/options, crop/rotation, internal-link remapping, repeated donor annotations, shared builder import, invalid/form/encrypted inputs, progress and cancellation. This does not exhaust all security preflight profiles. |
| [document-builder.test.ts](document-builder.test.ts) | DOM-free documents, mixed paper sizes, exact-font Latin/Arabic/Chinese drawing and measurement, owned inputs, page/bookmark reordering, PDF append ownership, form flattening, validation and cancellation.                                                                                                               |
| [document-page.test.ts](document-page.test.ts)       | Imported MediaBox/UserUnit normalization, baseline/unit mapping, CJK wrapping, clipping/transforms/curves/alpha, balanced state/path validation, image ownership and interleaving rejection, links/Unicode notes, fields/appearances and portable color parsing.                                                          |
| [export-options.test.ts](export-options.test.ts)     | Copied/frozen Unicode metadata, rejection of malformed metadata and progress callbacks.                                                                                                                                                                                                                                   |
| [image-geometry.test.ts](image-geometry.test.ts)     | Centered proportional image fitting, all eight orientation transforms, pixel allocation bounds, invalid image/options without a DOM.                                                                                                                                                                                      |
| [image-input.test.ts](image-input.test.ts)           | PNG chunks/palettes/CRC/transparency/eXIf, JPEG frame types/dimensions/EXIF, all orientations, malformed input and allocation bounds; complete bounded PNG zlib rows, filters, checksums, Adam7 accounting and cancellation.                                                                                              |
| [jspdf-adapter.test.ts](jspdf-adapter.test.ts)       | Prepared synchronous font metrics/wrapping, units/pages, default variable-font instance, color/state normalization, clipping/baselines, ordered owned images, both rotation directions and explicit unsupported-call rejection.                                                                                           |
| [page-bands.test.ts](page-bands.test.ts)             | Copied reserved header/footer geometry, independent text slots, unchanged geometry when absent and malformed/exhausted band rejection.                                                                                                                                                                                    |
| [table-borders.test.ts](table-borders.test.ts)       | Native collapsed-edge conflict winners, width/style/owner/direction ties, rowspan-side segments, corner/alpha partitioning and invalid coordinates.                                                                                                                                                                       |
| [text.test.ts](text.test.ts)                         | Positioned kerning advances, ligatures, combining-mark anchors and explicit Unicode glyph mappings in PDF objects.                                                                                                                                                                                                        |
| [tiff.test.ts](tiff.test.ts)                         | Both byte orders, frame order, pixel/color/alpha modes, independently known Group 4 pixels, supported compression fixtures, malformed directories/strips/cycles, BigTIFF rejection and cancellation.                                                                                                                      |

## Regular Chromium coverage

| File                                                                     | Assertions covered                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [browser/api.spec.ts](browser/api.spec.ts)                               | Public multipage invoice with multiple exact font faces, Flexbox/Grid, 52 table rows, native PNG and one raster; output byte/Blob/download equality and defensive copies, warnings, exact Latin extraction, measured positions, atomic rows and equal-scale browser/PDF pixels. Also font/glyph/overflow/cancellation/source-mutation failures and same-origin/CORS JPEG resources.                           |
| [browser/document.spec.ts](browser/document.spec.ts)                     | Actual upload/download of a synthetic 180-row legacy FONT/CENTER/table document, every row endpoint exactly once on its measured page, selectable Unicode text, no raster images, source preservation and first-page pixels. Active replacement HTML rejects without losing the last preview or executing its script.                                                                                         |
| [browser/hybrid-pagination.spec.ts](browser/hybrid-pagination.spec.ts)   | One capture per local owner, nested opacity/paint ownership, complete extraction without duplicate raster text, native images and browser comparisons; CSS versus automatic breaks, avoid cards, wrapped lines and rowspans. Rejection probes cover unsafe effects/paint/geometry; default decorative omission and `strictCss` rejection include HTML page bands. The actual hybrid download UI is exercised. |
| [browser/phase0.spec.ts](browser/phase0.spec.ts)                         | Original two-page reusable-core experiment, Flexbox/Grid, exact regular/bold/italic faces, typography stress, two rasters and native image, page mapping and text origins. Whole-page/local/typography pixel checks, comparator sensitivity, invisible extraction text with zero visible pixel change, source/resource guards and actual download/error recovery.                                             |
| [browser/export-preparation.spec.ts](browser/export-preparation.spec.ts) | One image decode per export, two full fingerprints without warnings/three with warnings, late CSSOM edit rejection despite zero DOM mutation records. Counts structural work instead of machine-dependent time.                                                                                                                                                                                               |
| [browser/prepare.spec.ts](browser/prepare.spec.ts)                       | Stable repeated guards; standard/custom CSS value swaps, property addition/removal/rename, pseudo geometry and external Flexbox sibling width changes without DOM mutation records; restoration returns to valid state.                                                                                                                                                                                       |
| [browser/collapsed-tables.spec.ts](browser/collapsed-tables.spec.ts)     | Browser pixels, alpha, shared-edge ownership, colspan/rowspan and RTL tie resolution; repeated headers and complete selectable rows; outer half-borders avoid border-only pages; unsupported styles/contributions reject.                                                                                                                                                                                     |
| [browser/document-builder.spec.ts](browser/document-builder.spec.ts)     | Loaded browser image snapshots, jsPDF-compatible rotation directions, independently rendered native text/vectors/clipping/bitmaps and flattened Unicode form appearances.                                                                                                                                                                                                                                     |
| [browser/fit-width.spec.ts](browser/fit-width.spec.ts)                   | Wide HTML uniform fitting and automatic landscape while keeping browser wrapping, selectable markers, dimensions and native image locality; equal-scale fitted pixels.                                                                                                                                                                                                                                        |
| [browser/iframe-html.spec.ts](browser/iframe-html.spec.ts)               | Same-origin iframe font/layout ownership, full-document and shadow `renderHTML` output, temporary iframe cleanup, single raster/extraction ownership, wide source fitting, HTML bands and explicit weaker mutation-only verification.                                                                                                                                                                         |
| [browser/image-pdf.spec.ts](browser/image-pdf.spec.ts)                   | PNG File/Blob fitting/download/progress, all JPEG EXIF orientations with original compressed bytes and known corner colors, multipage TIFF byte orders/Group 4 pixels, metadata, cancellation, callback identity and caller-input ownership.                                                                                                                                                                  |
| [browser/multilingual.spec.ts](browser/multilingual.spec.ts)             | Registered Latin/Cyrillic/Chinese/Arabic text against browser pixels and extraction; native Chinese headers and Arabic footers on each page.                                                                                                                                                                                                                                                                  |
| [browser/page-bands.spec.ts](browser/page-bands.spec.ts)                 | Repeated native table headers with each row/column retained; selectable page-number text, independent footer slots and native HTML bands; source edits during preparation, header/first-row atomicity, tight border spacing and invalid/impossible bands/headers.                                                                                                                                             |
| [browser/progress-metadata.spec.ts](browser/progress-metadata.spec.ts)   | Frozen ordered stage-local work counts, owned Unicode metadata, browser-visible progress opportunities, cancellation, original callback exceptions, source changes and malformed preflight options.                                                                                                                                                                                                           |
| [browser/typography.spec.ts](browser/typography.spec.ts)                 | Multiple exact faces, kerning/ligatures/accents/wrapping and measured browser/PDF text origins and pixels across pages; unsupported shaping controls reject.                                                                                                                                                                                                                                                  |
| [browser/variable-font.spec.ts](browser/variable-font.spec.ts)           | Default upright Roboto variable instance retains selectable Latin diacritics and bounded browser/PDF pixel differences.                                                                                                                                                                                                                                                                                       |

## Optional integration and benchmark suites

`npm run benchmark` builds the library, then runs
[benchmarks/export.spec.ts](benchmarks/export.spec.ts) alone on port 5184. Four
synthetic native/hybrid scenarios record the first export plus three warmed
samples, bytes, page counts and machine/browser context. They assert successful
stable PDF output, without a wall-time threshold or jsPDF comparison. Results
and the last PDFs go under ignored `artifacts/benchmarks/`; see
[BENCHMARKS.md](../BENCHMARKS.md) for timing boundaries.

`npm run test:devextreme` uses
[compat/devextreme.spec.ts](compat/devextreme.spec.ts) and port 5185. Set
`RENDERPDF_DEVEXTREME_DIR` to an absolute installed DevExtreme 25.1.5 package
directory; it is not a root dependency. The test exports real paged/selected grid
rows through the adapter, checking Unicode text, truncation, headers and two-part
footers. This optional test does not establish support for every jsPDF plugin.

The independent [playground](../playground/README.md) has its own `npm ci` and
`npm run check`. Its six Chromium tests cover both actual PDF downloads,
extraction/margins/timing-and-size metrics, legacy metadata, HTML upload/file
validation, strict-CSS and page-break controls, reset/empty states and unsafe
markup/resources including shadow-style isolation escapes. Root `npm run check`
does not run it; CI packs the library and tests that installed consumer
separately. Packaging/reinstallation instructions are in its README.

## Fixtures, helpers and evidence

| Path                                                                                                                                                                       | Purpose                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [fixtures/rendering.html](fixtures/rendering.html)                                                                                                                         | Basic two-page experiment and download UI.                                                         |
| [fixtures/invoice.html](fixtures/invoice.html)                                                                                                                             | Public API/resource/preparation entry; tests create synthetic document variants.                   |
| [fixtures/hybrid-pages.html](fixtures/hybrid-pages.html), [fixtures/hybrid.html](fixtures/hybrid.html)                                                                     | Automatic local effects, CSS cuts and the mixed-content download UI.                               |
| [fixtures/document.html](fixtures/document.html), [fixtures/legacy-statement.html](fixtures/legacy-statement.html)                                                         | Isolated local upload preview and generated 180-row legacy template.                               |
| [fixtures/collapsed-tables.html](fixtures/collapsed-tables.html), [fixtures/page-bands.html](fixtures/page-bands.html)                                                     | Native table-border and repeated-header/band sources.                                              |
| [fixtures/typography.html](fixtures/typography.html), [fixtures/variable-font.html](fixtures/variable-font.html), [fixtures/multilingual.html](fixtures/multilingual.html) | Exact-face shaping, variable-default and multilingual samples.                                     |
| [fixtures/benchmark.html](fixtures/benchmark.html), [fixtures/benchmark.ts](fixtures/benchmark.ts)                                                                         | Separate built-library timing harness.                                                             |
| [fixtures/devextreme.html](fixtures/devextreme.html), [fixtures/devextreme.ts](fixtures/devextreme.ts)                                                                     | Optional real-grid adapter harness.                                                                |
| [helpers/image-fixtures.ts](helpers/image-fixtures.ts)                                                                                                                     | Small synthetic encoded image builders for image validation/decoding assertions.                   |
| [browser/pdf-inspector.ts](browser/pdf-inspector.ts)                                                                                                                       | Development-only PDF.js extraction, text transforms, font/image operations and page PNG rendering. |
| `public/fonts/`                                                                                                                                                            | Explicit licensed Noto/Roboto fixture fonts and original third-party license notices.              |

PDF.js normally renders at `1 / 0.75` scale so one CSS reference pixel equals
0.75 PDF points. Phase 0 retains its 96-DPI page, typography and comparator-sentinel
checks, but compares bounded local rasters at their native 2x resolution (192 DPI).
A separate device-scale-2 browser reference and PDF.js scale `2 / 0.75` avoid
comparing downsampled raster text against directly rasterized 96-DPI browser text.
CSS crop coordinates and margins scale together; no alignment, blur, fixture-text
changes or tolerance increases are applied. Fitted-output tests apply the measured fit scale to their
browser reference. Comparisons preserve coordinates; tests do not align or blur
images to improve a score.

Pixelmatch uses `threshold: 0.1` and `includeAA: false`. Gates vary by asserted
region: standard whole-page/typography checks are below 2%, bounded hybrid rasters
below 5%, collapsed borders below 1%, variable fonts below 3%, multilingual crops
below 4%, fitted content below 6% and the HTML-header crop below 10%. Exact
thresholds and color probes live with their assertions. Phase 0 also records raw
RGB diagnostics, whose values are not the visual pass/fail gates. Its baseline
and horizontal-origin checks allow less than 0.02 PDF points. Text assertions
often normalize PDF.js whitespace between independently positioned words.

Regular tests save PDFs, PNGs and JSON metrics under ignored `test-results/`.
Playwright reports, benchmark output and generated packages also remain ignored.
Inspect retained browser/PDF images when a visual assertion fails; do not commit
generated evidence or use supplied private documents as versioned fixtures.

## Boundaries and maintenance

These assertions establish bounded synthetic cases in Chrome. They do not prove
arbitrary HTML/CSS support, Firefox/Safari compatibility, every font/script,
vocalized-Arabic extraction, nondefault variable axes, accessibility tagging or
exhaustive malicious-input protection. Collapsed borders and repeated headers
cover the supported profiles described in the root README, not all CSS tables.

Unit tests alone do not prove visible fidelity; browser/PDF comparisons and
independent PDF.js extraction supply separate evidence. Performance diagnostics
are observations on the current machine, not universal speed guarantees.
The optional benchmark and playground have different timing boundaries.

Update this README whenever adding, changing, renaming or removing tests,
fixtures, helpers or runner configuration. Keep coverage, commands, prerequisites
and limits consistent with actual assertions. Add focused regressions for
meaningful rendering changes and run the required `npm run check` gate.
