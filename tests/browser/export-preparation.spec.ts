import { expect, test } from '@playwright/test';

test('export prepares resources once and retains late CSSOM mutation detection', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/invoice.html');
  // Count browser work instead of asserting machine-dependent export durations.
  const evidence = await page.evaluate(async () => {
    // Exercise the same public entry that ordinary browser consumers import.
    const modulePath = '/src/index.ts';
    // Keep browser module loading separate from TypeScript's filesystem resolution.
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    // A real explicitly registered face keeps preparation independent of browser fallback fonts.
    const response = await fetch('/fonts/NotoSans-Regular.ttf');
    // Font loading completes before counting work belonging to each export.
    const font = await api.registerFont({
      family: 'Preparation Sans',
      data: await response.arrayBuffer(),
    });
    // This inert custom value participates only in the complete source-state fingerprint.
    const probeProperty = '--renderpdf-fingerprint-probe';
    // CSSOM declarations allow later mutation without producing a DOM observer record.
    const stylesheet = document.createElement('style');
    document.head.append(stylesheet);
    stylesheet.sheet!.insertRule(
      `#preparation-source { width: 600px; color: rgb(20, 30, 40); font: 14px/1.5 "Preparation Sans"; ${probeProperty}: initial-state; }`,
    );
    // Retain the exact rule rather than editing its owning style element's text.
    const sourceRule = stylesheet.sheet!.cssRules[0] as CSSStyleRule;
    // The small synthetic source contains selectable Czech text and one native bitmap.
    const source = document.createElement('div');
    source.id = 'preparation-source';
    source.append(document.createTextNode('Příliš žluťoučký kůň ověřuje přípravu exportu.'));
    // Generate a local PNG without external resources or tracked fixture binaries.
    const canvas = document.createElement('canvas');
    canvas.width = 12;
    canvas.height = 8;
    // A nontransparent image guarantees that the writer embeds an actual native image operation.
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#285a87';
    context.fillRect(0, 0, canvas.width, canvas.height);
    // Explicit geometry makes resource readiness independent of intrinsic-size changes.
    const image = document.createElement('img');
    image.width = canvas.width;
    image.height = canvas.height;
    image.style.display = 'block';
    image.src = canvas.toDataURL('image/png');
    source.append(image);
    document.body.replaceChildren(source);
    await image.decode();
    // Save browser APIs exactly so instrumentation cannot leak into later assertions or tests.
    const nativeDecode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode')!
      .value as HTMLImageElement['decode'];
    const nativeComputedStyle = window.getComputedStyle;
    const nativeFetch = window.fetch;
    // Counts reset per export and include only this fixture's source and image.
    let fingerprintReads = 0;
    let decodeCalls = 0;
    let callbackCalls = 0;
    let lateMutations = 0;
    let mutationRecords = 0;
    // Independent DOM observation proves the late edit requires CSSOM fingerprint detection.
    const observer = new MutationObserver((records) => {
      mutationRecords += records.length;
    });
    observer.observe(source, {
      subtree: true,
      attributes: true,
      childList: true,
      characterData: true,
    });
    observer.observe(document.head, {
      subtree: true,
      attributes: true,
      childList: true,
      characterData: true,
    });
    // Retain the structural cost and successful output of both public callback modes.
    const exports: {
      fingerprintReads: number;
      decodeCalls: number;
      callbackCalls: number;
      pageCount: number;
    }[] = [];
    try {
      /** Count the source image's readiness work while preserving native decode behavior. */
      HTMLImageElement.prototype.decode = function (this: HTMLImageElement) {
        if (this === image) decodeCalls += 1;
        return nativeDecode.call(this);
      };
      /** Count complete fingerprint reads without replacing computed browser layout. */
      window.getComputedStyle = (element, pseudo) => {
        // Every call receives the browser's fresh live declaration, never cached computed values.
        const style = nativeComputedStyle.call(window, element, pseudo);
        if (element === source && !pseudo) {
          // Binding preserves native CSSStyleDeclaration receiver checks for all other properties.
          const nativePropertyValue = style.getPropertyValue.bind(style);
          Object.defineProperty(style, 'getPropertyValue', {
            configurable: true,
            /** The renderer's regular measurement does not read this otherwise-unused property. */
            value: (property: string) => {
              if (property === probeProperty) fingerprintReads += 1;
              return nativePropertyValue(property);
            },
          });
        }
        return style;
      };
      // Exercise both callback modes against identical already-decoded browser content.
      for (const notify of [false, true]) {
        fingerprintReads = 0;
        decodeCalls = 0;
        callbackCalls = 0;
        // Warning callbacks add one required source check after application code has run.
        const result = await api.renderPDF(source, {
          fonts: [font],
          ...(notify
            ? {
                onWarning: () => {
                  callbackCalls += 1;
                },
              }
            : {}),
        });
        exports.push({ fingerprintReads, decodeCalls, callbackCalls, pageCount: result.pageCount });
      }
      /** Edit computed paint only after the writer reaches its asynchronous native image fetch. */
      window.fetch = (input, init) => {
        // Public fetch accepts URL, Request and string inputs; preserve each original request.
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url === image.currentSrc) {
          lateMutations += 1;
          sourceRule.style.setProperty('color', 'rgb(100, 20, 30)');
          sourceRule.style.setProperty(probeProperty, 'changed-during-writing');
        }
        return nativeFetch.call(window, input, init);
      };
      // Successful writing must never commit pixels and text measured before this CSSOM edit.
      let rejectedCode = 'NO_ERROR';
      try {
        await api.renderPDF(source, { fonts: [font] });
      } catch (error) {
        rejectedCode = error instanceof api.RenderPDFError ? error.code : 'UNEXPECTED_ERROR';
      }
      mutationRecords += observer.takeRecords().length;
      return { exports, lateMutations, mutationRecords, rejectedCode };
    } finally {
      HTMLImageElement.prototype.decode = nativeDecode;
      window.getComputedStyle = nativeComputedStyle;
      window.fetch = nativeFetch;
      observer.disconnect();
    }
  });
  expect(evidence.exports.map((entry) => entry.decodeCalls)).toEqual([1, 1]);
  expect(evidence.exports.map((entry) => entry.fingerprintReads)).toEqual([2, 3]);
  expect(evidence.exports.map((entry) => entry.pageCount)).toEqual([1, 1]);
  expect(evidence.exports[0]!.callbackCalls).toBe(0);
  expect(evidence.exports[1]!.callbackCalls).toBeGreaterThan(0);
  expect(evidence.lateMutations).toBe(1);
  expect(evidence.mutationRecords).toBe(0);
  expect(evidence.rejectedCode).toBe('SOURCE_CHANGED');
});
