# RenderPDF.js playground

A small, independent Vite+ application for comparing the packaged RenderPDF.js library with jsPDF's HTML conversion. Upload a UTF-8 `.html`/`.htm` file (up to 10 MiB), or paste static HTML, then inspect the live preview and export both PDFs. Conversion runs in the browser; the document is not uploaded.

The application imports `renderpdf-js` from the local npm archive through `file:../artifacts/renderpdf-js-0.6.1.tgz` and uses jsPDF's public `html()` API. It never imports the renderer's source directory.

## Run locally

From the repository root, create `artifacts/` if it does not exist, then run:

```sh
npm ci
npm pack --pack-destination artifacts
cd playground
npm uninstall renderpdf-js
npm install ../artifacts/renderpdf-js-0.6.1.tgz
npm run dev
```

Open the URL printed by Vite. Import a UTF-8 HTML file, select the people directory or product catalog example, or paste markup into **HTML**. The left column contains the input and RenderPDF.js options, with export, results and library messages directly below them. The right column shows the continuous browser preview and can be much longer than the controls on the left. **Reload** restores the selected example after editing. Export downloads `renderpdf.pdf` and `jspdf.pdf` and shows time, serialized size, page count and diagnostics.

**RenderPDF.js options** is a JSON object containing every public `renderPDF` option. The initial values match the library defaults. `null` represents an omitted option, including the conditional `fontMismatch` policy: fallback applies without explicit fonts, while exact supplied fonts select error mode unless a fallback family is chosen. Font handles, `AbortSignal`, and warning/progress callbacks cannot be represented by JSON; leave their entries `null`. The playground supplies registered font handles and optional profiling callbacks separately. Text `header` and `footer` objects are supported; connected HTML bands require DOM elements and are unavailable in this editor. Unknown keys and invalid values show an error and block export. A partial object is valid and lets the library fill omitted defaults.

The preview preserves authored `font-family`, weight and style. Example 1 explicitly uses the bundled Playground Sans 400 and 700 faces and is ready to export with those exact fonts. Example 2 requests Times New Roman and exports without an upload: no exact font handles are passed to RenderPDF.js, so its conditional default uses the bundled RenderPDF Base face and reports `FONT_SUBSTITUTED`. The connected preview can retain browser Times while its PDF uses the base font; glyph widths and wrapping may differ. jsPDF handles a missing font independently. Set `"fontMismatch": "error"` in the options object to reject unmatched RenderPDF.js faces; jsPDF can still finish.

For an exact Times New Roman comparison, open **Fonts and profiling** and register licensed local TrueType Regular and Bold files. Enter the CSS family, numeric weight and style, choose each matching `.ttf` file, and select **Register font**. Each visible text face needs an exact family, numeric weight and style match; nearby weights are reported as missing. An uploaded family can also be named in JSON `fontFallback` for text whose requested CSS face is unavailable. Uploaded bytes stay in this browser session and are passed to both PDF exporters; the app does not bundle or read system fonts. A document with no explicit family uses the browser's default generic serif, which cannot identify exact font bytes. The font availability list reports missing or unresolvable faces before export, but leaves the export control available so each library can return its own result.

RenderPDF.js omits selected unsupported decorative CSS by default. Set `"strictCss": true` to reject those effects instead. Current default omission covers outer shadows on native elements and selected raster roots, plus table row/group backgrounds. Other unsupported CSS, layout, text, fonts, and resources can still fail. The jsPDF path is independent of this setting.

The initial `"pageBreak": "css"` honors supported authored page breaks. Set it to `"auto"` to fill pages from measured geometry while ignoring authored forced breaks and keep-together preferences. Table rows, text lines and local raster regions remain atomic. jsPDF pagination is unaffected.

The initial `"verifySource": "full"` uses the library's CSS and geometry guard. Set it to `"mutations"` for a faster but weaker check of observed DOM and stylesheet-node changes. This emits `SOURCE_VERIFICATION_REDUCED`; CSSOM edits and computed-style-only changes can be missed. The RenderPDF.js result row names the selected mode. jsPDF is unaffected.

**Profile RenderPDF.js stages** is off by default. Enable it to show wall time for the public preparing, layout, pagination, resources, pages and saving progress stages, plus time outside those notifications and Blob creation. The stage intervals, other time and Blob time add up to the displayed RenderPDF.js total, subject to display rounding. Progress callbacks add browser scheduling and source checks, so use the default unchecked setting when comparing total times with jsPDF. The profile does not split resources into font embedding, raster capture and image embedding.

Reinstalling the archive refreshes the lockfile integrity for the current local build, which can differ at the same package version. After changing the library, pack it again from the repository root and reinstall the archive in this application before testing. Stop the running dev server and start it again; `npm run dev` forces Vite to rebuild its dependency cache so the browser does not keep an older package with the same version:

```sh
# Repository root
npm pack --pack-destination artifacts
cd playground
npm uninstall renderpdf-js
npm install ../artifacts/renderpdf-js-0.6.1.tgz
npm run dev
```

## Checks

```sh
npm run check
```

The application check builds the independent consumer and runs its browser smoke tests on port 5181. Google Chrome must be installed for the browser tests. To serve the production build separately, run `npm run preview` and open `http://127.0.0.1:5180/`.

After installing Playwright Firefox and WebKit (`npx playwright install firefox webkit`)
and making Microsoft Edge available, run `npm run build` followed by
`npm run test:cross-browser` to repeat all twelve packaged consumer tests in
Edge, Firefox and WebKit. The Edge project uses the installed `msedge` channel,
or `RENDERPDF_EDGE_EXECUTABLE` can point to an absolute Edge executable. This
suite starts its own production preview on port 5181 and runs 36 cases with one
worker. Playwright WebKit tests the Safari engine, not the Safari application.
Use the root's manual Safari fixture for a separate Safari.app export check.

For a clearly labeled local Chromium alternative, set `PLAYGROUND_BROWSER_EXECUTABLE` to its absolute executable path before `npm run check`. The default remains the configured Google Chrome channel.

The twelve Chromium tests cover two real PDF downloads, extracted Unicode text, page ownership, local raster paints, displayed measurements, HTML uploads, invalid extensions, JSON CSS and page-break settings, both source-verification modes, optional stage profiling, font upload, and preview/resource isolation including CSS `@scope`. The UI test checks logo/badge placement, the left-side export and message panels alongside a long right-side preview, the complete default options object, invalid-JSON blocking and a changed margin in an exported PDF. The profile test checks reported stages, rounded total accounting and the default unchecked path. One test exports bundled Example 1 and checks every ID stays selectable without rasterizing each row. Another loads Example 2 with all 1,000 rows, checks reset, then exports the authored Times source without font handles, checks `FONT_SUBSTITUTED`, extracts all product labels exactly once, and checks that strict mismatch reports the missing Times face. A font test checks that generic serif remains exportable, strict mode returns a RenderPDF.js error for missing custom faces while jsPDF can finish, then uploads Regular and Bold fixture files and checks extracted text from both PDFs. A text-free source test checks both exporters with the application's minimal registration. These tests do not establish equivalent visual fidelity or a reliable performance ranking across the libraries.

Each timing starts immediately before conversion and ends after obtaining the PDF Blob. Preview preparation, font-file upload and browser download handling are excluded. Exports run sequentially on the same connected preview. RenderPDF.js receives the parsed JSON options; jsPDF stays at A4 portrait with 24 CSS px margins. If you change RenderPDF.js page geometry, the two outputs no longer use matching paper settings. jsPDF's HTML plugin has different CSS and pagination support, so compare the downloaded PDFs as well as the numbers; a smaller file does not imply a more faithful page. The first jsPDF export can include loading its HTML plugin dependencies and registered fonts.

## Preview and rendering limits

- The preview uses the same document root as the PDF export. It stays at its actual CSS pixel size and can scroll horizontally on small screens.
- The continuous HTML preview does not show page cuts. Its source width remains 745.7 CSS px; changing PDF page options does not reflow this connected preview. RenderPDF.js starts with A4 and 24 CSS px margins, and the JSON editor can change them. jsPDF remains fixed at those initial settings.
- The HTML and body styles are mapped to isolated preview wrappers so document CSS does not alter the application's controls.
- The app bundles Noto Sans regular, bold and italic for documents that explicitly request `Playground Sans` in CSS and for jsPDF comparison. RenderPDF.js loads its own bundled base faces when no exact source font is passed. Uploaded static TrueType faces use the same bytes for browser layout, RenderPDF.js and jsPDF's public font filesystem when their CSS descriptors match. OTF/CFF files cannot be uploaded through this comparison UI. Generic/system family resolution, oblique style, and jsPDF HTML font weights outside 100–900 in steps of 100 may produce different outputs or renderer errors; the font availability list reports these limits. Font registration accepts a user-declared CSS family; users must choose the matching licensed file. Bundled fonts are licensed under the SIL Open Font License; see `public/fonts/OFL.txt`.
- A missing font in text captured inside a local raster region can make the connected RenderPDF.js export fail with `RASTER_FAILED`: that region would otherwise combine bitmap pixels in the original font with extracted text in the replacement font. Register the matching face for this comparison. The library's separate `renderHTML` entry point can relayout an isolated copy before capturing it.
- Input must be static HTML and CSS. Informational Content-Type/Content-Language metadata is accepted. Authored `@font-face` rules are removed from the isolated preview and reported visibly; register matching local TTF files for used families. Scripts, refresh metadata, external CSS resources, shadow escape selectors and CSS `@scope` rules are rejected. PNG and JPEG images embedded as data URLs are supported. Missing or external images become visible preview placeholders and block PDF downloading until replaced with supported inline image bytes.
- Rendering supports the library's documented subset of HTML and CSS. Unsupported input and conversion failures are reported separately for each renderer; a successful export still downloads if the other renderer fails. This application does not add general browser printing support.

The example and browser tests use English prose. Diacritic regression samples use HTML numeric references or TypeScript Unicode escapes, so PDF extraction still checks the original non-ASCII glyph coverage.

The application is local test tooling. Do not add private input documents or generated PDFs to Git.
