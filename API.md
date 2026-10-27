# Document API

RenderPDF.js provides four ways to create a PDF: `renderPDF()` for connected HTML,
`renderHTML()` for isolated HTML strings, `imageToPDF()` for image files, and
`createDocument()` for programmatic drawing.
All return or finalize into the same immutable `RenderPDFResult` with `pageCount`,
`warnings`, `toBlob()`, `toUint8Array()` and `download()`.

## Documents and fonts

```ts
import { createDocument } from 'renderpdf-js';

const response = await fetch('/fonts/ReportSans-Regular.ttf');
if (!response.ok) throw new Error('The font could not be loaded.');

const document = await createDocument({
  unit: 'mm',
  format: 'A4',
  fonts: [{ family: 'Report Sans', data: await response.arrayBuffer() }],
  metadata: { title: 'Report' },
});
const page = document.addPage();
page.drawText('Příliš žluťoučký kůň', {
  x: 15,
  y: 25,
  font: 'Report Sans',
  fontSize: 12,
});
await (await document.toResult()).download('report.pdf');
```

`createDocument()` is asynchronous because it prepares fonts. Drawing and
measurement are synchronous afterwards, except `drawImage()` and `appendPDF()`,
which must be awaited. The document API does not require a browser or font
registration in the DOM. Use `registerFont()` separately for HTML exports.

| Setting       | Default                 | Meaning                                                                                    |
| ------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| `unit`        | `'pt'`                  | `'pt'`, `'mm'` or `'px'` for coordinates and dimensions.                                   |
| `format`      | `'A4'`                  | `'A4'`, `'A3'`, `'Letter'` or `{ width, height }` in document units.                       |
| `orientation` | `'portrait'`            | Landscape swaps the supplied base axes.                                                    |
| `fonts`       | Standard PDF fonts      | TTF/OTF bytes, bare base64 or font data URLs with `family`, optional `weight` and `style`. |
| `metadata`    | Title: `'RenderPDF.js'` | Unicode title, author, subject and keyword strings.                                        |
| `signal`      | —                       | Cooperative cancellation via `AbortSignal`.                                                |

Coordinates start at the top-left. Text `y` is a **baseline**, while rectangle and
image `y` is a top edge. Font sizes always use **points**, independent of `unit`.
`1 mm = 72/25.4 pt`; `1 px = 0.75 pt`. Rotation uses clockwise degrees.

Helvetica, Times and Courier include regular, bold, italic and bold-italic faces.
Their character sets are limited. For characters outside those sets, provide an
appropriate TTF/OTF font program. Select an exact face using `font`, `fontWeight` and
`fontStyle`; missing fonts and glyphs fail explicitly. Fonts are not substituted.
Variable TTF programs use only their upright default axes and declared default
weight; nondefault axes must be instantiated before use.

## Page management

`addPage(options?)` returns a page handle. It inherits document defaults; each page
can override its format and orientation. Documents start without an implicit page.

- `getPage(number)` and `getPages()` return existing handles in document order.
- `pageCount` reports the number of physical pages.
- `insertPage(number, options?)` inserts before a one-based position.
- `movePage(from, to)` reorders an existing page.
- `removePage(number)` removes an unreferenced page. Bookmark/link targets and
  pages containing interactive fields cannot be removed; flatten fields first.
- `appendPDF(source, pageNumbers?)` imports supported native pages asynchronously.
- `addBookmark(title, { pageNumber, parent? })` creates a hierarchical page bookmark.
- `flattenForms()` replaces prepared form appearances with ordinary page content.
- `toResult()` finalizes once and reuses the completed result on later calls.

Page handles expose `width`, `height`, `rotation` and `setRotation(degrees)`.
Drawing coordinates are relative to the unrotated MediaBox; imported page origins
and `UserUnit` are normalized into physical document units. Crop boxes and view
rotation remain part of the page.
Page numbers are one-based. Removed handles cannot be drawn into. Bookmarks remain
attached to the same page when pages move. A finalized document cannot be edited.

## Text, graphics and images

`document.measureText(text, options?)` returns `width`, `height`, `ascent` and
`descent` in document units, using the same exact font as drawing.

| Page method                  | Input                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `drawText(text, options)`    | `x`, baseline `y`; optional font face, `fontSize`, `color`, `align`, `lineHeight`, `rotation`, `maxWidth`, `opacity` and `link`. |
| `drawLine(options)`          | `x1`, `y1`, `x2`, `y2`; optional `color`, `width`, `opacity`.                                                                    |
| `drawRectangle(options)`     | `x`, `y`, `width`, `height` and paint settings.                                                                                  |
| `drawEllipse(options)`       | Bounding rectangle and paint settings.                                                                                           |
| `drawCircle(options)`        | Center `x`, `y`, `radius` and paint settings.                                                                                    |
| `drawSvgPath(path, options)` | SVG path data, `x`, `y`, optional `scale`, `rotation` and paint settings.                                                        |
| `drawImage(source, options)` | PNG/JPEG bytes, Blob, data URL, browser canvas/image; rectangle and optional rotation/opacity. **Await this call.**              |

Paint settings are `fill`, `stroke`, `strokeWidth` and `opacity`. Colors accept
hexadecimal, `rgb()`/`rgba()` and common named colors. Unsupported colors fail
explicitly. Text line spacing defaults to `1.15` times the point size.
`drawSvgPath` draws native vector geometry; it does not interpret full SVG files.
Image placement uses the supplied rectangle and applies image orientation. For
multipage TIFF, use `imageToPDF()` and append its PDF result.

Paths use `moveTo()`, `lineTo()`, `curveTo()` and `closePath()`, followed by
`stroke()`, `fill()` or `fillAndStroke()`. `clip()` intersects the clip with the
current path; `discardPath()` ends the path afterwards. `clipRectangle()` combines
these steps. Use `saveGraphicsState()` and `restoreGraphicsState()` to bound
clipping and `transform([a,b,c,d,e,f])` changes.

Pending images, unfinished paths and unmatched graphics states prevent
finalization. Await each asynchronous image before further drawing on that page.

## Links, notes and forms

```ts
page.addLink('https://example.com/report', { x: 15, y: 10, width: 100, height: 20 });
page.addNote('Please review this value.', { x: 150, y: 30, width: 8, height: 8 });
page.addTextField(
  'name',
  { x: 15, y: 50, width: 100, height: 12 },
  {
    value: 'Sample text',
    font: 'Report Sans',
    fontSize: 12,
  },
);
page.addCheckBox('approved', { x: 15, y: 70, width: 6, height: 6 }, { checked: true });
page.addDropdown('status', { x: 15, y: 90, width: 60, height: 12 }, ['Draft', 'Approved'], {
  value: 'Draft',
});
```

Field options include font face, `fontSize`, `textColor`, `borderColor`,
`backgroundColor`, `borderWidth`, `readOnly` and `required`. Text fields support
`multiline` and `maxLength`; dropdowns support `editable` and `multiselect`.
Field names must be unique. Supply a suitable font for Unicode appearances.
Fields are axis-aligned and reject nonidentity graphics transforms.
Field appearance colors must be opaque.
Links accept HTTP, HTTPS, mailto and telephone URLs; executable schemes are rejected.

For a left/right footer, draw independent text objects after the page count is known:

```ts
for (const [index, output] of document.getPages().entries()) {
  output.drawText('Printed by: Example', { x: 15, y: output.height - 8, fontSize: 8 });
  output.drawText(`Page ${index + 1} of ${document.pageCount}`, {
    x: output.width - 15,
    y: output.height - 8,
    fontSize: 8,
    align: 'right',
  });
}
```

## PDF composition

`mergePDFs(sources, options?)` creates one PDF in source/page order.
`extractPDFPages(source, pageNumbers, options?)` preserves the requested one-based
order, including repeats. `splitPDF(source, options?)` returns one result per page.
Inputs accept `File`/`Blob`, `ArrayBuffer`, `Uint8Array` and completed export results;
the application fetches URLs itself. Options support `metadata`, `signal` and
`onProgress` with stage-local counters. `flattenForms: true` optionally paints
prepared ordinary AcroForm appearances before copying pages; by default forms
still fail. Flattening removes editable fields.

Pages retain text, vectors, image resources, sizes, crop boxes and rotation.
Explicit internal page links are remapped to the new page references. Named
destinations, links to omitted pages, encrypted/malformed PDFs, XFA and signed
forms fail explicitly. Interactive AcroForm fields require the explicit flatten
option or earlier flattening by the document owner.
Document-level outlines, signatures, attachments and original metadata are not copied.
Composition is limited to 1,000 pages, 128 MiB per input and 256 MiB total input.

## DevExtreme adapter

```ts
import { createJsPDFAdapter } from 'renderpdf-js';
import { exportDataGrid } from 'devextreme/pdf_exporter';

const doc = await createJsPDFAdapter({
  unit: 'mm',
  format: 'A4',
  orientation: 'landscape',
  fonts: [{ family: 'Report Sans', data: fontBytes }],
});
doc.setFont('Report Sans');
await exportDataGrid({ jsPDFDocument: doc, component: grid, selectedRowsOnly: true });
await doc.save('grid.pdf');
```

The adapter is verified with DevExtreme 25.1.5. Its default unit is
`'mm'`, and it creates an initial page. Font metrics and drawing methods are
synchronous; ordered operations are flushed during asynchronous finalization.
Use `await doc.output('blob')`, `await doc.toBlob()` or `await doc.save(name)`.
Synchronous jsPDF output is not emulated. Fonts must be supplied to the factory;
VFS/runtime font registration and arbitrary jsPDF plugins are unsupported.

Supported methods include page selection/addition, font and color state, text
measurement/wrapping, text/line/rectangle/image drawing, clipping, graphics-state
save/restore and the exporter's unit/color compatibility properties. The adapter
does not expose all jsPDF APIs or its advanced scripting features.

Run the optional integration against your separately installed DevExtreme:

```sh
# Set RENDERPDF_DEVEXTREME_DIR to the absolute installed devextreme package directory.
npm run test:devextreme
```

The regular checks do not require DevExtreme. Its implementation is not copied
into RenderPDF.js, and it is not a runtime or development dependency of the package.
