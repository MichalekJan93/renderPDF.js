import type {
  PageGeometry,
  PageTextOptions,
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
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value.text) ||
    /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(value.text)
  ) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'Page header/footer requires single-line Latin text and a finite positive reserved height.',
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

/** Reserve page text outside the source area without changing the caller's DOM layout. */
export function resolvePageBands(
  /** Original physical page and outer margins. */
  page: PageGeometry,
  /** Validated options whose font handles remain immutable. */
  options: RenderPDFOptions,
) {
  const header = resolveText(options.header, options.fonts);
  const footer = resolveText(options.footer, options.fonts);
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
