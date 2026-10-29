import type { RegisteredFont } from 'renderpdf-js';

// Generic families cannot identify one browser font program for PDF embedding.
const genericFamilies = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
]);

/** One CSS face requested by visible source text but unavailable as registered bytes. */
export interface MissingFontFace {
  /** The first family in the browser-computed CSS list. */
  family: string;
  /** Browser-computed numeric weight. */
  weight: number;
  /** Supported CSS style needed for the PDF face. */
  style: 'normal' | 'italic';
}

/** Exact font programs needed by one preview, plus limits for comparing both exports. */
export interface FontRequirements {
  /** Faces the user may register from local TTF files to preserve the authored font. */
  missing: readonly MissingFontFace[];
  /** Computed styles or family syntax that cannot map to one exact face. */
  unsupported: readonly string[];
  /** Registered faces whose family, weight and style are used by visible text. */
  usedFonts: readonly RegisteredFont[];
}

/** Locate the first requested family without treating later system fallbacks as exact bytes. */
function firstFamily(
  /** Browser-computed font-family declaration. */
  familyList: string,
): string {
  return (
    familyList
      .split(',')[0]
      ?.trim()
      .replace(/^["']|["']$/g, '') ?? ''
  );
}

/** Check whether an ancestor suppresses layout before asking for its descendant's font. */
function isHiddenByDisplay(
  /** Text-bearing element, inside the connected source root. */
  element: Element,
  /** Outermost preview element included in the PDF source. */
  source: HTMLElement,
  /** Reuse computed results across many text nodes in the same table row. */
  hiddenCache: Map<Element, boolean>,
): boolean {
  const cached = hiddenCache.get(element);
  if (cached !== undefined) return cached;
  // The source root is included; ancestors outside it do not belong to PDF content.
  const hidden =
    getComputedStyle(element).display === 'none' ||
    (element !== source && element.parentElement !== null
      ? isHiddenByDisplay(element.parentElement, source, hiddenCache)
      : false);
  hiddenCache.set(element, hidden);
  return hidden;
}

/** Inspect visible text against font programs owned by this browser document. */
export function inspectFontRequirements(
  /** Connected preview source whose computed styles drive both PDF exports. */
  source: HTMLElement,
  /** Exact faces returned by registerFont(), including local user uploads. */
  fonts: readonly RegisteredFont[],
): FontRequirements {
  // CSS shorthand is resolved by the browser; one style tuple needs only one diagnostic.
  const requested = new Map<string, MissingFontFace>();
  const unsupported = new Set<string>();
  const usedFaces = new Set<string>();
  const hiddenCache = new Map<Element, boolean>();
  const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    const element = node.parentElement;
    if (!element || isHiddenByDisplay(element, source, hiddenCache)) continue;
    const computed = getComputedStyle(element);
    if (computed.visibility !== 'visible') continue;
    const family = firstFamily(computed.fontFamily);
    const weight = Number(computed.fontWeight);
    const style = computed.fontStyle;
    if (!family || !Number.isFinite(weight)) {
      unsupported.add(`Cannot resolve the computed font ${computed.font} to one exact PDF face.`);
      continue;
    }
    if (genericFamilies.has(family.toLowerCase())) {
      unsupported.add(
        `Generic font family ${family} cannot identify exact PDF bytes. An explicit CSS family and matching TTF file are needed for exact font output.`,
      );
      continue;
    }
    if (weight < 100 || weight > 900 || weight % 100 !== 0) {
      unsupported.add(
        `Font weight ${weight} for ${family} is unsupported by jsPDF HTML export; use a 100–900 weight in steps of 100.`,
      );
      continue;
    }
    if (style !== 'normal' && style !== 'italic') {
      unsupported.add(`Font style ${style} for ${family} is unsupported; use normal or italic.`);
      continue;
    }
    const faceKey = `${family.toLowerCase()}:${weight}:${style}`;
    usedFaces.add(faceKey);
    // A nearby weight can change browser and jsPDF output independently, so require its own TTF.
    if (
      !fonts.some(
        (font) =>
          font.family.toLowerCase() === family.toLowerCase() &&
          font.weight === weight &&
          font.style === style,
      )
    ) {
      requested.set(faceKey, { family, weight, style });
    }
  }
  return {
    missing: [...requested.values()],
    unsupported: [...unsupported],
    usedFonts: fonts.filter((font) =>
      usedFaces.has(`${font.family.toLowerCase()}:${font.weight}:${font.style}`),
    ),
  };
}
