# RenderPDF.js — Project Specification

> Archived original project brief, retained as historical requirements and future
> goals. Its proposed API and initial agent instructions do not describe the
> current implementation. Use [README.md](../README.md) and
> [measured findings](feasibility.md) for current behavior and limitations.

## 1. Project Overview

**Project name:** RenderPDF.js

**Type:** Open-source TypeScript library

**Purpose:** Client-side HTML/CSS to PDF conversion with high visual fidelity and selectable text.

**Target:** Modern browsers, initially Chromium-based browsers.

**Primary ecosystem:** JavaScript, TypeScript, React, Next.js.

### Vision

Build a modern alternative to jsPDF's HTML rendering capabilities and html2canvas-based PDF generation.

The library should convert existing HTML elements into high-quality PDF documents directly in the user's browser, without requiring a backend, headless browser, or native print dialog.

Unlike traditional HTML-to-canvas solutions, RenderPDF.js should preserve selectable text and vector graphics whenever possible.

Use a **hybrid rendering architecture** that combines native PDF primitives with rasterized fallbacks for complex CSS effects.

### Core principle

**Do not reimplement the browser's CSS layout engine.**

Modern browsers already handle layout calculations for Flexbox, Grid, typography, positioning, and other CSS features.

RenderPDF.js should reuse that calculated information and translate it into PDF drawing instructions.

The challenge is not calculating where an element belongs. The challenge is reproducing the browser's visual output in PDF while preserving text and vector information.

---

## 2. Problems We Want to Solve

Existing client-side HTML-to-PDF solutions have several limitations.

### Limited CSS support

Libraries such as html2canvas implement their own rendering logic and cannot reproduce every modern CSS feature.

Examples of potentially problematic properties:

- `box-shadow`
- `filter`
- `backdrop-filter`
- `mix-blend-mode`
- complex gradients
- advanced transforms
- CSS masks
- pseudo-elements
- complex clipping

### Rasterized documents

Solutions that render an entire HTML element to a canvas and insert the resulting image into a PDF produce documents with several disadvantages:

- Text cannot be naturally selected or copied.
- Text becomes blurry when zooming.
- Search and accessibility are limited.
- Large documents may generate unnecessarily large files.

### Pagination problems

HTML content does not naturally map to PDF pages.

Common problems include:

- Text cut between pages.
- Table rows split incorrectly.
- Elements unexpectedly overflowing pages.
- Headers and footers positioned incorrectly.

### Poor developer experience

Developers should not need to manually convert HTML elements into PDF-specific components.

The desired API should work with existing HTML and CSS.

---

## 3. Functional Requirements

### 3.1 Client-side only

The entire conversion process must execute inside the browser.

Requirements:

- No backend required.
- No Puppeteer or Playwright at runtime.
- No external conversion API.
- No uploading document contents to a server.
- No mandatory print dialog.
- Output available as a PDF Blob or Uint8Array.
- Support direct file downloading.

Development tools may use Node.js and Playwright for automated testing.

### 3.2 HTML and CSS rendering

Support existing DOM elements rather than requiring developers to define a new document structure.

The browser should calculate layout using its native rendering engine.

RenderPDF.js should inspect:

- DOM structure.
- Computed styles.
- Bounding rectangles.
- Text fragments and line geometry.
- Stacking and clipping information.
- Images and other embedded resources.

Use browser APIs such as:

- `getComputedStyle()`
- `getBoundingClientRect()`
- `getClientRects()`
- `Range.getClientRects()`
- `document.fonts.ready`

These APIs provide useful layout data, but do not expose the complete browser display list. Additional rendering logic will still be necessary.

### 3.3 Hybrid rendering

Implement two complementary rendering paths.

**Vector renderer**

Use native PDF drawing instructions for supported elements:

- Text
- Solid backgrounds
- Rectangles
- Borders
- Basic border radius
- Lines
- Basic SVG primitives when practical
- Images embedded as PDF image objects

Text must remain selectable whenever supported.

**Raster fallback**

For elements containing unsupported or excessively complex CSS, rasterize only the necessary visual region instead of the entire document.

Examples:

- Advanced filters
- Complex shadows
- Unsupported gradients
- Complex clipping
- CSS masks
- Advanced blending

Investigate browser-native SVG `foreignObject` rendering as one possible fallback strategy.

Libraries such as `html-to-image` may be evaluated as implementation dependencies, but their limitations must be tested.

Do not assume that `foreignObject` guarantees perfect rendering in every browser.

### 3.4 Searchable text in rasterized regions

If a region must be rasterized, investigate whether its text can also be represented using a correctly positioned, non-visible PDF text layer.

Requirements:

- The visible appearance must not be duplicated.
- Text extraction must remain accurate where possible.
- Text selection should correspond closely to the visible text.
- Unsupported text should generate a diagnostic warning.

Do not claim that this approach guarantees perfect text fidelity for every CSS transformation or font.

### 3.5 Pagination

Support standard PDF page sizes:

- A4
- A3
- Letter
- Custom width and height

Support:

- Page margins.
- Automatic page breaks.
- Explicit page breaks.
- Basic `break-before`, `break-after`, and `break-inside` behavior.
- Avoiding unnecessary splitting of small blocks.
- Multiple-page documents.

Advanced table splitting, repeated headers, footers, and full CSS Paged Media support can be implemented in later versions.

---

## 4. Proposed Architecture

Design RenderPDF.js as a modular rendering pipeline.

```text
                     HTML Element
                          |
                          v
                  DOM Preparation
                          |
                          v
               Browser Layout Snapshot
                          |
                          v
                Render Tree Builder
                          |
                          v
                 Rendering Planner
                          |
                 +--------+--------+
                 |                 |
                 v                 v
          Vector Renderer    Raster Fallback
                 |                 |
                 +--------+--------+
                          |
                          v
                   Page Composer
                          |
                          v
                     PDF Writer
                          |
                          v
                       PDF Blob
```

### Module A — DOM Preparation

Responsibilities:

- Validate the source element.
- Wait for fonts to load.
- Handle image loading.
- Resolve relevant external assets where permitted.
- Determine document dimensions.
- Prepare a stable rendering snapshot.
- Avoid modifying the original application UI.

Explore whether to work with live DOM geometry or an isolated DOM clone.

If cloning is used, ensure that layout-affecting styles, width, fonts, and relevant state remain consistent.

Support cancellation and useful error reporting.

### Module B — Layout Snapshot

Read computed browser layout information and convert it into an internal, normalized representation.

Each render node should contain information such as:

```typescript
interface RenderNode {
  id: string;
  type: "element" | "text" | "image" | "svg";
  bounds: Rectangle;
  style: ComputedRenderStyle;
  children: RenderNode[];
  renderingStrategy: "vector" | "raster";
}
```

This interface is illustrative and may be redesigned.

Important: CSS Grid and Flexbox should not require custom layout implementations.

The browser has already calculated their positions.

However, reproducing paint order, stacking contexts, clipping, inline formatting, and visual effects remains the library's responsibility.

### Module C — Rendering Planner

Analyze each node and decide how it should be rendered.

Possible strategies:

1. Native PDF rendering.
2. Raster fallback.
3. Hybrid composition.
4. Unsupported feature with an explicit diagnostic.

Avoid rasterizing a parent simply because one child has an unsupported effect, unless the compositing requirements make isolating that child unsafe.

Respect paint order and stacking contexts.

Do not double-render children already included in a rasterized parent.

### Module D — Vector Renderer

Translate supported visual primitives into PDF operations.

Initial support should focus on:

- Text
- Rectangles
- Background colors
- Borders
- Simple rounded corners
- Images

Pay particular attention to font metrics, Unicode, and text positioning.

Consider `pdf-lib` and `@pdf-lib/fontkit` as candidate dependencies.

Font support must include Czech characters and common Latin diacritics.

Do not assume arbitrary operating-system fonts can be extracted from the browser.

Investigate explicit font registration and font embedding.

### Module E — Raster Renderer

Render unsupported visual regions as images.

Goals:

- Preserve visual fidelity.
- Capture only necessary regions.
- Support configurable raster scale.
- Avoid oversized canvases.
- Minimize output file size.
- Respect browser security restrictions.

Potential techniques:

- SVG `foreignObject`
- `html-to-image`
- Canvas-based rendering as a secondary fallback

Document limitations involving:

- Cross-origin resources.
- CORS.
- Fonts.
- Embedded iframes.
- Canvas tainting.
- Browser-specific behavior.

### Module F — Pagination Engine

Map browser coordinates into PDF pages.

Use consistent coordinate conversion between CSS pixels and PDF points.

At the standard CSS reference resolution:

`1 CSS px = 0.75 PDF pt`

Account for:

- Margins.
- Page offsets.
- Content clipping.
- Page boundaries.
- Explicit breaks.
- Element splitting.

Do not simply export one enormous screenshot and slice it into pages.

The pagination engine should operate on the rendering representation so that text and supported vector elements remain native PDF objects.

### Module G — PDF Writer

Compose all rendering operations into a PDF document.

Responsibilities:

- Create pages.
- Draw text and vector primitives.
- Embed images.
- Embed supported fonts.
- Apply transformations.
- Handle coordinate conversion.
- Export Uint8Array and Blob.
- Download the final document.

Keep this module isolated so the underlying PDF library can be replaced if necessary.

---

## 5. Public TypeScript API

The API must be simple, strongly typed, and framework-agnostic.

### Basic usage

```typescript
import { renderPDF } from "renderpdf-js";

const element = document.querySelector("#invoice");

if (!element) {
  throw new Error("Element not found");
}

const pdf = await renderPDF(element, {
  format: "A4",
  orientation: "portrait",
  margin: 16,
  pageBreak: "auto",
  rasterScale: 2,
});

await pdf.download("invoice.pdf");
```

The package name is provisional and must be checked for npm availability.

### Blob export

```typescript
const pdf = await renderPDF(element);

const blob = await pdf.toBlob();
const bytes = await pdf.toUint8Array();
```

### Advanced options

Investigate an options interface resembling:

```typescript
interface RenderPDFOptions {
  format?: "A4" | "A3" | "Letter";
  orientation?: "portrait" | "landscape";

  margin?: number | {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };

  pageBreak?: "auto" | "css";

  rasterScale?: number;

  fallback?: "auto" | "raster" | "strict";

  debug?: boolean;

  signal?: AbortSignal;

  onProgress?: (progress: RenderProgress) => void;

  onWarning?: (warning: RenderWarning) => void;
}
```

This is a proposed API, not a final implementation contract.

Keep the public interface minimal and avoid introducing options without a clear use case.

### React and Next.js

The library must work with ordinary DOM references.

Example:

```tsx
"use client";

import { useRef } from "react";
import { renderPDF } from "renderpdf-js";

export function ExportButton() {
  const documentRef = useRef<HTMLDivElement>(null);

  async function handleExport() {
    if (!documentRef.current) return;

    const pdf = await renderPDF(documentRef.current);
    await pdf.download("document.pdf");
  }

  return (
    <>
      <div ref={documentRef}>
        <h1>Invoice</h1>
        <p>Hello from RenderPDF.js</p>
      </div>

      <button onClick={handleExport}>
        Export PDF
      </button>
    </>
  );
}
```

React-specific wrappers are not required for the initial implementation.

The core library should remain framework-independent.

---

## 6. MVP Scope

Do not attempt complete CSS support in the first version.

The first milestone is a working technical proof of concept that validates the architecture.

### Required MVP functionality

**HTML**

- `div`
- `span`
- `p`
- `h1` through `h6`
- Basic inline formatting
- `img`
- Simple tables, where practical

**CSS**

- Font size
- Font weight
- Text color
- Background color
- Text alignment
- Basic borders
- Basic border radius
- Padding and margins through browser-calculated geometry
- Basic opacity

**Layout**

- Block layout
- Flexbox
- Grid

Flexbox and Grid support means using browser-calculated element positions, not implementing the layout algorithms independently.

**PDF**

- A4 output
- Multiple pages
- Selectable text
- Unicode font handling for Czech and English
- Embedded images
- Browser download
- Blob export
- Basic raster fallback

### Out of scope for MVP

- Pixel-perfect parity for arbitrary websites.
- Complete CSS specification coverage.
- Complex nested transformations.
- Full support for advanced blending.
- Perfect pagination of arbitrary tables.
- Cross-origin iframe rendering.
- Full accessibility tagging.
- PDF/A compliance.
- Support for every writing system.
- Internet Explorer or legacy browsers.

Complex cases should fail predictably or use a documented fallback rather than silently generating incorrect content.

---

## 7. Technology Stack

Preferred stack:

- TypeScript with strict mode.
- Vite for development and demo.
- Vitest for unit tests.
- Playwright for browser integration tests.
- ESLint.
- Prettier.

Candidate libraries:

- `pdf-lib` for PDF creation.
- `@pdf-lib/fontkit` for embedded fonts.
- `html-to-image` for investigating raster fallback.
- `pdfjs-dist` for PDF verification in tests.

Do not introduce unnecessary runtime dependencies.

Avoid undocumented or private APIs of third-party libraries.

The library should eventually support ESM distribution, TypeScript declarations, and tree shaking.

---

## 8. Testing Strategy

Visual correctness is a critical aspect of this project.

Create a test suite of HTML fixtures covering:

1. Basic document with headings and paragraphs.
2. Flexbox cards.
3. CSS Grid layout.
4. A simple invoice.
5. Images and borders.
6. Long document spanning multiple pages.
7. Czech text and Unicode characters.
8. Complex CSS requiring raster fallback.

### Visual regression tests

Use Playwright to render the original HTML in Chromium.

Generate a PDF using RenderPDF.js.

Render the resulting PDF pages to images using PDF.js.

Compare the original browser appearance with the PDF output at equivalent dimensions and scaling.

Allow carefully defined tolerances for font rasterization and anti-aliasing differences.

### Structural PDF tests

Verify:

- The output is a valid PDF.
- The expected number of pages is generated.
- Text can be extracted.
- Czech diacritics are preserved.
- Simple text is not converted into a full-page screenshot.
- Elements are not unexpectedly duplicated.
- Page boundaries do not silently discard content.

### Browser testing

Start with Chromium.

Introduce Firefox and Safari testing after the core rendering pipeline is stable.

---

## 9. Diagnostics and Developer Experience

RenderPDF.js should help developers understand rendering limitations.

Examples:

```text
[RenderPDF] Unsupported CSS filter detected.
[RenderPDF] Raster fallback applied to element #card.
[RenderPDF] Font could not be embedded.
[RenderPDF] Cross-origin image could not be loaded.
```

Warnings should be available programmatically.

Debug mode should eventually expose:

- Render node bounds.
- Vector versus raster regions.
- Page boundaries.
- Unsupported CSS features.
- Rendering performance metrics.

Avoid excessive logging in production.

---

## 10. Performance Requirements

Performance and memory usage matter, especially for large documents.

Architectural requirements:

- Avoid rasterizing the entire document by default.
- Reuse fonts and image resources.
- Cache resources within an export operation.
- Avoid unnecessary repeated DOM measurement.
- Avoid repeated forced synchronous layout where possible.
- Release temporary canvases and object URLs.
- Split large raster workloads to avoid canvas size limits.
- Support cancellation.

Measure time and memory consumption in automated benchmarks.

Do not invent performance targets before collecting baseline measurements.

---

## 11. Development Phases

### Phase 0 — Feasibility Research

Before building the complete library, investigate and document the hardest technical challenges.

Create small isolated experiments to answer:

1. Can we accurately map browser text geometry into selectable PDF text?
2. Can we preserve Czech diacritics and basic font styling?
3. Can Flexbox and Grid content be exported using existing browser geometry?
4. Can we capture complex CSS regions with sufficient visual fidelity?
5. Can native PDF text and rasterized elements be composited without obvious visual artifacts?
6. Can we paginate a document without turning everything into images?

Identify any browser limitations that make the proposed architecture impractical.

Produce a technical feasibility report.

### Phase 1 — Minimal Working Renderer

Implement a first end-to-end conversion pipeline.

Requirements:

- Accept an HTMLElement.
- Read browser layout.
- Create PDF pages.
- Draw basic rectangles and backgrounds.
- Draw selectable text.
- Embed basic images.
- Export a PDF Blob.

### Phase 2 — Hybrid Rendering

Implement:

- Rendering strategy detection.
- Raster fallback for unsupported visual regions.
- Correct composition order.
- Basic text overlay for fallback regions when feasible.
- Rendering warnings.

### Phase 3 — Pagination

Implement basic multipage support with appropriate coordinate mapping and element splitting behavior.

### Phase 4 — Developer Experience

Add:

- Public TypeScript API.
- React and Next.js examples.
- Documentation.
- Tests.
- Build configuration.
- npm package preparation.

---

## 12. Repository Structure

Use a simple repository initially.

Suggested organization:

```text
renderpdf-js/
├── src/
│   ├── core/
│   ├── dom/
│   ├── layout/
│   ├── render-tree/
│   ├── renderers/
│   │   ├── vector/
│   │   └── raster/
│   ├── pagination/
│   ├── fonts/
│   ├── assets/
│   ├── pdf/
│   ├── types/
│   └── index.ts
├── examples/
│   ├── vanilla/
│   └── react/
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── docs/
├── package.json
├── tsconfig.json
└── README.md
```

This is a starting suggestion, not a requirement to create empty folders.

Prefer maintainable modules and clear responsibilities over premature abstraction.

---

## 13. Engineering Principles

These principles are important for this project.

**1. Understand before implementing.**

Do not blindly integrate existing libraries without understanding their behavior, limitations, and maintenance status.

**2. Prefer browser-native layout.**

Do not build a new Flexbox, Grid, or typography layout engine unless research proves that a narrowly scoped component is necessary.

**3. Avoid unnecessary rasterization.**

Native PDF text and vector drawing should be the preferred rendering strategy.

**4. Avoid silent failures.**

Unsupported features must be detectable through warnings, explicit fallback behavior, or errors.

**5. Write maintainable TypeScript.**

Use strong types, clear interfaces, and separation of responsibilities.

**6. Do not overengineer.**

Start with the smallest architecture that can demonstrate the core rendering approach.

**7. Preserve compatibility.**

Avoid calling undocumented private functions of third-party packages.

**8. Test actual rendering.**

Passing unit tests alone does not establish visual correctness.

**9. Treat visual fidelity as measurable.**

Use reference documents, screenshot comparisons, and PDF structure tests.

**10. Be critical of the architecture.**

If the proposed approach has fundamental limitations, report them before committing to a large implementation.

---

## 14. Definition of Done for the First Proof of Concept

The first proof of concept will be considered successful when it can:

1. Convert a real HTML element into a valid PDF entirely in Chromium.
2. Preserve simple text as selectable PDF text, including Czech diacritics.
3. Preserve the positions of basic Flexbox and Grid layouts.
4. Render basic backgrounds, borders, and images.
5. Demonstrate raster fallback on at least one unsupported CSS effect.
6. Generate a simple two-page document without losing content.
7. Export the result as a Blob and download it without opening the print dialog.
8. Pass basic automated visual and structural tests.
9. Report known rendering limitations honestly.

A successful proof of concept does not need to support arbitrary production HTML.

---

## 15. Instructions for Codex

Start by reviewing this specification critically.

**Your first task is architectural analysis, not implementation of the full library.**

1. Evaluate whether the proposed hybrid approach is technically feasible using public browser APIs.
2. Identify the most difficult technical problems, particularly text rendering, stacking contexts, CSS fallback, and pagination.
3. Research suitable dependencies and explain their trade-offs.
4. Suggest changes to the architecture where necessary.
5. Propose a minimal proof of concept that validates the highest-risk assumptions.
6. Divide implementation into small, independently testable milestones.
7. Document architectural decisions and known limitations.

Do not claim complete CSS support.

Do not create an unnecessarily complex framework.

Do not start implementing the full rendering engine before validating the feasibility of the core approach.

**The ultimate goal is to build RenderPDF.js: a client-side, TypeScript-first HTML-to-PDF library that combines modern CSS rendering with native, selectable PDF content and intelligent raster fallbacks.**
