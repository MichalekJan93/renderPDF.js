# Phase 0: hybrid rendering feasibility

Research date: 2026-10-22. This is a constrained experiment, not a claim of production HTML/CSS support.

The original Phase 0 findings below are retained as historical measurements.
The user authorized Phase 1 on 2026-10-23; its implementation and verification
are recorded in the final section of this report.

The user subsequently authorized Phases 2 and 3. Their measured implementation
is documented after the Phase 1 record; older scope boundaries remain historical.

Generated evidence files and one-off probes were removed during repository
cleanup. Only the local private preview's HTML and font inputs remain under
ignored `artifacts/preview/`. `npm run check` recreates current test evidence and
build outputs; the measurements recorded here do not require retaining those files.

## Decision

The hybrid approach works for the controlled static Chromium fixtures tested here.
Browser layout, native selectable PDF text, and local raster images can coexist
in one two-page PDF. This supports a scoped Phase 1, while exact glyph shaping,
general stacking contexts, automatic fallback planning, and CSS pagination still
require further work. Keep explicit font programs and replaceable raster/PDF
adapters; do not generalize the findings to arbitrary web pages.

## 1. Text geometry and fonts

`Range.getClientRects()` supplies rectangles for selected DOM content. It is useful for recovering line breaks and horizontal positions, including content laid out by Flexbox and Grid. It does not supply a shaped glyph stream or text baselines. Treat conversion from those rectangles to PDF text as a measured approximation, not a browser typography export API. [MDN: Range.getClientRects](https://developer.mozilla.org/en-US/docs/Web/API/Range/getClientRects)

Wait for fonts before measurement: `document.fonts.ready` resolves after fonts in use finish loading. This does not supply operating-system font bytes for PDF embedding. Use the same explicit font files for browser rendering, raster snapshots, and PDF embedding. Supply regular, bold, and italic faces deliberately; browser-synthesized styling can differ. [MDN: Document.fonts](https://developer.mozilla.org/en-US/docs/Web/API/Document/fonts)

Canvas `TextMetrics.fontBoundingBoxAscent` provides a font metric relative to the configured text baseline. Combined with measured text rectangles it can help estimate a baseline, but needs a browser-versus-PDF comparison for the selected fonts. DOM fragments, line boxes, and font bounding boxes are different concepts. [MDN: TextMetrics.fontBoundingBoxAscent](https://developer.mozilla.org/en-US/docs/Web/API/TextMetrics/fontBoundingBoxAscent)

Fontkit can shape strings and return glyph positions, including OpenType substitution and kerning. That capability does not mean a PDF writer automatically reproduces Chromium shaping. Per-character positioning can discard ligatures; drawing a whole line can accumulate spacing differences. The experiment must document which policy it uses and test Czech accents, mixed weights, wrapping, and difficult pairs such as `AV`, `To`, and `ffi`. Complex scripts, bidi, variable-font axes, and arbitrary fallback fonts remain unproved. [Fontkit API](https://github.com/foliojs/fontkit)

The reviewed PDF-lib custom-font implementation takes glyphs from `font.layout()` but does not propagate the returned glyph positioning array into encoded text. Its width method sums glyph advance widths. The engineering implication is to verify spacing independently rather than assume font embedding solves kerning. No private PDF-lib API should be called to work around this. [PDF-lib custom-font source](https://github.com/Hopding/pdf-lib/blob/master/src/core/embedders/CustomFontEmbedder.ts)

The prototype measures whole lines for wrapping and pagination, then measures
individual words with separate DOM Ranges. Each word keeps its browser origin
and fits its PDF advance to the measured width. This preserves within-word
ligatures and prevents spacing error from accumulating along an entire line.
It remains an approximation inside each word, rather than a complete shaping
implementation. CSS-collapsible edge spaces are represented by word origins;
PDF.js independently verifies reconstructed spaces and extracted Unicode text.

## 2. Raster fallback and composition

SVG `foreignObject` embeds HTML content. SVG used as an image has additional security restrictions: scripts are disabled and external images/stylesheets cannot be loaded in that image context. A working live DOM subtree is therefore insufficient evidence that its serialized snapshot will work. Inline required resources and test the generated image. [MDN: foreignObject](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/foreignObject), [MDN: SVG as an image](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image)

`html-to-image` is a candidate adapter rather than a layout engine. Its documented process clones the subtree, copies computed styles, recreates pseudo-elements, embeds fonts/images, and serializes the result through `foreignObject` and canvas. It saves implementation effort, but inherits snapshot and canvas limits. A tainted canvas or excessively large data URL can still fail. Evaluate this as a replaceable raster boundary instead of making the entire architecture depend on it. [html-to-image implementation overview](https://github.com/bubkoo/html-to-image#how-it-works)

The installed `html-to-image` 1.11.13 changes computed pixel font sizes during
cloning to `floor(fontSize) - 0.1`. This is a fidelity defect for our experiment,
including integer 16px text, and can be worse for fractional sizes. Reviewing
the dependency's public configuration and verifying pixels is necessary;
successful PNG generation alone does not validate the adapter.
[Versioned clone implementation](https://github.com/bubkoo/html-to-image/blob/v1.11.13/src/clone-node.ts#L139-L143)

The adapter avoids that mutation using the public `includeStyleProperties`
option: copy the exact computed `font` shorthand first, then the remaining
computed longhands except `font-size`. A missing shorthand on a text-bearing
element fails explicitly. This keeps all conversion code on public APIs.
One integration constraint remains: this dependency caches its first style
property list module-wide. The isolated Phase 0 adapter is the first caller;
sharing it with an earlier differently configured `html-to-image` consumer is
unproved. Revisit or replace this adapter before a public library release.
[Versioned style-property cache](https://github.com/bubkoo/html-to-image/blob/v1.11.13/src/util.ts#L68-L76)

Rasterize an isolated subtree once, at one place in the paint sequence. Its visible descendants must not also be emitted as vector operations. If adding searchable text, create exactly one invisible text layer from the original measured geometry. PDF-lib documents an invisible text rendering mode and public operators for setting it. Scope its graphics state so subsequent text is visible. Extraction and alignment still require independent tests. [PDF-lib: TextRenderingMode](https://pdf-lib.js.org/docs/api/enums/textrenderingmode), [PDF-lib operators](https://pdf-lib.js.org/docs/api/)

A local snapshot cannot correctly reproduce effects that depend on pixels outside the chosen subtree, including backdrop filters or some blending/stacking configurations. A production planner must expand the capture boundary to an appropriate compositing context or reject the effect. Phase 0 should use a self-contained gradient/shadow region and explicitly reject unsupported compositing rather than claim a universal fallback.

Use bounded raster dimensions, configurable scale, and cleanup in `finally`. Canvas serialization can consume substantial memory; a Blob-based path is preferable for large captures. [MDN: Canvas.toDataURL](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toDataURL)

## 3. Coordinates and pagination

Store all measured geometry in one root-relative CSS pixel coordinate system. Convert to PDF points at the writer boundary with `1 px = 0.75 pt`, invert the vertical axis there, and apply the same page offset to visible objects and invisible text. Keep one explicit page-to-source mapping.

For the Phase 0 experiment, source intervals create two pages and move cuts before
intersected atomic text lines, images, or raster regions. Unit tests exercise cuts
through text and overlapping atomic intervals. Boxes may span intervals under one
page clip; every text/image operation belongs to exactly one interval. Oversized
or inseparable atomic groups fail explicitly. This is a bounded coordinate-mapping
probe, not a general pagination engine: CSS breaks, widows/orphans, table headers,
and arbitrary element fragmentation remain later-phase work.

## Dependency choices

| Candidate          | Phase 0 role                                                            | Trade-off                                                                                    |
| ------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `pdf-lib`          | Browser PDF creation, embedded fonts, rectangles/images, text operators | Public drawing APIs are available, but it is not a browser display-list or CSS engine.       |
| `@pdf-lib/fontkit` | PDF-lib-compatible explicit font embedding                              | Font data and licenses must be supplied; embedding does not prove browser-identical shaping. |
| `html-to-image`    | Optional local snapshot adapter                                         | Less clone/resource code, but inherits `foreignObject`, CORS, and canvas restrictions.       |
| `pdfjs-dist`       | Development-only extraction, operator inspection, PDF page rendering    | Independent verification path; must not become a conversion-runtime dependency.              |
| Playwright         | Development-only Chromium reference rendering                           | Verifies real browser behavior; never required by the client-side converter.                 |

PDF-lib exposes drawing APIs for text, rectangles, images, and pages. Keep those details inside the PDF writer. [PDF-lib: PDFPage](https://pdf-lib.js.org/docs/api/classes/pdfpage)

PDF.js exposes text content with transforms and widths, an operator list, and page rendering. Use these independent outputs to detect lost text, duplicate image/text painting, page-count mistakes, and visual errors. Text extraction alone does not demonstrate accurate selection geometry or accessibility tagging. [PDF.js API source](https://mozilla.github.io/pdf.js/api/draft/api.js.html)

Pixelmatch is used only in development to compare equal-resolution browser/PDF
images. Its fixed perceptual threshold is `0.1`, with `includeAA: false`; the tests
perform no image alignment or blur. Raw RGB differences are retained alongside
the perceptual scores. Separate two-pixel-shift and missing-text controls ensure
that the comparator still rejects meaningful typography regressions.
[Pixelmatch API](https://github.com/mapbox/pixelmatch#api)

## Independently testable experiments

1. **Font/text:** render a fixed-font Czech/English paragraph and basic bold/italic faces; extract the exact Unicode text and compare PDF versus browser positions and pixels. Report baseline and spacing error.
2. **Browser layout:** measure a fixed Flexbox row and Grid; compare expected browser rectangles with PDF output at the same scale. Never reproduce either layout algorithm.
3. **Local raster:** capture one bounded unsupported CSS region with embedded resources. Confirm dimensions and pixels, then confirm exactly one raster image is placed at the intended paint slot.
4. **Hybrid composition:** place vector text before and after the raster region, and test invisible text inside it. Confirm no visible duplication and one extraction occurrence per string.
5. **Page mapping:** export two controlled pages. Verify page count, per-page strings, margins, clipping policy, and image placement without a full-document screenshot.
6. **Negative cases:** unavailable fonts, unsupported styles/compositing, and invalid raster dimensions must produce actionable errors or diagnostics.

## Measured results

### Reproduction and environment

Run `npm ci`, then `npm run check` with Node.js 22.13+ and Google Chrome installed.
The original Phase 0 check ran TypeScript, ESLint, three Vitest pagination cases,
three Playwright browser cases, the Vite demo build, and Prettier. The expanded
current suite is described in the later phase records. Browser evidence is generated under
`test-results/phase0-browser-layout-nati-bca1f--page-mapping-work-together/`;
the real button-download test saves a separate `download.pdf`.

The original final `npm run check` completed successfully: all six tests,
typechecking, lint, the demo build, and formatting passed. Temporary evidence
copies and one-off diagnostic scripts were removed during repository cleanup.
Running the current checks regenerates the ignored test evidence; historical
measurements below remain recorded independently of those generated files.

Measured on 2026-10-22 with Node.js 22.22.0 and Chromium 155.0.8059.86. The lockfile
records the exact toolchain: pdf-lib 1.17.1, @pdf-lib/fontkit 1.1.1,
html-to-image 1.11.13, PDF.js 6.4.299, Playwright 1.64.1, Pixelmatch 8.0.0,
TypeScript 6.0.3, Vite 8.3.5, and Vitest 5.0.5.

### Structural and behavioral results

| Probe                          | Observed result                                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native/selectable Unicode text | Czech sentence extracted exactly once; regular, bold and italic embedded faces found independently by PDF.js.                                                                             |
| Browser layout                 | Flexbox and Grid positions preserved through measured coordinates and pixel comparisons. No layout algorithms implemented.                                                                |
| Local raster                   | Two bounded gradient/rounded/inset-shadow subtrees; each contributes one visible image and extraction-only text.                                                                          |
| Composition                    | Exactly three image paints total: two local rasters and one PNG. No full-document screenshot. Switching the invisible layer off changes zero visible pixels.                              |
| Pagination                     | Two A4 pages; source intervals `[0, 1074.52)` and `[1074.52, 1640)`. All 31 measured text lines, including four invisible lines, retain their page mapping. Final-page text is preserved. |
| Coordinate transfer            | Maximum PDF text-origin error is 0 pt horizontally and below 0.000001 pt vertically relative to the snapshot's estimated coordinates.                                                     |
| Export and isolation           | Valid PDF bytes and Blob; actual button download succeeds without print calls, dialogs, or browser errors. Source markup remains unchanged.                                               |
| Negative behavior              | Invalid scale/budget/offset, missing registered fonts, unsupported positioning, and external raster resources fail explicitly.                                                            |

The coordinate check verifies transfer of the snapshot's **estimated** baseline;
it does not prove that browser glyph baselines are exposed exactly. Appearance
is tested independently through pixels. Full PDF accessibility tagging and
manual selection behavior in other PDF viewers were not assessed.

### Visual results at equal 96 DPI

The browser reference uses device scale 1; PDF.js renders at `4/3` PDF scale.
The raster capture uses scale 2. RGB diagnostics count pixels with any channel
difference above 60. The perceptual gate uses the fixed Pixelmatch settings
described above, with limits of 2% per page, 5% per raster region, and 2% for the
dedicated typography crop. Images are not shifted or blurred to pass.

| Region                           | Raw RGB mismatch | Perceptual mismatch | Gate |
| -------------------------------- | ---------------: | ------------------: | ---: |
| Page 1                           |           1.759% |              1.068% |  <2% |
| Page 2                           |           0.259% |              0.266% |  <2% |
| Raster 1                         |           3.215% |              4.443% |  <5% |
| Raster 2                         |           2.824% |              3.964% |  <5% |
| Kerning/ligature typography crop |           2.322% |              1.679% |  <2% |

The comparator rejects controlled regressions: moving the reference text by
two pixels produces a 20.398% perceptual mismatch; removing it produces 9.069%.
These are fixture measurements, not universal fidelity guarantees.

Two real problems were found and corrected without increasing those limits:

1. Fitting entire PDF lines to browser widths produced nonuniform 1–2 px glyph
   drift. Word-level browser origins reduced the typography crop's raw mismatch
   from 21.814% to 2.322%. Internal word kerning remains approximate.
2. The raster dependency reduced font sizes during cloning. Its public style
   configuration now preserves the exact computed font shorthand. Fractional
   raster origins also need transparent padding inside an integer-aligned image;
   placing a zero-origin bitmap at a half-pixel introduces extra interpolation.
   Padding changes neither the visible subtree's layout nor its text coordinates.

Remaining raster differences include font antialiasing and 2× to 1× sampling.
Fractional page offsets remain part of the common coordinate map. The result is
acceptable under this explicitly measured Phase 0 tolerance, not pixel equality.

### Baselines and next milestone

The final full-check run produced 1,035,985 bytes of PDF data and measured 1,212.5
ms for export; an earlier isolated successful run measured 507.6 ms. These are
single fixture observations on this machine, not performance targets or
statistical benchmarks. Memory usage was not measured. Full font programs are
embedded intentionally; no size optimization or cross-export caching is claimed.
The demo bundle is approximately 1.16 MB before gzip (about 517 kB gzip), and
Vite reports its size warning.

Before extending the supported subset, prioritize positioned/shaped font runs,
resource and font policy, a real stacking/compositing planner, and explicit CSS
fragmentation behavior. Keep their tests independent; the Phase 0 path should
remain a small reproducible experiment rather than accumulate production options.

## Original Phase 0 scope boundary

Phase 0 does not publish a stable `renderPDF()` API, npm package, React adapter, general CSS planner, or production pagination engine. Maintain one small experimental path with separate layout, raster, and PDF responsibilities. Unknown cases must remain visible in errors or this report. Advance only when measured evidence supports the three central assumptions together.

The source must remain static during measurement and capture. Geometry is
snapshotted, while the raster adapter later clones the live subtree; concurrent
application updates and animation are not synchronized by this experiment.

## Phase 1: minimal reusable renderer (2026-10-23)

The rendering pipeline now lives in `src/`. The experiments call that same core;
they retain geometry hooks solely for independent development comparisons.
`src/pdf.ts` is the only pdf-lib adapter. Runtime conversion remains entirely in
the browser, and no new runtime dependency was introduced.

The public entry exports `registerFont`, `renderPDF` and `RenderPDFError`, with
TypeScript contracts. Results provide a page count, structured warnings, copied
bytes, a PDF Blob and a direct download. Paper options cover A4/A3/Letter,
orientation and CSS-pixel margins; source dimensions and wrapping are preserved.
The local document's download button now exercises this public API.

Font registration owns exact static TTF/OTF bytes and associates each immutable
handle with its live browser FontFace. Family, weight and style all participate
in PDF selection. Duplicate programs reuse registration; conflicting descriptors,
missing faces/glyphs, variable fonts, WOFF containers and collections fail
explicitly. This does not solve within-word shaping or exact browser baselines.

Preparation waits for fonts and decoded images without changing the source DOM.
It observes source/ancestor/stylesheet edits, compares root-relative geometry and
computed styles (including generated pseudo boxes) using bounded-memory
checksums, and rejects changed sources. AbortSignal cancellation is cooperative
between stages. This is validation of a caller-owned static source, not an
isolated atomic browser display-list snapshot. Concurrent transient CSSOM edits
or resource changes are not a supported input contract.

Native PNG/JPEG resources can be data/blob, same-origin or CORS-readable URLs.
The writer checks signatures and rejects rotated/mirrored or malformed JPEG EXIF
orientation rather than embedding pixels unlike the browser's oriented image.
Remote image bytes may be fetched again at export time; applications must keep
resources stable. Raster subtrees retain the narrower inline-resource policy.

Measured Phase 1 browser evidence uses the same Chrome 155.0.8059.86 reference,
96-DPI PDF.js rendering, Pixelmatch threshold 0.1 and `includeAA: false`. There is
no alignment adjustment or blur and the existing 2% gate was retained.

| Fixture                    | Measured outcome                                                                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Synthetic invoice          | 3 Letter-landscape pages, asymmetric margins, 52 atomic rows, 3 embedded faces, exact non-whitespace Czech text extraction, one native PNG plus one bounded raster paint. The 960×450 first-page region differs by 0.681%. |
| Synthetic legacy statement | 180 rows on 5 A4 pages; every row's two markers stay together and all source text is extracted. Zero image paints; first-page visual mismatch 0.479%.                                                                      |
| Native JPEG resources      | Same-origin and CORS-allowed images preserve selectable text and exactly one native 48×32 image paint. A real second loopback HTTP origin without CORS permission fails with RESOURCE_LOAD_FAILED.                         |
| Public API failures        | Missing family/weight/glyph, unbroken text overflow, already-aborted and callback-aborted exports, source mutation, CSSOM style edits and generated pseudo-box edits reject with the expected diagnostic.                  |

The final `npm run check` passed: TypeScript, ESLint, 27 unit checks, all 8
Chromium integration tests, library/declaration/demo builds and Prettier. The
original two-page fixture retained its visual gates (1.069%/0.271% page mismatch,
4.453%/4.013% local raster mismatch and 1.679% typography mismatch). Its single
observed export took 820.1 ms and produced 1,035,965 bytes; this is not a
statistical performance claim.

The supplied private legacy document was checked separately through the actual
download button: 5 A4 pages, 1,197,496 bytes, zero image paints, and all 7,433
non-whitespace source characters exactly matched PDF.js extraction. Its original
HTML, local Tahoma programs, PDF and screenshots remain only under ignored
`artifacts/`; none became a versioned test fixture.

The new visual test initially found a browser fallback font while PDF text used
the supplied program. Literal quotes passed to the FontFace constructor changed
family identity; using the actual unquoted family restored matching browser/PDF
font programs. The invoice mismatch fell from 2.274% to 0.681% without relaxing
the tolerance. A first stability implementation retained complete CSS strings
for every element and pseudo-element and exceeded the long-table test timeout;
streaming checksums and skipping absent pseudo boxes made the focused long-table
test pass in 52 seconds, including two exports, download, extraction and pixel
verification. This test duration is not a conversion benchmark or memory
measurement.

The local ESM build keeps its three runtime dependencies external and emits
TypeScript declarations, with a separate bundled demo build. The package remains
private and unpublished. A built-module import without browser globals and a
strict NodeNext TypeScript consumer both passed. The ESM entry is 37.61 kB
(12.42 kB gzip) excluding its runtime dependencies; the bundled demo's shared
runtime chunk is approximately 1.18 MB (521 kB gzip), still triggering Vite's
size warning. Browser compatibility beyond Chromium, exact shaping,
automatic raster selection, stacking contexts, CSS page breaks, repeated table
headers and accessibility tagging remain unverified or unimplemented.

## Phases 2 and 3: automatic local planning and CSS pagination (2026-10-23)

Phase 2 adds a rendering planner for an explicitly bounded set of contained local
effects. `fallback: 'auto'` is the default: the element owning a gradient, inline
bitmap background, rounded corners, inset shadow or opacity becomes one raster
operation. A plain ancestor does not inherit its child's fallback choice, while
a selected parent owns all nested visible descendants exactly once. Text inside
the region contributes only invisible extraction objects where supported.
`fallback: 'strict'` disables automatic selection and retains explicit
`data-raster` regions. Neither mode falls back to an unplanned whole-page image.

Automatic regions retain native positioning, overlap, display and order guards
throughout their descendants. Their boundaries must be independent rectangular
blocks, Flexbox/Grid boxes, inline-blocks or images. Fragmented inline or table
internals, external raster resources, outer shadows, filters, backdrop effects,
transforms, masks and arbitrary stacking contexts are not supported. Resource
and canvas-budget checks still run before any PDF can be returned.

Phase 3 separates page planning from PDF writing: the writer consumes the exact
validated source intervals already used for warnings and page ownership.
`pageBreak: 'css'` is the default. It reads modern `break-before/after: page`,
legacy `page-break-before/after: always` aliases and `avoid/avoid-page` preferences.
`break-inside: avoid` keeps a fitting native block together. Avoidance at an
inter-block boundary conservatively joins both neighboring whole blocks when
possible. `pageBreak: 'auto'` ignores CSS hints and uses required geometry only.

Forced cuts take precedence over soft avoidance. Oversized or incompatible soft
preferences relax with one `BREAK_AVOID_RELAXED` warning per export; this does not
permit splitting intrinsic text lines, images, raster regions, table rows or
rowspans. Forced cuts crossing those items fail with `PAGINATION_FAILED`.
Coincident/root-edge break rules create no empty pages. Native backgrounds and
rectangular borders can span several intervals under the existing page clip.
Paper options now also accept explicit CSS-pixel dimensions, including margins.

This is a controlled subset of fragmentation behavior, not full CSS Paged Media.
The precedence and legacy alias policy was checked against the primary
[CSS Fragmentation Level 3 specification](https://www.w3.org/TR/css-break-3/).
Parity/column breaks, inline or table-cell directives, exact margin-break rules,
widow/orphan line-count policies, cloned box decorations and repeated table
headers remain outside the implementation. Unsupported nondefault line-count
requests and `box-decoration-break: clone` fail explicitly.

Independent Chromium/PDF.js verification retained the existing 96-DPI scale,
Pixelmatch threshold 0.1 and `includeAA: false`, without alignment or blur.

| Fixture                  | Observed result                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic hybrid regions | One 500×400px custom page with native text and exactly two automatically selected captures (420×100px and 420×64px in CSS units, raster scale 2). Nested gradients produce no additional image paint. Full non-whitespace Czech extraction matches the source exactly. Page mismatch is 1.113%; local region mismatches are 4.102% and 0.658%, including group opacity 0.85. |
| CSS fragmentation        | Six custom pages with cuts at source offsets 240, 400, 748, 1028, 1338 and 1678 CSS px. A 140px avoid card moves intact; a long single text node spans pages; all 18 rows and a three-row rowspan keep ownership without duplication. All extracted non-whitespace text matches the source. Every compared page is below the unchanged 2% gate; the maximum is 0.911%.       |
| Strict and unsafe cases  | Explicit strict-mode raster capture remains local; unmarked strict effects, external paint dependencies, outer shadows, overlapping/reordered automatic descendants and fragmented automatic inline regions reject. An inner forced row cut fails; an oversized native avoid region exports complete text with the expected relaxation warning.                              |
| Reviewable demo          | `/hybrid.html` exercises unmarked nested gradients, an inset shadow, custom paper, CSS forced/avoid breaks and a rowspan table through its actual download button. Independent PDF.js extraction matches the entire source, exactly two images are painted, and source markup remains unchanged.                                                                             |

Additional review found three cases that cannot be silently represented by the
bounded paint model. Empty generated pseudo content can still paint a visible
background; wrapping native inline backgrounds/borders cannot use one union
rectangle; and direct text can overlap a later block without overlapping sibling
element boxes. Explicit rejection and browser regressions cover those cases.

No runtime dependency or conversion service was added. The same public pipeline
still serves the original feasibility demo and the private local document.
Exact glyph shaping, automatic handling of arbitrary CSS and browser
compatibility beyond Chromium remain unproved.

Final verification passed `npm run check`: TypeScript, ESLint, all 36 unit checks,
all 12 Chromium integration tests, library/declaration/demo builds and Prettier.
The built ESM entry imported successfully without browser globals; a strict
NodeNext declaration consumer accepted custom paper and both new strategy
options. The library entry is 46.54 kB (14.89 kB gzip), excluding the unchanged
runtime dependencies. The shared demo chunk remains approximately 1.18 MB and
continues to trigger Vite's bundle-size warning.

The supplied private statement was exported once more through its actual button:
5 A4 pages, 1,197,497 bytes, zero image paints, and all 7,433 non-whitespace
characters matched PDF.js extraction exactly. Private source/font/output files
remain ignored under `artifacts/`. MIT LICENSE is unchanged; nothing was
published.

## Development toolchain verification (2026-10-23)

Development tooling now uses pinned Vite+ 1.4.0 with Oxlint, Oxfmt, Vite and
Vitest. Lint, formatting and unit-test settings share `vite.config.ts`;
Playwright remains the independent browser runner. The library still builds as
ESM with external runtime dependencies, followed by TypeScript declaration
emission and the separate demo build. The verified development runtime is Node
22.22.0, recorded in `.node-version`.

A clean `npm ci` and the full `npm run check` passed. Static checks reported no
lint warnings or type errors; all 36 unit tests and all 12 Chromium browser tests
passed against a newly started Vite+ server. No assertions or image-comparison
thresholds were changed. The built ESM entry imported without browser globals,
and a separate strict NodeNext consumer compiled against the emitted declarations.

Comparing TypeScript output with comments removed confirmed that all 16 renderer
modules emit identical JavaScript before and after migration. The original
recommended lint rules retain their error severity; the two omitted syntax rules
are enforced by strict ESM/TypeScript parsing. Two narrow lint explanations cover
intentional validation of untyped JavaScript input and Unicode code-point scanning
for ASCII controls. Runtime dependencies, MIT LICENSE and rendering scope are
unchanged. The existing demo bundle-size warning remains; no controlled toolchain
performance benchmark was performed.
