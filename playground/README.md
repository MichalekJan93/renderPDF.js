# RenderPDF.js playground

A small, independent Vite+ application for comparing the packaged RenderPDF.js library with jsPDF's HTML conversion. Upload a UTF-8 `.html`/`.htm` file (up to 10 MiB), or paste static HTML, then inspect the live preview and export both PDFs. Conversion runs in the browser; the document is not uploaded.

The application imports `renderpdf-js` from the local npm archive through `file:../artifacts/renderpdf-js-0.5.1.tgz` and uses jsPDF's public `html()` API. It never imports the renderer's source directory.

## Run locally

From the repository root, create `artifacts/` if it does not exist, then run:

```sh
npm ci
npm pack --pack-destination artifacts
cd playground
npm uninstall renderpdf-js
npm install ../artifacts/renderpdf-js-0.5.1.tgz
npm run dev
```

Open the URL printed by Vite. Choose **Example 1** (the 200-row user directory) or **Example 2** (the 1,000-row product inventory) from the selector above the editor. The selection loads that document into the editor and preview and clears any previous export results. You can also upload a file or paste an HTML document into **HTML document** and select **Update preview**. **Load example** restores the currently selected bundled document after editing or uploading. **Export and compare PDFs** downloads `renderpdf.pdf` and `jspdf.pdf` and shows conversion time, serialized byte size, page count and the faster/smaller result.

The preview preserves authored `font-family`, weight and style. Example 1 explicitly uses the bundled Playground Sans 400 and 700 faces and is ready to export with those exact fonts. Example 2 requests Times New Roman and exports without an upload in the default **Export with base font and report substitution** mode. The playground passes no font handles to RenderPDF.js for Example 2; the library uses its bundled RenderPDF Base face and returns `FONT_SUBSTITUTED`. Because this comparison exports a connected preview without laying it out again, the preview can retain the browser's Times while its PDF uses the base font; glyph widths and wrapping may differ. jsPDF handles a missing font independently, so its appearance may differ from RenderPDF.js. This fallback comparison does not establish equal font fidelity. Select **Stop RenderPDF.js export with an error** to reject unmatched faces instead; jsPDF can still complete independently.

For an exact Times New Roman comparison, register licensed local TrueType Regular and Bold files. Enter the CSS family, numeric weight and style in **Document font files**, choose each matching `.ttf` file, and select **Register font**. Each visible text face needs an exact family, numeric weight and style match; nearby weights are reported as missing. Uploaded bytes stay in this browser session and are passed to both PDF exporters; the app does not bundle or read system fonts. A document with no explicit family uses the browser's default generic serif, which cannot identify exact font bytes. The font availability list reports missing or unresolvable faces before export, but leaves the export control available so each library can return its own result.

RenderPDF.js omits selected unsupported decorative CSS by default. Check **Reject omitted CSS effects** to pass `strictCss: true` and reject those effects instead. Currently the default omission covers outer shadows on native elements and selected raster roots, plus table row/group backgrounds. Outer shadows on descendants inside an existing raster region still reject. Supported separated and collapsed table borders retain native rendering. Other unsupported CSS, layout, text, fonts, and resources can still fail. The jsPDF settings are unchanged by this checkbox.

**Respect HTML page breaks** is checked by default and passes `pageBreak: 'css'`. Uncheck it to use `pageBreak: 'auto'`: RenderPDF.js ignores authored forced breaks and keep-together preferences and fills pages from the measured content. Table rows, text lines and local raster regions remain atomic. This setting does not change jsPDF's pagination.

**RenderPDF.js source verification** defaults to **Fast static HTML** (`verifySource: 'mutations'`) for this playground's static preview. It detects observed DOM and stylesheet-node mutations during export and emits `SOURCE_VERIFICATION_REDUCED`, shown in the limitations list. It can miss CSSOM edits and computed-style-only changes made by other code during export. Select **Full CSS guard** (`verifySource: 'full'`) to check computed styles and geometry as well; this is the library's normal API default and costs more time on large documents. The RenderPDF.js table row names the selected mode. jsPDF has its own HTML conversion behavior, unaffected by this selector.

**Profile RenderPDF.js stages** is off by default. Enable it to show wall time for the public preparing, layout, pagination, resources, pages and saving progress stages, plus time outside those notifications and Blob creation. The stage intervals, other time and Blob time add up to the displayed RenderPDF.js total, subject to display rounding. Progress callbacks add browser scheduling and source checks, so use the default unchecked setting when comparing total times with jsPDF. The profile does not split resources into font embedding, raster capture and image embedding.

Reinstalling the archive refreshes the lockfile integrity for the current local build, which can differ at the same package version. After changing the library, pack it again from the repository root and reinstall the archive in this application before testing. Stop the running dev server and start it again; `npm run dev` forces Vite to rebuild its dependency cache so the browser does not keep an older package with the same version:

```sh
# Repository root
npm pack --pack-destination artifacts
cd playground
npm uninstall renderpdf-js
npm install ../artifacts/renderpdf-js-0.5.1.tgz
npm run dev
```

## Checks

```sh
npm run check
```

The application check builds the independent consumer and runs its browser smoke tests on port 5181. Google Chrome must be installed for the browser tests. To serve the production build separately, run `npm run preview` and open `http://127.0.0.1:5180/`.

The eleven Chromium tests cover two real PDF downloads, extracted Unicode text, page ownership, local raster paints, matching margins, displayed measurements, HTML uploads, invalid extensions, the CSS and page-break settings, both source-verification modes, optional stage profiling, font upload, and preview/resource isolation including CSS `@scope`. The profile test checks the reported stages, rounded total accounting and the default unchecked path. One test exports bundled Example 1 and checks that every ID stays selectable without rasterizing each row. Another checks that switching to Example 2 loads all 1,000 rows into the preview, clears stale results, and that reset restores the selected document. It exports the authored Times source without passing fonts to RenderPDF.js, checks the bundled-base `FONT_SUBSTITUTED` warning, extracts all 1,000 product labels exactly once, then checks that strict mismatch mode reports the missing Times face. A font test checks that generic serif remains exportable, that strict mismatch mode returns a RenderPDF.js error for missing custom faces while jsPDF can finish, then uploads Regular and Bold fixture files and checks text extracted from both PDFs. A text-free source test checks that both exporters work with the application's minimal bundled registration. These tests do not establish equivalent visual fidelity or a reliable performance ranking across the libraries.

Each timing starts immediately before conversion and ends after obtaining the PDF Blob. Preview preparation, font-file upload and browser download handling are excluded. The exports run sequentially on the same connected preview with A4 paper and 24 CSS px margins. jsPDF's HTML plugin has different CSS and pagination support, so compare the downloaded PDFs as well as the numbers; a smaller file does not imply a more faithful page. The first jsPDF export can include loading its HTML plugin dependencies and registered fonts.

## Preview and rendering limits

- The preview uses the same document root as the PDF export. It stays at its actual CSS pixel size and can scroll horizontally on small screens.
- Export uses A4 pages with 24 CSS px margins. The continuous HTML preview does not show page cuts.
- The HTML and body styles are mapped to isolated preview wrappers so document CSS does not alter the application's controls.
- The app bundles Noto Sans regular, bold and italic for documents that explicitly request `Playground Sans` in CSS and for jsPDF comparison. RenderPDF.js loads its own bundled base faces when no exact source font is passed. Uploaded static TrueType faces use the same bytes for browser layout, RenderPDF.js and jsPDF's public font filesystem when their CSS descriptors match. OTF/CFF files cannot be uploaded through this comparison UI. Generic/system family resolution, oblique style, and jsPDF HTML font weights outside 100–900 in steps of 100 may produce different outputs or renderer errors; the font availability list reports these limits. Font registration accepts a user-declared CSS family; users must choose the matching licensed file. Bundled fonts are licensed under the SIL Open Font License; see `public/fonts/OFL.txt`.
- A missing font in text captured inside a local raster region can make the connected RenderPDF.js export fail with `RASTER_FAILED`: that region would otherwise combine bitmap pixels in the original font with extracted text in the replacement font. Register the matching face for this comparison. The library's separate `renderHTML` entry point can relayout an isolated copy before capturing it.
- Input must be static HTML and CSS. Informational Content-Type/Content-Language metadata is accepted. Authored `@font-face` rules are removed from the isolated preview and reported visibly; register matching local TTF files for used families. Scripts, refresh metadata, external CSS resources, shadow escape selectors and CSS `@scope` rules are rejected. PNG and JPEG images embedded as data URLs are supported. Missing or external images become visible preview placeholders and block PDF downloading until replaced with supported inline image bytes.
- Rendering supports the library's documented subset of HTML and CSS. Unsupported input and conversion failures are reported separately for each renderer; a successful export still downloads if the other renderer fails. This application does not add general browser printing support.

The example and browser tests use English prose. Diacritic regression samples use HTML numeric references or TypeScript Unicode escapes, so PDF extraction still checks the original non-ASCII glyph coverage.

The application is local test tooling. Do not add private input documents or generated PDFs to Git.
