import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { RegisteredFont } from '../src/api-types';
import { registerFont, validateRegisteredFonts } from '../src/fonts';

/** Only descriptors participate in registration collision checks. */
type BrowserFontDescriptor = Pick<FontFace, 'family' | 'weight' | 'style'>;

/** Build a bounded synthetic SFNT directory; the mock browser owns actual table decoding.
 * @param tables Four-character table tags inspected by the static-font boundary.
 * @param signature TrueType or OpenType container signature.
 */
function sfntProgram(tables = ['head'], signature = 0x00010000): Uint8Array {
  // Table payloads are omitted because these unit tests simulate the browser decoder separately.
  const bytes = new Uint8Array(12 + 16 * tables.length);
  // SFNT metadata is big-endian, independently of the host platform.
  const directory = new DataView(bytes.buffer);
  directory.setUint32(0, signature);
  directory.setUint16(4, tables.length);
  for (const [index, tag] of tables.entries()) {
    bytes.set(new TextEncoder().encode(tag), 12 + index * 16);
  }
  return bytes;
}

/** Install a fresh document-scoped font loader without requiring a DOM test environment. */
function installFontBrowser(): {
  load: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  faces: Set<BrowserFontDescriptor>;
} {
  // Script and stylesheet faces share this iterable document font set.
  const faces = new Set<BrowserFontDescriptor>();
  // Independent documents prevent one test's registration cache from leaking into another.
  const add = vi.fn((face: BrowserFontDescriptor) => faces.add(face));
  // The controllable loader exercises browser decode errors and retries at the public boundary.
  const load = vi.fn(async () => undefined);
  vi.stubGlobal('document', {
    fonts: {
      add,
      has: (face: BrowserFontDescriptor) => faces.has(face),
      [Symbol.iterator]: () => faces.values(),
    },
  });
  vi.stubGlobal(
    'FontFace',
    class {
      /** Family descriptor returned by the browser FontFace API. */
      readonly family: string;
      /** Numeric weight descriptor returned by the browser FontFace API. */
      readonly weight: string;
      /** Normal or italic style descriptor returned by the browser FontFace API. */
      readonly style: string;

      /** Retain descriptors while the controllable loader stands in for actual font decoding.
       * @param definition Same family, bytes and descriptor tuple as the native constructor.
       */
      constructor(...definition: ConstructorParameters<typeof FontFace>) {
        this.family = definition[0];
        this.weight = definition[2]?.weight ?? 'normal';
        this.style = definition[2]?.style ?? 'normal';
      }

      /** Resolve the simulated browser decode before publishing the face to its document. */
      async load(): Promise<this> {
        await load();
        return this;
      }
    },
  );
  return { load, add, faces };
}

afterEach(() => vi.unstubAllGlobals());

describe('explicit font registration', () => {
  it('owns immutable bytes and deduplicates equivalent case-insensitive descriptors', async () => {
    // A simulated decoder keeps the unit test focused on ownership and descriptor identity.
    const browser = installFontBrowser();
    // The caller retains this buffer and may reuse it immediately after registration begins.
    const input = sfntProgram();
    // Retain expected contents independently before exercising caller-owned buffer mutation.
    const expected = input.slice();
    // Copying must happen before any asynchronous decoding work starts.
    const pending = registerFont({ family: 'Owned Sans', data: input });
    input.fill(0);
    // Loading the same face concurrently must share one FontFaceSet registration.
    const duplicate = registerFont({ family: 'owned sans', data: expected });
    // The returned record and each program view remain independently safe for callers to retain.
    const registered = await pending;
    expect(await duplicate).toBe(registered);
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Array.from(registered.bytes)).toEqual(Array.from(expected));
    registered.bytes.fill(9);
    expect(Array.from(registered.bytes)).toEqual(Array.from(expected));
    expect(browser.load).toHaveBeenCalledTimes(1);
    expect(browser.add).toHaveBeenCalledTimes(1);
    // Different program contents under the same descriptor must remain an explicit conflict.
    const conflicting = expected.slice();
    conflicting[conflicting.length - 1] = 1;
    await expect(registerFont({ family: 'Owned Sans', data: conflicting })).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
  });

  it('reports decoder failures and allows retry after a failed registration', async () => {
    // Failed browser decoding must not permanently occupy the descriptor cache.
    const browser = installFontBrowser();
    browser.load.mockRejectedValueOnce(new Error('Invalid font program'));
    // Program contents are intentionally decoded by the simulated browser boundary.
    const source = { family: 'Retry Sans', data: sfntProgram() };
    await expect(registerFont(source)).rejects.toMatchObject({ code: 'FONT_LOAD_FAILED' });
    await expect(registerFont(source)).resolves.toMatchObject({ family: 'Retry Sans' });
    expect(browser.load).toHaveBeenCalledTimes(2);
    expect(browser.add).toHaveBeenCalledTimes(1);
  });

  it('rejects externally defined descriptors and weight ranges before loading', async () => {
    // CSS and outside scripts own unknown programs even when their labels match supplied bytes.
    const browser = installFontBrowser();
    browser.faces.add({ family: '"EXTERNAL SANS"', weight: 'normal', style: 'normal' });
    await expect(
      registerFont({ family: 'External Sans', data: sfntProgram() }),
    ).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
      message: expect.stringContaining('existing browser font face'),
    });
    browser.faces.add({ family: 'Variable Sans', weight: '100 900', style: 'italic' });
    await expect(
      registerFont({
        family: 'Variable Sans',
        weight: 700,
        style: 'italic',
        data: sfntProgram(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    expect(browser.load).not.toHaveBeenCalled();
    expect(browser.add).not.toHaveBeenCalled();
  });

  it('rejects variable fonts, compressed containers, collections and truncated SFNT directories', async () => {
    // Programs rejected here must never reach a browser decoder or enter the descriptor cache.
    const browser = installFontBrowser();
    // Signature-only container fixtures exercise each unsupported format before font decoding.
    const programs = [
      sfntProgram(['head', 'fvar']),
      sfntProgram(['head'], 0x774f4646),
      sfntProgram(['head'], 0x774f4632),
      sfntProgram(['head'], 0x74746366),
      sfntProgram().subarray(0, 16),
    ];
    for (const data of programs) {
      await expect(registerFont({ family: 'Static Only', data })).rejects.toMatchObject({
        code: 'FONT_LOAD_FAILED',
      });
    }
    expect(browser.load).not.toHaveBeenCalled();
    expect(browser.add).not.toHaveBeenCalled();
    // OpenType CFF shares the directory guard and is an explicitly supported static container.
    await expect(
      registerFont({ family: 'Static OTF', data: sfntProgram(['CFF '], 0x4f54544f) }),
    ).resolves.toMatchObject({ family: 'Static OTF' });
    expect(Array.from(browser.faces)[0]!.family).toBe('Static OTF');
  });

  it('requires owned current-document handles and detects removed faces or later external conflicts', async () => {
    // A successful immutable handle must still refer to the browser face that originally loaded it.
    const browser = installFontBrowser();
    // Structural public type compatibility alone cannot establish actual browser program ownership.
    const registered = await registerFont({ family: 'Handle Sans', data: sfntProgram() });
    expect(() => validateRegisteredFonts([registered])).not.toThrow();
    expect(() => validateRegisteredFonts([{ ...registered }])).toThrow(
      expect.objectContaining({ code: 'MISSING_FONT' }),
    );
    expect(() => validateRegisteredFonts([null as unknown as RegisteredFont])).toThrow(
      expect.objectContaining({ code: 'MISSING_FONT' }),
    );
    // Outside scripts can add a conflicting program after registration initially succeeds.
    const conflicting = { family: 'HANDLE SANS', weight: '400', style: 'normal' };
    browser.faces.add(conflicting);
    expect(() => validateRegisteredFonts([registered])).toThrow(
      expect.objectContaining({ code: 'INVALID_OPTIONS' }),
    );
    browser.faces.delete(conflicting);
    browser.faces.clear();
    expect(() => validateRegisteredFonts([registered])).toThrow(
      expect.objectContaining({ code: 'MISSING_FONT' }),
    );
    // Handles registered in another document cannot establish this document's layout font choice.
    installFontBrowser();
    expect(() => validateRegisteredFonts([registered])).toThrow(
      expect.objectContaining({ code: 'MISSING_FONT' }),
    );
  });

  it('rejects generic families, CSS descriptor injection and unsupported static descriptors', async () => {
    installFontBrowser();
    // Families used inside generated CSS must remain one unambiguous custom name.
    for (const family of [
      'serif',
      'Sans-Serif',
      'inherit',
      'Face, serif',
      'Face"; color:red',
      '',
    ]) {
      await expect(registerFont({ family, data: sfntProgram() })).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
      });
    }
    await expect(
      registerFont({ family: 'Test Sans', weight: 400.5, data: sfntProgram() }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTIONS' });
    await expect(
      registerFont({ family: 'Test Sans', data: new Uint8Array() }),
    ).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    });
  });
});
