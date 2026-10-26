# RenderPDF.js playground

A small, independent Vite+ application for checking the packaged library. Paste static HTML, update its live preview, and download a PDF. Conversion runs in the browser; the document is not uploaded.

The application imports `renderpdf-js` from the local npm archive through `file:../artifacts/renderpdf-js-0.2.0.tgz`. It never imports the library's source directory.

## Run locally

From the repository root, create `artifacts/` if it does not exist, then run:

```sh
npm ci
npm pack --pack-destination artifacts
cd playground
npm uninstall renderpdf-js
npm install ../artifacts/renderpdf-js-0.2.0.tgz
npm run dev
```

Open the URL printed by Vite. Paste an HTML document or fragment into **HTML dokument**, select **Aktualizovat náhled**, then **Stáhnout PDF**. **Načíst ukázku** restores the synthetic example.

Reinstalling the archive refreshes the lockfile integrity for the current local build, which can differ from the committed build even at the same package version. After changing the library, pack it again from the repository root and reinstall the archive in this application before testing. Restart the dev server to load the refreshed dependency:

```sh
# Repository root
npm pack --pack-destination artifacts
cd playground
npm uninstall renderpdf-js
npm install ../artifacts/renderpdf-js-0.2.0.tgz
npm run dev
```

When the library version changes, use the corresponding archive filename printed by `npm pack`.

## Checks

```sh
npm run check
```

The application check builds the independent consumer and runs its browser smoke tests on port 5181. Google Chrome must be installed for the browser tests. To serve the production build separately, run `npm run preview` and open `http://127.0.0.1:5180/`.

## Preview and rendering limits

- The preview uses the same document root as the PDF export. It stays at its actual CSS pixel size and can scroll horizontally on small screens.
- Export uses A4 pages with 24 CSS px margins. The continuous HTML preview does not show page cuts.
- The HTML and body styles are mapped to isolated preview wrappers so document CSS does not alter the application's controls.
- The application replaces input font families with explicitly registered Noto Sans regular, bold, and italic. These exact font files are used in the preview and the PDF. Bundled fonts are licensed under the SIL Open Font License; see `public/fonts/OFL.txt`.
- Input must be static HTML and CSS. Informational Content-Type/Content-Language metadata is accepted; document font declarations are discarded because the app explicitly uses Noto Sans. Scripts, refresh metadata and external CSS resources are rejected. PNG and JPEG images embedded as data URLs are supported. Missing or external images become visible preview placeholders and block PDF downloading until replaced with supported inline image bytes.
- Rendering supports the library's documented subset of HTML and CSS. Unsupported input and conversion failures are reported in the interface; this application does not add general browser printing support.

The application is local test tooling. Do not add private input documents or generated PDFs to Git.
