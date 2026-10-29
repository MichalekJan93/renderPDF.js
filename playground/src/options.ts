import type {
  CustomPageSize,
  PageMargins,
  PageTextOptions,
  PageTextSlotsOptions,
  PDFMetadata,
  RenderPDFOptions,
} from 'renderpdf-js';

// JSON null represents an omitted API value; browser-owned handles cannot be pasted as JSON.
const defaultOptions = {
  format: 'A4',
  orientation: 'portrait',
  margin: 24,
  fit: 'none',
  fonts: null,
  fontMismatch: null,
  fontFallback: null,
  rasterScale: 2,
  fallback: 'auto',
  strictCss: false,
  verifySource: 'full',
  pageBreak: 'css',
  repeatTableHeaders: false,
  header: null,
  footer: null,
  metadata: { title: 'RenderPDF.js', author: null, subject: null, keywords: null },
  signal: null,
  onWarning: null,
  onProgress: null,
};

/** Fully expanded public defaults for the JSON editor, including omitted runtime values. */
export const DEFAULT_OPTIONS_TEXT = JSON.stringify(defaultOptions, null, 2);

/** Require a plain JSON object at an option boundary. */
function objectValue(
  /** Parsed JSON value under inspection. */
  value: unknown,
  /** Human-readable option path for errors. */
  name: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/** Reject misspelled and non-JSON API fields instead of silently ignoring them. */
function onlyKeys(
  /** Parsed JSON object to inspect. */
  value: Record<string, unknown>,
  /** Accepted field names for this object. */
  allowed: readonly string[],
  /** Human-readable option path for errors. */
  name: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${name}.${key} is not a supported option.`);
  }
}

/** Treat JSON null like an omitted optional API property. */
function supplied(
  /** Parsed parent object. */
  value: Record<string, unknown>,
  /** Property whose null marker should be removed. */
  key: string,
): unknown {
  return value[key] === null ? undefined : value[key];
}

/** Validate one documented string choice without coercing a typo. */
function choice<T extends string>(
  /** Parsed option value. */
  value: unknown,
  /** Documented accepted values. */
  allowed: readonly T[],
  /** Human-readable option path for errors. */
  name: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

/** Validate a finite CSS-pixel value at the JSON boundary. */
function finiteNumber(
  /** Parsed option value. */
  value: unknown,
  /** Human-readable option path for errors. */
  name: string,
  /** Whether zero is a valid length. */
  allowZero = false,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (allowZero ? value < 0 : value <= 0)
  ) {
    throw new Error(`${name} must be a finite ${allowZero ? 'nonnegative' : 'positive'} number.`);
  }
  return value;
}

/** Validate a Unicode text field without string coercion. */
function stringValue(
  /** Parsed option value. */
  value: unknown,
  /** Human-readable option path for errors. */
  name: string,
): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  return value;
}

/** Validate one optional repeated text band; connected HTML bands need DOM elements. */
function textBand(
  /** JSON value for a header or footer. */
  value: unknown,
  /** Human-readable option path for errors. */
  name: string,
): PageTextOptions | PageTextSlotsOptions {
  // The form is selected by text versus independent left/center/right fields.
  const band = objectValue(value, name);
  onlyKeys(band, ['text', 'height', 'font', 'fontSize', 'align', 'left', 'center', 'right'], name);
  if (supplied(band, 'font') !== undefined) {
    throw new Error(`${name}.font is managed by the font upload control.`);
  }
  // Every repeated band reserves a positive amount of page height in CSS pixels.
  const height = finiteNumber(band.height, `${name}.height`);
  if (supplied(band, 'text') !== undefined) {
    if (['left', 'center', 'right'].some((key) => supplied(band, key) !== undefined)) {
      throw new Error(`${name} cannot mix text with left, center, or right.`);
    }
    // Keep optional styling absent unless the user explicitly supplied it.
    const result: PageTextOptions = { text: stringValue(band.text, `${name}.text`), height };
    if (supplied(band, 'fontSize') !== undefined) {
      result.fontSize = finiteNumber(band.fontSize, `${name}.fontSize`);
    }
    if (supplied(band, 'align') !== undefined) {
      result.align = choice(band.align, ['left', 'center', 'right'], `${name}.align`);
    }
    return result;
  }
  if (supplied(band, 'align') !== undefined) {
    throw new Error(`${name}.align is only valid with text.`);
  }
  // Text slots share the same reserved height and optional font size.
  const result: PageTextSlotsOptions = { height };
  for (const key of ['left', 'center', 'right'] as const) {
    if (supplied(band, key) !== undefined) result[key] = stringValue(band[key], `${name}.${key}`);
  }
  if (result.left === undefined && result.center === undefined && result.right === undefined) {
    throw new Error(`${name} needs text or at least one text slot.`);
  }
  if (supplied(band, 'fontSize') !== undefined) {
    result.fontSize = finiteNumber(band.fontSize, `${name}.fontSize`);
  }
  return result;
}

/** Convert a complete or partial JSON object into safe, actual RenderPDF.js options. */
export function parseOptions(
  /** Editable JSON document shown below the HTML input. */
  text: string,
): RenderPDFOptions {
  // JSON.parse rejects executable object syntax and keeps the app's strict CSP intact.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `Options must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Only known public keys may reach the library; browser-owned values stay outside JSON.
  const value = objectValue(parsed, 'Options');
  onlyKeys(value, Object.keys(defaultOptions), 'Options');
  for (const key of ['fonts', 'signal', 'onWarning', 'onProgress']) {
    if (supplied(value, key) !== undefined) {
      throw new Error(`${key} is managed by the playground and must be null or omitted.`);
    }
  }
  // Build only supplied values so JSON null preserves the library's own conditional defaults.
  const options: RenderPDFOptions = {};
  // Paper dimensions and margins remain CSS pixels until the library's PDF boundary.
  const format = supplied(value, 'format');
  if (format !== undefined) {
    if (typeof format === 'string') {
      options.format = choice(format, ['A4', 'A3', 'Letter'] as const, 'format');
    } else {
      const size = objectValue(format, 'format');
      onlyKeys(size, ['width', 'height'], 'format');
      const customSize: CustomPageSize = {
        width: finiteNumber(size.width, 'format.width'),
        height: finiteNumber(size.height, 'format.height'),
      };
      options.format = customSize;
    }
  }
  if (supplied(value, 'orientation') !== undefined) {
    options.orientation = choice(
      value.orientation,
      ['portrait', 'landscape', 'auto'],
      'orientation',
    );
  }
  const margin = supplied(value, 'margin');
  if (margin !== undefined) {
    if (typeof margin === 'number') {
      options.margin = finiteNumber(margin, 'margin', true);
    } else {
      // Separate edges use the same CSS-pixel unit as one numeric margin.
      const edges = objectValue(margin, 'margin');
      onlyKeys(edges, ['top', 'right', 'bottom', 'left'], 'margin');
      const margins: PageMargins = {
        top: finiteNumber(edges.top, 'margin.top', true),
        right: finiteNumber(edges.right, 'margin.right', true),
        bottom: finiteNumber(edges.bottom, 'margin.bottom', true),
        left: finiteNumber(edges.left, 'margin.left', true),
      };
      options.margin = margins;
    }
  }
  if (supplied(value, 'fit') !== undefined)
    options.fit = choice(value.fit, ['none', 'width'], 'fit');
  if (supplied(value, 'fontMismatch') !== undefined) {
    options.fontMismatch = choice(value.fontMismatch, ['error', 'fallback'], 'fontMismatch');
  }
  if (supplied(value, 'fontFallback') !== undefined) {
    // Family names remain exact CSS descriptors except for surrounding input whitespace.
    const family = stringValue(value.fontFallback, 'fontFallback').trim();
    if (!family) throw new Error('fontFallback must name a registered font family.');
    options.fontFallback = family;
  }
  if (supplied(value, 'rasterScale') !== undefined) {
    options.rasterScale = finiteNumber(value.rasterScale, 'rasterScale');
  }
  if (supplied(value, 'fallback') !== undefined) {
    options.fallback = choice(value.fallback, ['auto', 'strict'], 'fallback');
  }
  for (const key of ['strictCss', 'repeatTableHeaders'] as const) {
    if (supplied(value, key) !== undefined) {
      if (typeof value[key] !== 'boolean') throw new Error(`${key} must be true or false.`);
      options[key] = value[key];
    }
  }
  if (supplied(value, 'verifySource') !== undefined) {
    options.verifySource = choice(value.verifySource, ['full', 'mutations'], 'verifySource');
  }
  if (supplied(value, 'pageBreak') !== undefined) {
    options.pageBreak = choice(value.pageBreak, ['css', 'auto'], 'pageBreak');
  }
  for (const key of ['header', 'footer'] as const) {
    if (supplied(value, key) !== undefined) options[key] = textBand(value[key], key);
  }
  if (supplied(value, 'metadata') !== undefined) {
    // Omitted document properties retain the PDF writer's default title and empty fields.
    const metadata = objectValue(value.metadata, 'metadata');
    onlyKeys(metadata, ['title', 'author', 'subject', 'keywords'], 'metadata');
    const properties: PDFMetadata = {};
    for (const key of ['title', 'author', 'subject'] as const) {
      if (supplied(metadata, key) !== undefined) {
        properties[key] = stringValue(metadata[key], `metadata.${key}`);
      }
    }
    if (supplied(metadata, 'keywords') !== undefined) {
      if (!Array.isArray(metadata.keywords)) throw new Error('metadata.keywords must be an array.');
      properties.keywords = metadata.keywords.map((keyword: unknown, index: number) =>
        stringValue(keyword, `metadata.keywords[${index}]`),
      );
    }
    options.metadata = properties;
  }
  return options;
}
