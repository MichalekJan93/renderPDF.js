/** Machine-readable failure reasons for the supported browser rendering pipeline. */
export type RenderErrorCode =
  | 'INVALID_OPTIONS'
  | 'INVALID_SOURCE'
  | 'FONT_LOAD_FAILED'
  | 'MISSING_FONT'
  | 'MISSING_GLYPH'
  | 'UNSUPPORTED_CSS'
  | 'UNSUPPORTED_ELEMENT'
  | 'UNSUPPORTED_IMAGE'
  | 'RESOURCE_LOAD_FAILED'
  | 'SOURCE_CHANGED'
  | 'SOURCE_OVERFLOW'
  | 'PAGINATION_FAILED'
  | 'RASTER_FAILED'
  | 'PDF_WRITE_FAILED';

/** A rendering failure with a stable code and an actionable English explanation. */
export class RenderPDFError extends Error {
  /** Construct an error without hiding its original lower-level cause. */
  constructor(
    /** Stable category that callers can branch on without parsing message text. */
    public readonly code: RenderErrorCode,
    /** Human-readable explanation of the failed requirement. */
    message: string,
    /** Optional original browser or adapter failure. */
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RenderPDFError';
  }
}

/** Supported approximations and explicit local raster choices, reported without console noise. */
export interface RenderWarning {
  /** Stable warning category for application diagnostics. */
  readonly code:
    | 'TEXT_METRICS_APPROXIMATED'
    | 'RASTER_FALLBACK'
    | 'RASTER_TEXT_OMITTED'
    | 'BREAK_AVOID_RELAXED'
    | 'SOURCE_VERIFICATION_REDUCED'
    | 'FONT_SUBSTITUTED';
  /** Explanation of the behavior and its relevant fidelity limit. */
  readonly message: string;
}

/** Stop at asynchronous stage boundaries using the browser's standard AbortError contract. */
export function throwIfAborted(
  /** Optional caller cancellation signal. */
  signal?: AbortSignal,
): void {
  if (signal?.aborted) throw new DOMException('PDF rendering was cancelled.', 'AbortError');
}
