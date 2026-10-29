# Changelog

This file covers every version published to npm. Dates are npm publication
dates. The **Where** column names the main code or documentation areas, rather
than every changed file. The **Why** column describes the problem each change
addresses. Release contents were checked against the Git tags, commit diffs and
npm version history.

## [0.6.0](https://www.npmjs.com/package/renderpdf-js/v/0.6.0) — 2026-10-29

| What changed                                                                                                                                                                  | Where                                                                                                    | Why                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Allow HTML export without caller-supplied fonts, load licensed base faces only when needed, and report or reject missing CSS faces through `fontMismatch` and `fontFallback`. | `src/base-font.ts`, `src/fonts.ts`, `src/render-html.ts`, `src/render-pdf.ts`, `src/pdf.ts`, `README.md` | Make the common no-font call usable while keeping substitutions visible and exact-font mode available.     |
| Keep simple rounded boxes native, improve safe local raster selection and ordered composition, and avoid duplicate fallback text or image paint.                              | `src/planner.ts`, `src/layout.ts`, `src/raster.ts`, `src/pdf.ts`                                         | Preserve selectable text and local image boundaries in mixed HTML documents.                               |
| Omit selected unsupported outer shadows and table decoration by default, offer `strictCss` rejection, and refine browser-measured inline text and table handling.             | `src/planner.ts`, `src/layout.ts`, `src/render-pdf.ts`, `README.md`                                      | Export supported content without silently claiming unsupported decoration was reproduced.                  |
| Reuse prepared resources while retaining CSSOM source checks, and compare local raster pixels at the capture scale in browser regressions.                                    | `src/render-pdf.ts`, `src/raster.ts`, `tests/browser/`, `tests/README.md`                                | Reduce repeated export work and make visual regressions less sensitive to downsampling.                    |
| Add a plain two-column playground with HTML examples, JSON options, font registration, a live preview, and export results and diagnostics below the left editor.              | `playground/`, `README.md`, `tests/README.md`                                                            | Let users exercise the packaged public API and find export outcomes without scrolling past a long preview. |
| Validate the published package inventory and expand browser checks for font substitution, CSS policy and the independent consumer.                                            | `scripts/check-package.ts`, `tests/`, `playground/tests/`                                                | Catch missing assets, unsupported behavior and integration regressions before publication.                 |

Font substitution can change line wrapping when `renderPDF()` exports an already
connected source. `renderHTML()` can relayout an isolated copy; register exact
font bytes when matching the browser's text geometry matters. The renderer
remains experimental and does not support arbitrary HTML/CSS.

## [0.5.1](https://www.npmjs.com/package/renderpdf-js/v/0.5.1) — 2026-10-27

| What changed                                                                                                                    | Where                                                                           | Why                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Validate PDF container syntax, decoded object/xref stream budgets and page/form ownership before backend traversal.             | `src/pdf-input.ts`, `src/compose-pdf.ts`, `README.md`, `API.md`                 | Bound structural allocations and reject ambiguous or cyclic input explicitly.                                           |
| Reject additional/chained PDF actions and unsafe copied URI schemes, including during form flattening.                          | `src/compose-pdf.ts`                                                            | Prevent unsupported active actions from surviving page composition.                                                     |
| Decode CCITT TIFF runs into a fixed packed raster with checked row bounds.                                                      | `src/ccitt.ts`, `src/tiff.ts`                                                   | Prevent small malformed fax strips from growing unbounded temporary run arrays while retaining valid Group 2/3/4 scans. |
| Apply strict bitmap and bounded PNG validation to freshly fetched native HTML image bytes.                                      | `src/pdf.ts`                                                                    | Keep export-time responses behind the same validation boundary as standalone image input.                               |
| Reject hidden template content, active/customized raster elements and unsupported CSS scope rules before attachment or cloning. | `src/render-html.ts`, `src/raster.ts`, `playground/src/preview.ts`, `README.md` | Close template/host-isolation bypasses and avoid repeating existing application callbacks.                              |
| Pin existing GitHub Actions versions to immutable commits.                                                                      | `.github/workflows/check.yml`                                                   | Prevent a moved upstream version tag from silently changing CI code.                                                    |

PDF composition now requires the documented strict input profile. Some otherwise
valid PDFs with ambiguous parser controls or unsupported structural stream
encodings must be normalized by their owner before import. HTML raster capture
also rejects inline event handlers and custom/customized elements before cloning.

Security regression scripts, fixtures and reports remain local under ignored
`artifacts/` paths.

## [0.5.0](https://www.npmjs.com/package/renderpdf-js/v/0.5.0) — 2026-10-27

| What changed                                                                                                                                            | Where                                                                                        | Why                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Render tested horizontal Latin, Cyrillic, Simplified and Traditional Chinese, and unvocalized Arabic HTML text, including RTL and mixed-direction runs. | `src/layout.ts`, `src/text.ts`, `src/page-bands.ts`, `src/pdf.ts`                            | Keep browser-measured placement and selectable PDF text when the document contains common non-Latin scripts.       |
| Break programmatic CJK text without spaces and preserve logical extraction of ordinary Arabic ligatures.                                                | `src/document-page.ts`, `src/document.ts`                                                    | Make `createDocument()` wrap Chinese text and let readers copy unvocalized Arabic words in their original order.   |
| Resolve equal collapsed-table border conflicts from the inline start side in both LTR and RTL tables.                                                   | `src/table-borders.ts`                                                                       | Match the browser's shared-border color when a table is right-to-left.                                             |
| Add licensed Arabic and regional Chinese test fonts, browser/PDF pixel and extraction checks, and a language-support checklist.                         | `public/fonts/`, `tests/fixtures/multilingual.html`, `tests/browser/`, `README.md`, `API.md` | Make the supported scripts reproducible and document required font coverage and remaining language limits clearly. |

The HTML renderer still requires exact registered TTF/OTF faces and embeds full
font programs; large CJK fonts can increase PDF size. Vertical writing and
automatic per-glyph font fallback remain unsupported. Arabic vowel marks render,
but text extraction can move a mark around a ligature, so vocalized Arabic is
outside the selectable-text guarantee. Other scripts have not been verified.

## [0.4.0](https://www.npmjs.com/package/renderpdf-js/v/0.4.0) — 2026-10-27

| What changed                                                                                                              | Where                                                  | Why                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Accept default-instance variable TTF fonts, base64 font data, nearby CSS weights and fonts registered in a source iframe. | `src/fonts.ts`, `src/document.ts`, `src/dom.ts`        | Reuse existing font programs in HTML, document and DevExtreme exports without adding several static files or losing exact font ownership. |
| Convert an HTML string in an isolated iframe or shadow root, with an explicit fallback family for copied content.         | `src/render-html.ts`, `src/layout.ts`, `src/raster.ts` | Let applications export complete HTML documents without managing temporary hosts, font registration and cleanup themselves.               |
| Add `fit: 'width'` and `orientation: 'auto'` to HTML export.                                                              | `src/page.ts`, `src/render-pdf.ts`, `src/pdf.ts`       | Keep the browser's original line wrapping while fitting wide content onto the chosen PDF page.                                            |
| Repeat left, center and right selectable text or a static HTML element in page headers and footers.                       | `src/page-bands.ts`, `src/render-pdf.ts`, `src/pdf.ts` | Put print attribution and page numbers in the same footer, or reuse custom browser-rendered decoration on every page.                     |
| Add opt-in `flattenForms: true` when merging or selecting PDF pages.                                                      | `src/compose-pdf.ts`                                   | Allow ordinary prepared AcroForm appearances to join a native PDF composition without losing other page text and vectors.                 |
| Add `verifySource: 'mutations'` as an explicit faster source check.                                                       | `src/prepare.ts`, `src/render-pdf.ts`                  | Reduce repeated computed-style reads for large HTML tables when the caller accepts weaker detection of CSSOM-only changes.                |

Variable fonts remain limited to their default axes; automatic optical sizing
must be disabled when an `opsz` axis would change the browser's outline. HTML
page bands are static across pages; page-number placeholders belong in text
slots. Mutation-only verification reports its reduced guarantee. The browser
renderer remains experimental and does not support arbitrary HTML/CSS.

## [0.3.0](https://www.npmjs.com/package/renderpdf-js/v/0.3.0) — 2026-10-26

| What changed                                                                                                  | Where                                                                                        | Why                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Add `createDocument()` with text, vector drawing, images, links, notes, forms, bookmarks and page management. | `src/document.ts`, `src/document-page.ts`, `src/document-types.ts`, `src/document-colors.ts` | Create and edit structured PDFs directly, including in Node.js, without routing programmatic output through HTML or page screenshots. |
| Add `mergePDFs()`, `extractPDFPages()` and `splitPDF()` using native PDF pages.                               | `src/compose-pdf.ts`                                                                         | Preserve selectable text, vectors, images and page geometry during composition instead of flattening entire pages.                    |
| Add a jsPDF-compatible adapter for the tested DevExtreme PDF exporter contract.                               | `src/jspdf-adapter.ts`                                                                       | Let existing grid exports move to RenderPDF.js with a smaller application rewrite.                                                    |
| Publish a detailed document API guide and compatibility checks.                                               | `API.md`, `tests/compat/`, `tests/document-*.test.ts`                                        | Make the new drawing and integration contracts testable and discoverable.                                                             |

## [0.2.1](https://www.npmjs.com/package/renderpdf-js/v/0.2.1) — 2026-10-26

| What changed                                                                                                                  | Where                                                  | Why                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| Reorganize installation, examples, options and supported-scope documentation; align the playground guide and package version. | `README.md`, `playground/README.md`, package manifests | Make the 0.2 APIs and their limits easier to find and use correctly. |

This was a documentation release. It did not change `src/` runtime behavior.

## [0.2.0](https://www.npmjs.com/package/renderpdf-js/v/0.2.0) — 2026-10-26

| What changed                                                                                    | Where                                                                            | Why                                                                            |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Add `imageToPDF()` for PNG, JPEG and multipage TIFF, including supported orientation handling.  | `src/image-input.ts`, `src/image-geometry.ts`, `src/image-pdf.ts`, `src/tiff.ts` | Export standalone scans and image files without first wrapping them in HTML.   |
| Add repeated native table headers, reserved page text bands and more measured pagination rules. | `src/page-bands.ts`, `src/pagination.ts`, `src/render-pdf.ts`, `src/pdf.ts`      | Keep common reports readable when tables continue across pages.                |
| Paint supported collapsed table borders as native PDF geometry.                                 | `src/table-borders.ts`, `src/layout.ts`                                          | Match browser table appearance without turning the entire table into a bitmap. |
| Add document metadata and progress callbacks; extend cancellation to image conversion.          | `src/export-options.ts`, `src/progress.ts`, `src/api-types.ts`                   | Give applications control and feedback during longer exports.                  |

## [0.1.0](https://www.npmjs.com/package/renderpdf-js/v/0.1.0) — 2026-10-25

| What changed                                                                                                                                      | Where                                                                                           | Why                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Publish the first browser `renderPDF()` and `registerFont()` APIs, with measured HTML layout, selectable PDF text and explicit TTF/OTF ownership. | `src/layout.ts`, `src/fonts.ts`, `src/pdf.ts`, `src/render-pdf.ts`                              | Reuse browser layout while keeping text searchable and avoiding a conversion server.                        |
| Add local raster fallback, CSS-aware pagination and strict errors for unsupported rendering.                                                      | `src/planner.ts`, `src/raster.ts`, `src/pagination.ts`, `src/diagnostics.ts`                    | Preserve supported visual effects without silently flattening an entire document or hiding fidelity limits. |
| Refine browser text positions and source-state checks; add the independent playground, browser tests and CI.                                      | `src/text.ts`, `src/prepare.ts`, `playground/`, `tests/browser/`, `.github/workflows/check.yml` | Catch changed sources and rendering regressions before the first public library release.                    |

## [0.0.0-stage](https://www.npmjs.com/package/renderpdf-js/v/0.0.0-stage) — 2026-10-25

| What changed                                                                                      | Where                                                       | Why                                                             |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| Publish a temporary package-name placeholder containing only a short README and package metadata. | npm package only; no corresponding Git tag or renderer code | Stage the npm publishing setup before the first usable release. |

`0.0.0-stage` was not a functional RenderPDF.js release. The unpublished Git
development version `0.0.0` is included in the 0.1.0 history, not listed as a
separate npm release.
