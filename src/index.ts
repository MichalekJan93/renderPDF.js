export { renderPDF } from './render-pdf.js';
export { renderHTML } from './render-html.js';
export type { RenderHTMLBand, RenderHTMLTextBand, RenderHTMLOptions } from './render-html.js';
export { imageToPDF } from './image-pdf.js';
export { registerFont } from './fonts.js';
export { RenderPDFError } from './diagnostics.js';
export { createDocument, PDFBuilder } from './document.js';
export { PDFPageBuilder } from './document-page.js';
export { mergePDFs, extractPDFPages, splitPDF } from './compose-pdf.js';
export type { PDFSource, PDFCompositionOptions } from './compose-pdf.js';
export { createJsPDFAdapter, JsPDFAdapter } from './jspdf-adapter.js';
export type {
  JsPDFAdapterFont,
  JsPDFAdapterTextOptions,
  JsPDFAdapterMeasureOptions,
  JsPDFAdapterColorOptions,
} from './jspdf-adapter.js';
export type {
  DocumentUnit,
  DocumentPageOptions,
  PDFDocumentOptions,
  DocumentFontOptions,
  DocumentTextMetrics,
  DocumentRectangle,
  DocumentShapeOptions,
  DocumentTextOptions,
  DocumentLineOptions,
  DocumentImageSource,
  DocumentImageOptions,
  DocumentFieldOptions,
  DocumentTextFieldOptions,
  DocumentCheckBoxOptions,
  DocumentDropdownOptions,
  DocumentBookmarkOptions,
  DocumentBookmark,
} from './document-types.js';
export type { RenderErrorCode, RenderWarning } from './diagnostics.js';
export type {
  FontSource,
  RegisteredFont,
  PageMargins,
  PDFPageOptions,
  ImageSource,
  ImagePDFOptions,
  CustomPageSize,
  PageTextOptions,
  PageTextSlotsOptions,
  PageHTMLBandOptions,
  PageBandOptions,
  PDFMetadata,
  RenderStage,
  RenderProgress,
  RenderPDFOptions,
  RenderPDFResult,
} from './api-types.js';
