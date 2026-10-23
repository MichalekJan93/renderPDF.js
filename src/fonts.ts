import type { FontSource, RegisteredFont } from './api-types.js';
import { RenderPDFError } from './diagnostics.js';

/** Pending or completed registration retains owned bytes for deterministic duplicate checks. */
interface FontRegistration {
  /** Original program copy, never exposed to callers. */
  bytes: Uint8Array;
  /** Shared completion avoids registering identical concurrent requests twice. */
  promise: Promise<RegisteredFont>;
  /** Exact owned browser face, retained to distinguish later external descriptor collisions. */
  face?: FontFace;
}

// Registrations belong to a document; importing this module never reads browser globals.
const registrations = new WeakMap<Document, Map<string, FontRegistration>>();

// Only successful registration handles prove ownership of the exact current-document browser face.
const fontOwnership = new WeakMap<RegisteredFont, { document: Document; face: FontFace }>();

// Generic names and CSS-wide keywords cannot identify one exact custom font program.
const reservedFamilies = new Set([
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
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
]);

/** Admit only static SFNT programs whose exact browser and PDF instances can agree.
 * @param bytes Owned TTF/OTF program; the browser still validates its actual font tables.
 */
function assertStaticSfnt(bytes: Uint8Array): void {
  if (bytes.byteLength < 12) {
    throw new RenderPDFError('FONT_LOAD_FAILED', 'Provide a complete static TTF/OTF font program.');
  }
  // Both supported containers use the same big-endian SFNT directory layout.
  const directory = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // TrueType outlines use 0x00010000; OpenType CFF outlines use the ASCII OTTO signature.
  const signature = directory.getUint32(0);
  if (signature !== 0x00010000 && signature !== 0x4f54544f) {
    throw new RenderPDFError(
      'FONT_LOAD_FAILED',
      'Only static TTF/OTF programs are supported; WOFF fonts and font collections are unsupported.',
    );
  }
  // Every directory entry occupies sixteen bytes after the twelve-byte SFNT header.
  const tableCount = directory.getUint16(4);
  if (tableCount === 0 || 12 + tableCount * 16 > bytes.byteLength) {
    throw new RenderPDFError('FONT_LOAD_FAILED', 'The TTF/OTF font table directory is incomplete.');
  }
  for (let index = 0; index < tableCount; index += 1) {
    // Reject variable fonts rather than embedding a PDF default instance unlike browser axes.
    if (directory.getUint32(12 + index * 16) === 0x66766172) {
      throw new RenderPDFError(
        'FONT_LOAD_FAILED',
        'Variable fonts are unsupported. Provide an explicitly generated static TTF/OTF instance.',
      );
    }
  }
}

/** Reject browser faces that could select another program for the same explicit descriptor.
 * @param fontDocument Browser document whose existing CSS and script faces participate in layout.
 * @param family Case-insensitive custom family being registered.
 * @param weight Static numeric weight selected by both rendering paths.
 * @param style Exact supported face style.
 * @param ownedFace Previously loaded face whose program is already owned by the cache.
 */
function assertNoConflictingFace(
  fontDocument: Document,
  family: string,
  weight: number,
  style: 'normal' | 'italic',
  ownedFace?: FontFace,
): void {
  // CSS-defined faces cannot expose their original bytes for equality verification.
  for (const face of fontDocument.fonts) {
    if (
      face === ownedFace ||
      face.family.replace(/^["']|["']$/g, '').toLowerCase() !== family.toLowerCase() ||
      face.style !== style
    )
      continue;
    // Variable weight ranges overlap every static face they cover, even before loading.
    const weights =
      face.weight === 'normal'
        ? [400]
        : face.weight === 'bold'
          ? [700]
          : face.weight.split(/\s+/).map(Number);
    if (
      weights[0] === weight ||
      (weights.length === 2 && weight >= weights[0]! && weight <= weights[1]!)
    ) {
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        `Font ${family} ${weight} ${style} conflicts with an existing browser font face. Choose a family owned by this registration.`,
      );
    }
  }
}

/** Validate immutable registration handles against the current browser's live font set.
 * @param fonts Explicit handles whose owned programs must still control browser font selection.
 */
export function validateRegisteredFonts(fonts: readonly RegisteredFont[]): void {
  for (const font of fonts) {
    // Structural lookalikes cannot prove that supplied bytes match any browser-selected font.
    const ownership = font && typeof font === 'object' ? fontOwnership.get(font) : undefined;
    if (
      !ownership ||
      typeof document === 'undefined' ||
      ownership.document !== document ||
      !document.fonts.has(ownership.face)
    ) {
      throw new RenderPDFError(
        'MISSING_FONT',
        'Provide font handles returned by registerFont() whose browser faces remain registered in the current document.',
      );
    }
    assertNoConflictingFace(document, font.family, font.weight, font.style, ownership.face);
  }
}

/** Register explicit static TTF/OTF bytes in the current browser document.
 * @param source Caller-supplied program and its exact CSS family, weight, and style.
 */
export async function registerFont(source: FontSource): Promise<RegisteredFont> {
  if (!source || typeof source !== 'object' || typeof source.family !== 'string') {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'Font registration requires a CSS family and font bytes.',
    );
  }
  // One unquoted custom family keeps CSS matching and embedded raster rules unambiguous.
  const family = source.family.trim();
  // Defaults describe one static face; ranges and browser-synthesized styles are not accepted.
  const weight = source.weight ?? 400;
  // Oblique ranges require a shaping contract that the renderer does not expose.
  const style = source.style ?? 'normal';
  if (
    !family ||
    !/^[\w -]+$/.test(family) ||
    reservedFamilies.has(family.toLowerCase()) ||
    !Number.isInteger(weight) ||
    weight < 1 ||
    weight > 1000 ||
    (style !== 'normal' && style !== 'italic') ||
    (!(source.data instanceof Uint8Array) && !(source.data instanceof ArrayBuffer)) ||
    source.data.byteLength === 0
  ) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'Provide a plain custom CSS family (letters, digits, spaces, hyphens, or underscores), nonempty TTF/OTF bytes, integer weight from 1 to 1000, and normal or italic style.',
    );
  }
  if (typeof document === 'undefined' || typeof FontFace === 'undefined' || !document.fonts) {
    throw new RenderPDFError(
      'FONT_LOAD_FAILED',
      'Font registration requires a browser document with FontFace support.',
    );
  }
  // Copy before the first asynchronous boundary so caller mutations cannot change either renderer.
  const bytes = new Uint8Array(
    source.data instanceof Uint8Array ? source.data : new Uint8Array(source.data),
  );
  assertStaticSfnt(bytes);
  // Case-insensitive descriptors match CSS family identity while preserving the original label.
  const key = `${family.toLowerCase()}:${weight}:${style}`;
  // Each browser document owns one independently unloadable FontFaceSet.
  const fontDocument = document;
  // Lazily create the cache only after the browser boundary is validated.
  let cache = registrations.get(fontDocument);
  if (!cache) {
    cache = new Map();
    registrations.set(fontDocument, cache);
  }
  // Conflicting programs under one CSS descriptor would diverge browser layout from PDF text.
  const existing = cache.get(key);
  assertNoConflictingFace(fontDocument, family, weight, style, existing?.face);
  if (existing) {
    if (
      existing.bytes.length !== bytes.length ||
      existing.bytes.some((value, index) => value !== bytes[index])
    ) {
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        `Font ${family} ${weight} ${style} is already registered with different bytes.`,
      );
    }
    return existing.promise;
  }

  /** Load before publishing the immutable descriptor shared by layout and PDF embedding. */
  async function load(): Promise<RegisteredFont> {
    try {
      // FontFace expects the family value itself; literal quotes would change CSS family identity.
      const face = new FontFace(family, bytes, { weight: String(weight), style });
      await face.load();
      // Stylesheets or other scripts may introduce a conflicting face while decoding is pending.
      assertNoConflictingFace(fontDocument, family, weight, style);
      fontDocument.fonts.add(face);
      registration.face = face;
      // Associate this immutable handle with the browser face before exposing it to application code.
      const registered = Object.freeze({
        family,
        weight,
        style,
        /** Expose a fresh copy so even mutations of returned program bytes stay local. */
        get bytes(): Uint8Array {
          return bytes.slice();
        },
      });
      fontOwnership.set(registered, { document: fontDocument, face });
      return registered;
    } catch (cause) {
      // A rejected program may be retried after the application supplies corrected bytes.
      cache!.delete(key);
      if (cause instanceof RenderPDFError) throw cause;
      throw new RenderPDFError(
        'FONT_LOAD_FAILED',
        `Could not load font ${family} ${weight} ${style}.`,
        { cause },
      );
    }
  }
  // Defer starting the loader until the cache entry exists, including synchronous constructor errors.
  const promise = Promise.resolve().then(load);
  // Ownership remains associated with this descriptor throughout its shared asynchronous load.
  const registration: FontRegistration = { bytes, promise };
  cache.set(key, registration);
  return promise;
}
