import type {
  PageBandOptions,
  PageGeometry,
  PageHTMLBandOptions,
  PageTextOptions,
  PageTextSlotsOptions,
  RegisteredFont,
  RenderPDFOptions,
} from './api-types.js';
import { RenderPDFError } from './diagnostics.js';

/** Copied, validated inputs for one repeated text band. */
export interface PageText {
  /** Caller text with supported page placeholders preserved until pagination finishes. */
  readonly text: string;
  /** Reserved height in CSS pixels. */
  readonly height: number;
  /** Exact face also supplied to the source renderer. */
  readonly font: RegisteredFont;
  /** Font size in CSS pixels. */
  readonly fontSize: number;
  /** Horizontal placement inside the original page margins. */
  readonly align: 'left' | 'center' | 'right';
}

/** Validated independent text lines sharing one reserved page area. */
export interface PageTextSlots {
  /** Discriminant for page writer composition. */
  readonly kind: 'slots';
  /** Reserved height in CSS pixels. */
  readonly height: number;
  /** Nonempty selectable lines in left, center, right order. */
  readonly lines: readonly PageText[];
}

/** Connected browser content to render once and repeat without touching caller DOM. */
export interface PageHTML {
  /** Discriminant for one embedded PDF page in the writer. */
  readonly kind: 'html';
  /** Reserved height in CSS pixels. */
  readonly height: number;
  /** HTML content measured by its own owner document. */
  readonly element: HTMLElement;
}

/** A repeated band resolved before asynchronous source preparation. */
export type PageBand = PageText | PageTextSlots | PageHTML;

/** HTML content after its independent single-page render completed. */
export interface PreparedPageHTML {
  /** Discriminant for the writer's reusable PDF form. */
  readonly kind: 'html';
  /** Reserved height in CSS pixels. */
  readonly height: number;
  /** Complete single-page PDF of browser-measured band content. */
  readonly bytes: Uint8Array;
}

/** A band ready for the PDF writer, including prepared HTML bytes if requested. */
export type PreparedPageBand = PageText | PageTextSlots | PreparedPageHTML;

/** Resolve one band before asynchronous preparation can observe mutated caller options. */
function resolveText(
  /** Optional caller-owned settings; undefined means no reserved area. */
  value: PageTextOptions | undefined,
  /** Explicit faces whose first handle provides the default band face. */
  fonts: readonly RegisteredFont[],
): PageText | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.text !== 'string' ||
    !Number.isFinite(value.height) ||
    value.height <= 0 ||
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value.text)
  ) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'Page header/footer requires single-line text and a finite positive reserved height.',
    );
  }
  // Defaults are copied now, so caller changes during font/image readiness cannot affect the PDF.
  const font = value.font ?? fonts[0]!;
  const fontSize = value.fontSize ?? 12;
  const align = value.align ?? 'left';
  if (
    !fonts.includes(font) ||
    !Number.isFinite(fontSize) ||
    fontSize <= 0 ||
    !['left', 'center', 'right'].includes(align)
  ) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'Page header/footer needs a font included in fonts, a positive fontSize and left/center/right alignment.',
    );
  }
  return Object.freeze({ text: value.text, height: value.height, font, fontSize, align });
}

/** Validate a legacy line, text slots, or connected HTML band without changing its source. */
function resolveBand(
  /** Optional caller-owned band settings. */
  value: PageBandOptions | undefined,
  /** Explicit browser/PDF font faces for text slots. */
  fonts: readonly RegisteredFont[],
): PageBand | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || !Number.isFinite(value.height) || value.height <= 0) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'Page header/footer requires a positive reserved height.',
    );
  }
  if ('text' in value) return resolveText(value as PageTextOptions, fonts);
  if ('element' in value) {
    const element = (value as PageHTMLBandOptions).element;
    if (
      !element ||
      element.nodeType !== 1 ||
      !element.isConnected ||
      typeof element.getBoundingClientRect !== 'function'
    ) {
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'HTML page header/footer requires a connected HTMLElement.',
      );
    }
    return Object.freeze({ kind: 'html', height: value.height, element });
  }
  const slots = value as PageTextSlotsOptions;
  const lines = (['left', 'center', 'right'] as const).flatMap((align) => {
    const text = slots[align];
    if (text === undefined) return [];
    return [
      resolveText(
        {
          text,
          height: slots.height,
          align,
          ...(slots.font ? { font: slots.font } : {}),
          ...(slots.fontSize !== undefined ? { fontSize: slots.fontSize } : {}),
        },
        fonts,
      )!,
    ];
  });
  if (lines.length === 0) {
    throw new RenderPDFError('INVALID_OPTIONS', 'Page header/footer needs at least one text slot.');
  }
  return Object.freeze({ kind: 'slots', height: slots.height, lines: Object.freeze(lines) });
}

/** Reserve page text outside the source area without changing the caller's DOM layout. */
export function resolvePageBands(
  /** Original physical page and outer margins. */
  page: PageGeometry,
  /** Validated options whose font handles remain immutable. */
  options: RenderPDFOptions,
) {
  const header = resolveBand(options.header, options.fonts ?? []);
  const footer = resolveBand(options.footer, options.fonts ?? []);
  // Only content margins grow; the writer still knows the original band positions.
  const content: PageGeometry = {
    ...page,
    margin: {
      ...page.margin,
      top: page.margin.top + (header?.height ?? 0),
      bottom: page.margin.bottom + (footer?.height ?? 0),
    },
  };
  if (content.margin.top + content.margin.bottom >= content.height) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'Page header/footer heights and margins leave no positive source content area.',
    );
  }
  return { content, header, footer };
}
