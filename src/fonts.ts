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

/** Variation axes that can change browser outlines without changing the supplied font bytes. */
interface FontVariation {
  /** Default wght coordinate, when the program exposes that axis. */
  weight?: number;
  /** Automatic optical sizing must be disabled for a stable default PDF instance. */
  opticalSize: boolean;
}

// Registrations belong to a document; importing this module never reads browser globals.
const registrations = new WeakMap<Document, Map<string, FontRegistration>>();

// Only successful registration handles prove ownership of the exact current-document browser face.
const fontOwnership = new WeakMap<
  RegisteredFont,
  { document: Document; face: FontFace; variation?: FontVariation }
>();

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

/** Decode caller-owned font data once, with strict base64 validation at the public boundary.
 * @param data Raw bytes, bare base64, or a font data URL.
 */
export function copyFontBytes(data: FontSource['data']): Uint8Array {
  if (typeof data === 'string') {
    // Font data URLs are useful for browser callers; other URL and MIME forms remain explicit errors.
    const match =
      /^data:(?:font\/(?:ttf|otf|sfnt|truetype|opentype)|application\/(?:font-sfnt|x-font-ttf|x-font-opentype|octet-stream));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(
        data,
      );
    // Bare base64 and approved font data URLs normalize to one encoded program.
    const encoded = data.startsWith('data:') ? match?.[1] : data;
    if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'Provide nonempty font bytes or valid base64 font data.',
      );
    }
    try {
      // Browser and modern Node expose atob; canonicalization rejects ambiguous encodings.
      const binary = atob(encoded);
      // Reject noncanonical padding bits instead of accepting two spellings for one program.
      if (btoa(binary).replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
        throw new Error('Noncanonical base64 font data');
      }
      // Keep a caller-independent byte copy for browser and PDF ownership.
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1)
        bytes[index] = binary.charCodeAt(index);
      return bytes;
    } catch {
      throw new RenderPDFError(
        'INVALID_OPTIONS',
        'Provide nonempty font bytes or valid base64 font data.',
      );
    }
  }
  // Intrinsic byte tags work across same-origin iframe realms; other views are rejected.
  if (Object.prototype.toString.call(data) === '[object Uint8Array]')
    return Uint8Array.from(data as Uint8Array);
  if (Object.prototype.toString.call(data) === '[object ArrayBuffer]')
    return new Uint8Array(data as ArrayBuffer).slice();
  throw new RenderPDFError(
    'INVALID_OPTIONS',
    'Provide nonempty font bytes or valid base64 font data.',
  );
}

/** Inspect a TTF/OTF program and permit only its default variable instance.
 * @param bytes Owned TTF/OTF program; the browser still validates its actual font tables.
 * @param weight Declared face weight, which must agree with the default variable axis.
 * @param style Declared face style; nondefault variable slant is not supported.
 */
export function inspectFontProgram(
  bytes: Uint8Array,
  weight = 400,
  style: 'normal' | 'italic' = 'normal',
): FontVariation | undefined {
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
      'Only TTF/OTF programs are supported; WOFF fonts and font collections are unsupported.',
    );
  }
  // Every directory entry occupies sixteen bytes after the twelve-byte SFNT header.
  const tableCount = directory.getUint16(4);
  if (tableCount === 0 || 12 + tableCount * 16 > bytes.byteLength) {
    throw new RenderPDFError('FONT_LOAD_FAILED', 'The TTF/OTF font table directory is incomplete.');
  }
  for (let index = 0; index < tableCount; index += 1) {
    if (directory.getUint32(12 + index * 16) !== 0x66766172) continue;
    // Table offsets and lengths come from untrusted SFNT bytes and must stay in bounds.
    const offset = directory.getUint32(12 + index * 16 + 8);
    const length = directory.getUint32(12 + index * 16 + 12);
    if (length < 16 || offset > bytes.byteLength - length) {
      throw new RenderPDFError('FONT_LOAD_FAILED', 'The variable font axis table is incomplete.');
    }
    // Each axis has a fixed minimum record size even when a font adds trailing fields.
    const axisOffset = directory.getUint16(offset + 4);
    const axisCount = directory.getUint16(offset + 8);
    const axisSize = directory.getUint16(offset + 10);
    if (axisCount === 0 || axisSize < 20 || axisOffset + axisCount * axisSize > length) {
      throw new RenderPDFError(
        'FONT_LOAD_FAILED',
        'The variable font axis records are incomplete.',
      );
    }
    // Only default coordinates can agree with pdf-lib's raw-byte embedding path.
    const variation: FontVariation = { opticalSize: false };
    for (let axis = 0; axis < axisCount; axis += 1) {
      // Fixed 16.16 coordinates retain the font's authored precision.
      const record = offset + axisOffset + axis * axisSize;
      const tag = directory.getUint32(record);
      const minimum = directory.getInt32(record + 4) / 65536;
      const defaultValue = directory.getInt32(record + 8) / 65536;
      const maximum = directory.getInt32(record + 12) / 65536;
      if (!(minimum <= defaultValue && defaultValue <= maximum)) {
        throw new RenderPDFError('FONT_LOAD_FAILED', 'The variable font axis range is invalid.');
      }
      if (tag === 0x77676874) variation.weight = defaultValue;
      if (tag === 0x6f70737a) variation.opticalSize = true;
      if ((tag === 0x6974616c || tag === 0x736c6e74) && defaultValue !== 0) {
        throw new RenderPDFError(
          'FONT_LOAD_FAILED',
          'Only the upright default variable instance is supported.',
        );
      }
    }
    if (style !== 'normal' || weight !== (variation.weight ?? 400)) {
      throw new RenderPDFError(
        'FONT_LOAD_FAILED',
        'The declared face must use the upright default weight of a variable font.',
      );
    }
    return variation;
  }
  return undefined;
}

/** Match the face Chromium selects from one owned family, including CSS nearby-weight rules.
 * @param style Browser-computed text style, not the authored CSS token.
 * @param fonts Exact programs registered for the source document.
 */
export function resolveRegisteredFont(
  style: CSSStyleDeclaration,
  fonts: readonly RegisteredFont[],
): RegisteredFont {
  // A computed family list cannot reveal a system-font match later in that list.
  const family = style.fontFamily
    .split(',')[0]
    ?.trim()
    .replace(/^["']|["']$/g, '');
  // Computed weights are numeric even when authors use bold or bolder.
  const weight = Number(style.fontWeight);
  const styleName = style.fontStyle;
  // Exact style avoids browser-synthesized italic or oblique faces.
  const candidates = fonts.filter(
    (font) => font.family.toLowerCase() === family?.toLowerCase() && font.style === styleName,
  );
  if (!Number.isFinite(weight) || candidates.length === 0) {
    throw new RenderPDFError(
      'MISSING_FONT',
      `No exact registered font face for ${style.fontFamily} ${style.fontWeight} ${styleName}.`,
    );
  }
  // Search direction follows CSS Fonts: low weights prefer lighter, high weights heavier.
  /** Rank a candidate by the standard's ordered search groups and distance within each group.
   * @param candidate Owned face available to the browser and PDF writer.
   */
  function rank(candidate: RegisteredFont): readonly [number, number] {
    if (weight < 400)
      return candidate.weight <= weight
        ? [0, weight - candidate.weight]
        : [1, candidate.weight - weight];
    if (weight <= 500) {
      if (candidate.weight >= weight && candidate.weight <= 500)
        return [0, candidate.weight - weight];
      if (candidate.weight < weight) return [1, weight - candidate.weight];
      return [2, candidate.weight - weight];
    }
    return candidate.weight >= weight
      ? [0, candidate.weight - weight]
      : [1, weight - candidate.weight];
  }
  // A sorted copy keeps the caller's font ordering intact.
  const ordered = [...candidates].sort((a, b) => {
    const first = rank(a);
    const second = rank(b);
    return first[0] - second[0] || first[1] - second[1];
  });
  // The family/style guard above ensures at least one candidate.
  const selected = ordered[0]!;
  const maximum = Math.max(...candidates.map((font) => font.weight));
  // A missing bold-side face may be synthesized; browsers do not synthesize lighter outlines.
  if (selected.weight !== weight && weight > 500 && weight > maximum) {
    throw new RenderPDFError(
      'MISSING_FONT',
      `The requested weight ${weight} may use browser font synthesis.`,
    );
  }
  const variation = fontOwnership.get(selected)?.variation;
  if (
    variation &&
    (selected.weight !== weight ||
      style.fontVariationSettings !== 'normal' ||
      (style.fontStretch !== 'normal' && style.fontStretch !== '100%') ||
      (variation.opticalSize && style.getPropertyValue('font-optical-sizing') !== 'none'))
  ) {
    throw new RenderPDFError(
      'UNSUPPORTED_CSS',
      'Variable fonts require default weight, width and variation axes; disable automatic optical sizing when present.',
    );
  }
  return selected;
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
export function validateRegisteredFonts(
  fonts: readonly RegisteredFont[],
  fontDocument: Document | undefined = typeof document === 'undefined' ? undefined : document,
): void {
  for (const font of fonts) {
    // Structural lookalikes cannot prove that supplied bytes match any browser-selected font.
    const ownership = font && typeof font === 'object' ? fontOwnership.get(font) : undefined;
    if (
      !ownership ||
      !fontDocument ||
      ownership.document !== fontDocument ||
      !fontDocument.fonts.has(ownership.face)
    ) {
      throw new RenderPDFError(
        'MISSING_FONT',
        'Provide font handles returned by registerFont() whose browser faces remain registered in the current document.',
      );
    }
    assertNoConflictingFace(fontDocument, font.family, font.weight, font.style, ownership.face);
  }
}

/** Register explicit TTF/OTF bytes in the selected browser document.
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
    source.data === undefined
  ) {
    throw new RenderPDFError(
      'INVALID_OPTIONS',
      'Provide a plain custom CSS family (letters, digits, spaces, hyphens, or underscores), font bytes or base64, integer weight from 1 to 1000, and normal or italic style.',
    );
  }
  const candidateDocument =
    source.document ?? (typeof document === 'undefined' ? undefined : document);
  // The iframe realm's constructor places this face in its own font set.
  const FontFaceConstructor =
    candidateDocument?.defaultView?.FontFace ??
    (typeof FontFace === 'undefined' ? undefined : FontFace);
  if (!candidateDocument?.fonts || !FontFaceConstructor) {
    throw new RenderPDFError(
      'FONT_LOAD_FAILED',
      'Font registration requires a browser document with FontFace support.',
    );
  }
  // Narrow browser contracts before asynchronous loading begins.
  const fontDocument: Document = candidateDocument;
  const BrowserFontFace: typeof FontFace = FontFaceConstructor;
  // Copy before the first asynchronous boundary so caller mutations cannot change either renderer.
  const bytes = copyFontBytes(source.data);
  if (bytes.byteLength === 0)
    throw new RenderPDFError('INVALID_OPTIONS', 'Font bytes must not be empty.');
  // Later CSS checks reject any per-element override of these default axes.
  const variation = inspectFontProgram(bytes, weight, style);
  // Case-insensitive descriptors match CSS family identity while preserving the original label.
  const key = `${family.toLowerCase()}:${weight}:${style}`;
  // Each browser document owns one independently unloadable FontFaceSet.
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
      const browserBytes = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(browserBytes).set(bytes);
      const face = new BrowserFontFace(family, browserBytes, { weight: String(weight), style });
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
      fontOwnership.set(registered, {
        document: fontDocument,
        face,
        ...(variation ? { variation } : {}),
      });
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
