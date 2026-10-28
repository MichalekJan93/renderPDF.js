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

Open the URL printed by Vite. Upload a file or paste an HTML document into **HTML document**, select **Update preview**, then **Export and compare PDFs**. The application downloads `renderpdf.pdf` and `jspdf.pdf` and shows conversion time, serialized byte size, page count and the faster/smaller result. **Load example** restores the synthetic example.

RenderPDF.js omits selected unsupported decorative CSS by default. Check **Reject omitted CSS effects** to pass `strictCss: true` and reject those effects instead. Currently the default omission covers outer shadows on native elements and selected raster roots, plus table row/group backgrounds. Outer shadows on descendants inside an existing raster region still reject. Supported separated and collapsed table borders retain native rendering. Other unsupported CSS, layout, text, fonts, and resources can still fail. The jsPDF settings are unchanged by this checkbox.

**Respect HTML page breaks** is checked by default and passes `pageBreak: 'css'`. Uncheck it to use `pageBreak: 'auto'`: RenderPDF.js ignores authored forced breaks and keep-together preferences and fills pages from the measured content. Table rows, text lines and local raster regions remain atomic. This setting does not change jsPDF's pagination.

Reinstalling the archive refreshes the lockfile integrity for the current local build, which can differ at the same package version. After changing the library, pack it again from the repository root and reinstall the archive in this application before testing. Restart the dev server to load the refreshed dependency:

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

The six Chromium tests cover two real PDF downloads, extracted Unicode text, page ownership, one local raster paint, matching margins, displayed measurements, HTML uploads, invalid extensions, both settings, and preview/resource isolation including CSS `@scope`. They do not establish equivalent visual fidelity or a reliable performance ranking across the libraries.

Each timing starts immediately before conversion and ends after obtaining the PDF Blob. Preview preparation and browser download handling are excluded. The exports run sequentially on the same connected preview with A4 paper and 24 CSS px margins. jsPDF's HTML plugin has different CSS and pagination support, so compare the downloaded PDFs as well as the numbers; a smaller file does not imply a more faithful page. The first jsPDF export can include loading its HTML plugin dependencies and local fonts.

## Preview and rendering limits

- The preview uses the same document root as the PDF export. It stays at its actual CSS pixel size and can scroll horizontally on small screens.
- Export uses A4 pages with 24 CSS px margins. The continuous HTML preview does not show page cuts.
- The HTML and body styles are mapped to isolated preview wrappers so document CSS does not alter the application's controls.
- The application replaces input font families with explicitly registered Noto Sans regular, bold, and italic. These exact font files are used in the preview and the PDF. Bundled fonts are licensed under the SIL Open Font License; see `public/fonts/OFL.txt`.
- Input must be static HTML and CSS. Informational Content-Type/Content-Language metadata is accepted; document font declarations are discarded because the app explicitly uses Noto Sans. Scripts, refresh metadata, external CSS resources, shadow escape selectors and CSS `@scope` rules are rejected. PNG and JPEG images embedded as data URLs are supported. Missing or external images become visible preview placeholders and block PDF downloading until replaced with supported inline image bytes.
- Rendering supports the library's documented subset of HTML and CSS. Unsupported input and conversion failures are reported separately for each renderer; a successful export still downloads if the other renderer fails. This application does not add general browser printing support.

The example and browser tests use English prose. Diacritic regression samples use HTML numeric references or TypeScript Unicode escapes, so PDF extraction still checks the original non-ASCII glyph coverage.

The application is local test tooling. Do not add private input documents or generated PDFs to Git.
