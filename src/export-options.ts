import type { PDFMetadata } from './api-types.js';
import type { PDFDocument } from 'pdf-lib';
import { RenderPDFError } from './diagnostics.js';

/** Validate and own metadata before the caller can mutate nested settings during an export. */
export function resolveMetadata(
  /** Optional caller-owned PDF document properties. */
  value: PDFMetadata | undefined,
): Readonly<PDFMetadata> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RenderPDFError('INVALID_OPTIONS', 'PDF metadata must be an object.');
  }
  const { title, author, subject, keywords } = value;
  if (
    [title, author, subject].some((field) => field !== undefined && typeof field !== 'string') ||
    (keywords !== undefined &&
      (!Array.isArray(keywords) ||
        Array.from(keywords).some((keyword) => typeof keyword !== 'string')))
  ) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'PDF metadata title, author and subject must be strings; keywords must be an array of strings.',
    );
  }
  return Object.freeze({
    ...(title !== undefined ? { title } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(subject !== undefined ? { subject } : {}),
    ...(keywords !== undefined ? { keywords: Object.freeze([...keywords]) } : {}),
  });
}

/** Apply the same document properties for HTML and standalone image exports. */
export function applyPDFMetadata(
  /** PDF document owning these Info dictionary values. */
  pdf: PDFDocument,
  /** Validated, copied properties; omitted fields retain the shared defaults. */
  metadata: Readonly<PDFMetadata> | undefined,
): void {
  pdf.setTitle(metadata?.title ?? 'RenderPDF.js');
  if (metadata?.author !== undefined) pdf.setAuthor(metadata.author);
  if (metadata?.subject !== undefined) pdf.setSubject(metadata.subject);
  if (metadata?.keywords !== undefined) pdf.setKeywords([...metadata.keywords]);
}
