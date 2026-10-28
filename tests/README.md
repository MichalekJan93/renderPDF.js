# Test coverage and execution

The repository tests the supported RenderPDF.js browser renderer, its public API,
source ownership, and npm package boundaries. The current suite contains five
unit-test files and six Playwright spec files. Parameterized unit cases expand
to 61 tests; the browser specs contain 15 tests. The runner output is the source
of truth for the count after changes.

All versioned inputs are synthetic. Tests do not require private documents,
system font programs, the local `docs/` directory, or the separate playground.
Playwright, PDF.js, PNG processing and pixel comparisons are development tools;
they are not runtime conversion services.

Fixture prose, controls and diagnostics are written in English. Unicode
regressions retain Czech-Latin diacritics as explicit `\uXXXX` escapes in
TypeScript and numeric character references in HTML. These samples exercise
non-ASCII extraction and registered faces without embedding Czech sentences.

## Prerequisites

Run commands from the repository root after `npm ci`. Use the supported Node.js
version described in the root [README](../README.md); `.node-version` records
the verified runtime.

Browser tests require an installed Google Chrome. The Playwright configuration
selects `browserName: 'chromium'` with `channel: 'chrome'`, so downloading
Playwright's separate Chromium binary alone does not satisfy this configuration.
Tests start their own Vite server on `http://127.0.0.1:5183` with a strict port
and do not reuse an existing server. Leave port 5183 available and allow local
loopback access. The JPEG resource test also opens an OS-assigned loopback port
to exercise a real cross-origin/CORS boundary.

The browser configuration defaults to one worker, a 1000 x 900 CSS-pixel viewport and device
scale factor 1. Start no separate development server for these tests. Avoid
editing source files while they run: the Vite server can reload an active
fixture and invalidate a test.

## Commands

| Command                                             | What it runs                                                                                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                                     | Required complete gate: formatting, lint, strict TypeScript, unit tests, browser tests, library/declaration build and package inventory validation. |
| `npm test -- --run`                                 | All unit tests once, without a browser.                                                                                                             |
| `npm test -- --run tests/pagination.test.ts`        | One unit-test file.                                                                                                                                 |
| `npm test -- --run -t "keeps a complete table row"` | Unit cases whose names match the supplied pattern.                                                                                                  |
| `npm run test:browser`                              | All Chromium browser tests; starts and stops the test server automatically.                                                                         |
| `npm run test:browser -- tests/browser/api.spec.ts` | One browser spec file.                                                                                                                              |
| `npm run test:browser -- --grep "CSS page breaks"`  | Browser tests whose names match the supplied pattern.                                                                                               |
| `npm run test:browser -- --headed`                  | Browser tests with a visible Chrome window.                                                                                                         |
| `npm run test:browser -- --list`                    | List discovered browser tests without running them.                                                                                                 |
| `npm run typecheck`                                 | Strict TypeScript checks, without lint or formatting.                                                                                               |
| `npm run lint`                                      | Source lint rules.                                                                                                                                  |
| `npm run format:check`                              | Formatting validation without rewriting files.                                                                                                      |
| `npm run build`                                     | Library JavaScript and declarations, including type checking.                                                                                       |
| `npm run check:package`                             | Validate npm's dry-run package inventory; requires an existing library build.                                                                       |

Unit tests are selected by `tests/**/*.test.ts` in `vite.config.ts`. Playwright
selects `tests/browser/*.spec.ts` through `playwright.config.ts`.

## Unit-test coverage

| File                                     | Assertions covered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [fonts.test.ts](fonts.test.ts)           | Explicit font registration owns immutable byte copies; equivalent case-insensitive descriptors and concurrent registration deduplicate; conflicting programs, external faces and weight ranges reject; browser decode failure permits retry; variable fonts, WOFF/WOFF2, collections and truncated SFNT directories reject; static CFF OpenType is admitted by the container guard; forged, removed or other-document handles fail; generic/injected family names, fractional weights and empty bytes reject. These tests mock the browser font decoder rather than prove actual font rendering.                                               |
| [images.test.ts](images.test.ts)         | PNG/JPEG signature recognition preserves bytes; JPEG EXIF orientation 1 is accepted in both TIFF byte orders; orientations 2-8 and invalid values reject; truncated APP1 segments, out-of-range IFD offsets, invalid orientation types and excessive entry counts reject; non-Exif APP1 metadata is ignored; unsupported resource signatures reject. This is format/metadata validation, not full bitmap decoding.                                                                                                                                                                                                                             |
| [page.test.ts](page.test.ts)             | CSS-pixel margins, copied per-edge margins, Letter landscape dimensions, default A4, A3 and custom sizes; landscape swaps custom axes; invalid font lists, formats, dimensions, orientation, margins, raster scale, warning callback, fallback and page-break values reject before PDF creation.                                                                                                                                                                                                                                                                                                                                               |
| [pagination.test.ts](pagination.test.ts) | Source intervals partition the source once; cuts move before atomic lines and are rechecked against overlaps; rows and rowspan groups stay atomic; oversized/invalid atomic geometry rejects; forced boundaries are ordered and deduplicated without empty root-edge pages; natural pages precede distant forced cuts; cuts through lines/rowspans reject; fitting avoid preferences move together; forced breaks override avoidance; oversized or incompatible avoid chains relax with one warning; invalid source extents and out-of-range metadata reject. These cases use synthetic measured geometry and do not implement browser layout. |
| [package.test.ts](package.test.ts)       | The npm inventory validator accepts required public entries and flat declarations; rejects unintended/private/development files, missing required entries, duplicates, nonpositive/fractional byte sizes and malformed npm output. The actual generated inventory is checked separately by `npm run check:package`.                                                                                                                                                                                                                                                                                                                            |

## Browser-test coverage

### Public API: [browser/api.spec.ts](browser/api.spec.ts)

- Export a synthetic invoice with three exact font faces across multiple
  families, Flexbox/Grid content, 52 table rows, a native PNG and one explicit
  local raster. Exercise Letter landscape pages and asymmetric margins.
- Check valid PDF bytes, Blob MIME type and byte equality, defensive output
  copies, warning callback/result agreement, per-page text and page dimensions,
  exact non-whitespace Czech extraction, one occurrence of raster text, two
  local image paints, font selection, a measured heading origin and both row
  endpoints on one physical page. Compare a fixed first-page browser/PDF region
  at equal scale and verify an actual download contains the same bytes.
- Reject unregistered families/faces, missing glyphs, overflowing unbroken text,
  cancellation before export and from a warning callback, concurrent DOM edits,
  CSSOM stylesheet changes and generated-pseudo changes during export.
- Export a native JPEG from same-origin and CORS-enabled sources, preserving
  selectable Czech text and the 48 x 32 encoded image. Reject a displayed but
  unreadable cross-origin image without CORS. All resource servers are local.

### Legacy documents: [browser/document.spec.ts](browser/document.spec.ts)

- Upload a generated 180-row legacy `FONT`/`CENTER`/table document through the
  actual file chooser and download its PDF. The test starts the preview in
  `?empty=1` mode, so no ignored private default input is needed.
- Verify multiple pages, exact non-whitespace Czech text and final text,
  every row's two unique endpoints exactly once on its measured physical page,
  no raster images, preserved source DOM, no print call or uncaught browser
  error, and a first-page browser/PDF pixel comparison.
- Reject a replacement containing a script, keep the last valid preview and
  prove that the supplied script did not execute.

### Hybrid rendering and CSS breaks: [browser/hybrid-pagination.spec.ts](browser/hybrid-pagination.spec.ts)

- Automatically select two bounded raster regions for local effects, including
  nested ownership and group opacity. Assert exact encoded image dimensions,
  one capture per owner, complete Czech extraction without duplicated raster
  text, native text around the regions, warnings and unchanged source DOM.
  Compare the complete custom page and both local regions against the browser.
- Compare `pageBreak: 'css'` with `'auto'` on the same source. Check forced
  before/after cuts, a fitting keep-together card, a paragraph flowing over
  multiple pages, all 18 table rows and a three-row spanning cell. Assert full
  text, per-page ownership and equal-scale pixels on every CSS-mode page.
- Check `fallback: 'strict'` rejects unmarked effects while explicit
  `data-raster` still exports. Check strict outer-shadow rejection, backdrop
  effects, overlapping/reordered siblings and automatic descendants, fragmented
  gradient/solid inline paint, text overlapped by later paint, generated boxes
  and a forced break inside an atomic row. Verify oversized avoid content
  relaxes with a warning and retains complete native text.
- Export a gradient with an outer shadow and `SMALL`, plus a collapsed-border
  table with a colored row, under the default CSS omission policy. Verify one
  local image, all expected text and unchanged source; `strictCss: true`
  rejects the unsupported decoration. This verifies successful content export,
  not faithful rendering of the omitted decoration or collapsed borders.
- Exercise the actual hybrid-demo download button and independently check a
  valid multipage PDF, complete text, exactly two local images, status recovery,
  preserved source and no uncaught browser errors.

### Preparation and source ownership

| File                                                                     | Assertions covered                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [browser/export-preparation.spec.ts](browser/export-preparation.spec.ts) | The public export decodes its source image once. Full source fingerprints are read twice without a warning callback and three times with one. Both paths produce one page. A late CSSOM change during image writing has no DOM mutation record but still rejects with `SOURCE_CHANGED`. Browser API instrumentation is restored afterward; the test counts work rather than enforcing a machine-dependent time limit. |
| [browser/prepare.spec.ts](browser/prepare.spec.ts)                       | Repeated checks of unchanged state succeed. Standard/custom CSS value swaps, custom property addition/removal/rename at equal property counts, pseudo-element geometry changes and an external Flexbox sibling changing source width are detected without DOM mutation records. Restoring the original CSS returns the guard to the original valid state.                                                             |

### Phase 0 integration: [browser/phase0.spec.ts](browser/phase0.spec.ts)

- Exercise the reusable rendering core through the original two-page
  experiment. Check browser Flexbox/Grid layout, normal/bold/italic Czech text,
  kerning/ligature stress text, two local raster regions and one native image,
  contiguous page/source mapping, unique expected text, font resources, native
  and invisible text positions, local image sizes, preserved source and no
  export-time HTTP dependency beyond the test inspector.
- Compare both complete pages, bounded raster crops and typography crops with
  the browser. Exporting with the invisible raster-text layer disabled must
  change zero visible PDF pixels and remove that extraction text. Deliberately
  shifting reference typography by two pixels and erasing it must fail the
  comparator's sensitivity checks.
- Reject nonpositive/oversized raster scale, missing fonts, unsupported
  positioning, an unregistered computed family, external raster resources and
  invalid fractional raster offsets.
- Exercise the real download button; check PDF signature/size, two-page status,
  button recovery and absence of printing, dialogs and browser/console errors.

## Fixtures, helpers and visual evidence

| Path                                                             | Purpose                                                                                                                                                                                  |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [fixtures/rendering.html](fixtures/rendering.html)               | Basic two-page experiment and actual download UI used by the Phase 0 suite.                                                                                                              |
| [fixtures/invoice.html](fixtures/invoice.html)                   | Public API invoice, resource and preparation test entry. Tests construct synthetic rows, images and diagnostic sources in the browser.                                                   |
| [fixtures/hybrid-pages.html](fixtures/hybrid-pages.html)         | Automatic local-effects fixture; tests replace its content for CSS pagination and failure cases.                                                                                         |
| [fixtures/hybrid.html](fixtures/hybrid.html)                     | Mixed multipage demo with an actual PDF download button.                                                                                                                                 |
| [fixtures/document.html](fixtures/document.html)                 | Static local-document chooser and isolated preview used by the upload tests.                                                                                                             |
| [fixtures/legacy-statement.html](fixtures/legacy-statement.html) | Synthetic legacy template; the test fills its placeholder with 180 generated rows.                                                                                                       |
| [browser/pdf-inspector.ts](browser/pdf-inspector.ts)             | Shared development-only PDF.js helper, not a test. Parses generated PDFs, extracts text/transforms/font IDs, counts image paint operations and dimensions, and renders each page to PNG. |
| `public/fonts/`                                                  | Explicit Noto Sans fixture faces with their SIL Open Font License. No system font extraction is used.                                                                                    |

PDF.js renders at `1 / 0.75` scale: one CSS reference pixel equals 0.75 PDF
points, so its 96-DPI pixels match Chromium screenshots at device scale 1.
References preserve browser coordinates and page/source intervals. Tests do not
align or blur the images to improve a score.

The visual gates use Pixelmatch with `threshold: 0.1` and `includeAA: false`.
Whole-page or fixed-region mismatch gates are below 2%; bounded local rasters
are below 5%; the Phase 0 typography crop is below 2%. Phase 0 also retains raw
RGB-difference diagnostics with a channel tolerance of 60, but those raw values
are not the visual pass/fail gates. Its baseline and horizontal-origin checks
allow less than 0.02 PDF points against the measured mapping. Extraction checks
often normalize whitespace that PDF.js synthesizes between positioned words.

Tests save generated PDFs, PNGs and JSON metrics under ignored `test-results/`.
Any Playwright reports or coverage output also remain ignored. Inspect retained
browser/PDF images and metrics when a visual assertion fails; do not commit
generated evidence or replace synthetic inputs with private documents.

## Boundaries and maintenance

These tests establish the asserted behavior for bounded synthetic documents in
Chrome. They do not establish arbitrary HTML/CSS support, Firefox/Safari
compatibility, exact glyph shaping for all scripts/fonts, accessibility tagging,
collapsed-border fidelity, repeated table headers or exhaustive security
coverage. Performance numbers written into diagnostic output are observations;
the suite does not enforce a conversion-speed benchmark or compare jsPDF.

Browser tests serve the repository source through Vite. The library build and
package checks validate generated entries and the npm inventory; they do not
replace an independent installed-consumer test. A local `playground/`, when
present, has its own commands and suite and is outside the root check.

Update this README whenever tests, assertions, fixtures, helpers or test
configuration change, so the commands, covered behavior and stated limits stay
accurate. Add a focused regression for meaningful rendering changes and run the
required `npm run check` before completing the change.
