import type { RenderPDFResult } from './api-types.js';
import type { RenderWarning } from './diagnostics.js';
import { RenderPDFError } from './diagnostics.js';

/** Retain immutable PDF output and expose browser-native forms without re-rendering the source. */
export function createResult(
  /** Complete successfully written PDF bytes; never expose this owned buffer directly. */
  bytes: Uint8Array,
  /** Physical PDF page count from the shared page mapping. */
  pageCount: number,
  /** Export diagnostics, copied and frozen to preserve the original outcome. */
  warnings: readonly RenderWarning[],
): RenderPDFResult {
  // A private copy prevents later adapter or caller mutations from corrupting output methods.
  const owned = Uint8Array.from(bytes);
  // Freeze each record as well as the collection; warning observers receive these same records.
  const diagnostics = Object.freeze(warnings.map((warning) => Object.freeze({ ...warning })));
  return Object.freeze({
    pageCount,
    warnings: diagnostics,
    /** Return a new allocation on every call. */
    async toUint8Array() {
      return Uint8Array.from(owned);
    },
    /** Browser Blobs own their payload and preserve the correct PDF MIME type. */
    async toBlob() {
      return new Blob([owned], { type: 'application/pdf' });
    },
    /** Trigger a local browser download and release the temporary URL after consumption. */
    async download(filename = 'document.pdf') {
      if (
        typeof filename !== 'string' ||
        !filename.trim() ||
        /[/\\]/.test(filename) ||
        // oxlint-disable-next-line typescript/no-misused-spread -- Inspect code points for ASCII controls without changing the filename.
        [...filename].some((character) => character.codePointAt(0)! < 32)
      ) {
        throw new RenderPDFError(
          'INVALID_OPTIONS',
          'Provide a nonempty PDF filename without path separators or control characters.',
        );
      }
      // Result creation does not depend on DOM state; only the requested browser action does.
      const url = URL.createObjectURL(new Blob([owned], { type: 'application/pdf' }));
      try {
        // The temporary anchor never enters the caller's source subtree.
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      }
    },
  });
}
