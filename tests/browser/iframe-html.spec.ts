// Unicode regression samples use explicit escapes to preserve the tested glyphs.
import { expect, test } from '@playwright/test';

test('renderHTML exports Unicode with bundled faces and reports copied font substitution', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/rendering.html');
  const evidence = await page.evaluate(async () => {
    // The public entry and PDF inspector run in the same browser realm as the isolated document.
    const modulePath = '/src/index.ts';
    const inspectorPath = '/tests/browser/pdf-inspector.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const inspector = (await import(
      /* @vite-ignore */ inspectorPath
    )) as typeof import('./pdf-inspector');
    const observed: string[] = [];
    let warningFrozen = false;
    const before = document.querySelectorAll('iframe').length;
    const result = await api.renderHTML(
      '<!doctype html><html><head><style>body{font-family:"Missing Serif";font-size:18px;margin:0;width:460px}</style></head><body><p>Unicode sample: P\u0159\u00edli\u0161 \u017elu\u0165ou\u010dk\u00fd k\u016f\u0148.</p><p><strong>Bold sample.</strong></p></body></html>',
      {
        sourceWidth: 460,
        onWarning: (warning) => {
          observed.push(warning.code);
          warningFrozen ||= Object.isFrozen(warning);
        },
      },
    );
    const pages = await inspector.inspectPdf(Array.from(await result.toUint8Array()));
    return {
      pageCount: result.pageCount,
      text: pages.flatMap((output) => output.text.map((item) => item.text)).join(' '),
      warnings: result.warnings.map((warning) => warning.code),
      observed,
      warningFrozen,
      before,
      after: document.querySelectorAll('iframe').length,
    };
  });
  expect(evidence.pageCount).toBe(1);
  expect(evidence.text).toContain(
    'P\u0159\u00edli\u0161 \u017elu\u0165ou\u010dk\u00fd k\u016f\u0148',
  );
  expect(evidence.text).toContain('Bold sample');
  expect(evidence.warnings.filter((code) => code === 'FONT_SUBSTITUTED')).toHaveLength(1);
  expect(evidence.observed).toContain('FONT_SUBSTITUTED');
  expect(evidence.warningFrozen).toBe(true);
  expect(evidence.after).toBe(evidence.before);
});

test('renderPDF distinguishes strict mismatch from diagnosed fallback without editing source', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/rendering.html');
  const evidence = await page.evaluate(async () => {
    // A supplied face intentionally differs from the source CSS family.
    const modulePath = '/src/index.ts';
    const inspectorPath = '/tests/browser/pdf-inspector.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const inspector = (await import(
      /* @vite-ignore */ inspectorPath
    )) as typeof import('./pdf-inspector');
    const response = await fetch('/fonts/NotoSans-Regular.ttf');
    const font = await api.registerFont({
      family: 'Available Sans',
      data: await response.arrayBuffer(),
    });
    const source = document.createElement('div');
    source.style.cssText = 'font-family:"Missing Serif";font-size:18px;width:400px';
    source.textContent = 'Direct export sample.';
    document.body.append(source);
    const before = source.outerHTML;
    try {
      let strictCode = '';
      try {
        await api.renderPDF(source, { fonts: [font], fontMismatch: 'error' });
      } catch (error) {
        strictCode = error instanceof api.RenderPDFError ? error.code : String(error);
      }
      let noFontStrictCode = '';
      try {
        await api.renderPDF(source, { fontMismatch: 'error' });
      } catch (error) {
        noFontStrictCode = error instanceof api.RenderPDFError ? error.code : String(error);
      }
      const observed: string[] = [];
      const fallback = await api.renderPDF(source, {
        fonts: [font],
        fontMismatch: 'fallback',
        fontFallback: 'Available Sans',
        onWarning: (warning) => observed.push(warning.code),
      });
      const defaultResult = await api.renderPDF(source);
      const pages = await inspector.inspectPdf(Array.from(await fallback.toUint8Array()));
      const defaultPages = await inspector.inspectPdf(
        Array.from(await defaultResult.toUint8Array()),
      );
      return {
        strictCode,
        noFontStrictCode,
        text: pages.flatMap((output) => output.text.map((item) => item.text)).join(' '),
        defaultText: defaultPages
          .flatMap((output) => output.text.map((item) => item.text))
          .join(' '),
        warningCodes: fallback.warnings.map((warning) => warning.code),
        defaultWarningCodes: defaultResult.warnings.map((warning) => warning.code),
        observed,
        before,
        after: source.outerHTML,
      };
    } finally {
      source.remove();
    }
  });
  expect(evidence.strictCode).toBe('MISSING_FONT');
  expect(evidence.noFontStrictCode).toBe('MISSING_FONT');
  expect(evidence.text).toContain('Direct export sample');
  expect(evidence.defaultText).toContain('Direct export sample');
  expect(evidence.warningCodes).toContain('FONT_SUBSTITUTED');
  expect(evidence.defaultWarningCodes).toContain('FONT_SUBSTITUTED');
  expect(evidence.observed).toContain('FONT_SUBSTITUTED');
  expect(evidence.after).toBe(evidence.before);
});

test('raster text requires isolated relayout when its font is substituted', async ({ page }) => {
  await page.goto('/tests/fixtures/rendering.html');
  const evidence = await page.evaluate(async () => {
    // The same registered face is used by the live source and the isolated HTML export.
    const modulePath = '/src/index.ts';
    const inspectorPath = '/tests/browser/pdf-inspector.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const inspector = (await import(
      /* @vite-ignore */ inspectorPath
    )) as typeof import('./pdf-inspector');
    const response = await fetch('/fonts/NotoSans-Regular.ttf');
    const font = await api.registerFont({
      family: 'Available Sans',
      data: await response.arrayBuffer(),
    });
    const source = document.createElement('div');
    source.setAttribute('data-raster', '');
    source.style.cssText =
      'font-family:"Missing Serif";font-size:18px;width:240px;height:52px;background:#e8f0fc';
    source.textContent = 'Raster fallback sample.';
    document.body.append(source);
    const before = source.outerHTML;
    try {
      // A live raster clone cannot change descendant font layout through html-to-image's public API.
      let code = '';
      let message = '';
      try {
        await api.renderPDF(source, {
          fonts: [font],
          fontMismatch: 'fallback',
          fontFallback: 'Available Sans',
        });
      } catch (error) {
        code = error instanceof api.RenderPDFError ? error.code : String(error);
        message = error instanceof Error ? error.message : String(error);
      }
      // renderHTML owns a relaid-out copy, so its raster pixels and extraction use the same face.
      const isolated = await api.renderHTML(
        '<!doctype html><html><body><div data-raster style="font-family:\'Missing Serif\';font-size:18px;width:240px;height:52px;background:#e8f0fc">Raster fallback sample.</div></body></html>',
        {
          fonts: [{ family: 'Available Sans', data: font.bytes }],
          fontMismatch: 'fallback',
          fontFallback: 'Available Sans',
          sourceWidth: 320,
        },
      );
      const pages = await inspector.inspectPdf(Array.from(await isolated.toUint8Array()));
      return {
        code,
        message,
        before,
        after: source.outerHTML,
        text: pages.flatMap((output) => output.text.map((item) => item.text)).join(' '),
        warnings: isolated.warnings.map((warning) => warning.code),
      };
    } finally {
      source.remove();
    }
  });
  expect(evidence.code).toBe('RASTER_FAILED');
  expect(evidence.message).toContain('renderHTML relayouts an isolated copy');
  expect(evidence.after).toBe(evidence.before);
  expect(evidence.text).toContain('Raster fallback sample.');
  expect(evidence.warnings).toContain('FONT_SUBSTITUTED');
});

test('hidden raster text does not require an unavailable face', async ({ page }) => {
  await page.goto('/tests/fixtures/rendering.html');
  const evidence = await page.evaluate(async () => {
    // A hidden child has no painted glyphs or extraction text inside this local raster.
    const modulePath = '/src/index.ts';
    const inspectorPath = '/tests/browser/pdf-inspector.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const inspector = (await import(
      /* @vite-ignore */ inspectorPath
    )) as typeof import('./pdf-inspector');
    const response = await fetch('/fonts/NotoSans-Regular.ttf');
    const font = await api.registerFont({
      family: 'Available Sans',
      data: await response.arrayBuffer(),
    });
    const source = document.createElement('div');
    source.setAttribute('data-raster', '');
    source.style.cssText =
      'font-family:"Available Sans";font-size:18px;width:280px;height:52px;background:#e8f0fc';
    source.innerHTML =
      '<span>Visible raster sample.</span><span style="display:none;font-family:\'Missing Face\'">Hidden raster text.</span>';
    document.body.append(source);
    const before = source.outerHTML;
    try {
      const result = await api.renderPDF(source, {
        fonts: [font],
        fontMismatch: 'fallback',
        fontFallback: 'Available Sans',
      });
      const pages = await inspector.inspectPdf(Array.from(await result.toUint8Array()));
      return {
        text: pages.flatMap((output) => output.text.map((item) => item.text)).join(' '),
        warnings: result.warnings.map((warning) => warning.code),
        sourceUnchanged: source.outerHTML === before,
      };
    } finally {
      source.remove();
    }
  });
  expect(evidence.text).toContain('Visible raster sample.');
  expect(evidence.text).not.toContain('Hidden raster text.');
  expect(evidence.warnings).not.toContain('FONT_SUBSTITUTED');
  expect(evidence.sourceUnchanged).toBe(true);
});

test('a supplied regular face does not silently stand in for bold or italic CSS', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/rendering.html');
  const evidence = await page.evaluate(async () => {
    // Both style requests use the same regular font program and public export API.
    const modulePath = '/src/index.ts';
    const inspectorPath = '/tests/browser/pdf-inspector.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const inspector = (await import(
      /* @vite-ignore */ inspectorPath
    )) as typeof import('./pdf-inspector');
    const response = await fetch('/fonts/NotoSans-Regular.ttf');
    const font = await api.registerFont({
      family: 'Only Regular',
      data: await response.arrayBuffer(),
    });
    const source = document.createElement('div');
    source.style.cssText = 'font-family:"Only Regular";font-size:18px;width:320px';
    source.textContent = 'Styled fallback sample.';
    document.body.append(source);
    try {
      const outcomes: {
        requested: string;
        strictCode: string;
        text: string;
        warningCodes: string[];
        sourceUnchanged: boolean;
      }[] = [];
      for (const [requested, css] of [
        ['bold', 'font-weight:700;font-style:normal'],
        ['italic', 'font-weight:400;font-style:italic'],
      ] as const) {
        source.style.cssText = `font-family:"Only Regular";font-size:18px;width:320px;${css}`;
        const before = source.outerHTML;
        let strictCode = '';
        try {
          await api.renderPDF(source, { fonts: [font], fontMismatch: 'error' });
        } catch (error) {
          strictCode = error instanceof api.RenderPDFError ? error.code : String(error);
        }
        const fallback = await api.renderPDF(source, {
          fonts: [font],
          fontMismatch: 'fallback',
          fontFallback: 'Only Regular',
        });
        const pages = await inspector.inspectPdf(Array.from(await fallback.toUint8Array()));
        outcomes.push({
          requested,
          strictCode,
          text: pages.flatMap((output) => output.text.map((item) => item.text)).join(' '),
          warningCodes: fallback.warnings.map((warning) => warning.code),
          sourceUnchanged: source.outerHTML === before,
        });
      }
      return outcomes;
    } finally {
      source.remove();
    }
  });
  expect(evidence).toHaveLength(2);
  for (const outcome of evidence) {
    expect(outcome.strictCode, outcome.requested).toBe('MISSING_FONT');
    expect(outcome.text, outcome.requested).toContain('Styled fallback sample.');
    expect(outcome.warningCodes, outcome.requested).toContain('FONT_SUBSTITUTED');
    expect(outcome.sourceUnchanged, outcome.requested).toBe(true);
  }
});

test('hidden missing faces stay silent while nested bold italic text gets a diagnosed fallback', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/rendering.html');
  const evidence = await page.evaluate(async () => {
    // Independent HTML exports expose false positive warnings and missing style combinations.
    const modulePath = '/src/index.ts';
    const inspectorPath = '/tests/browser/pdf-inspector.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const inspector = (await import(
      /* @vite-ignore */ inspectorPath
    )) as typeof import('./pdf-inspector');
    const response = await fetch('/fonts/NotoSans-Regular.ttf');
    const fontData = await response.arrayBuffer();
    const exact = await api.renderHTML(
      '<!doctype html><html><body style="font-family:\'Exact Sans\';font-size:18px"><div style="display:none;font-family:\'Missing Face\'">Hidden text</div><div>Visible exact sample.</div></body></html>',
      {
        fonts: [{ family: 'Exact Sans', data: fontData }],
        fontMismatch: 'fallback',
        fontFallback: 'Exact Sans',
        sourceWidth: 320,
      },
    );
    const nested = await api.renderHTML(
      '<!doctype html><html><body style="font-family:\'RenderPDF Base\';font-size:18px"><strong><em>Nested styled sample.</em></strong></body></html>',
      { sourceWidth: 320 },
    );
    const exactPages = await inspector.inspectPdf(Array.from(await exact.toUint8Array()));
    const nestedPages = await inspector.inspectPdf(Array.from(await nested.toUint8Array()));
    return {
      exactWarnings: exact.warnings.map((warning) => warning.code),
      exactText: exactPages.flatMap((output) => output.text.map((item) => item.text)).join(' '),
      nestedWarnings: nested.warnings.map((warning) => warning.code),
      nestedMessages: nested.warnings.map((warning) => warning.message),
      nestedText: nestedPages.flatMap((output) => output.text.map((item) => item.text)).join(' '),
    };
  });
  expect(evidence.exactWarnings).not.toContain('FONT_SUBSTITUTED');
  expect(evidence.exactText).toContain('Visible exact sample.');
  expect(evidence.exactText).not.toContain('Hidden text');
  expect(evidence.nestedWarnings).toContain('FONT_SUBSTITUTED');
  expect(evidence.nestedMessages.join(' ')).toContain('700 italic');
  expect(evidence.nestedText).toContain('Nested styled sample.');
});

test('same-origin iframe owns layout, fonts and PDF text extraction', async ({ page }) => {
  await page.goto('/tests/fixtures/rendering.html');
  const evidence = await page.evaluate(async () => {
    const modulePath = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    // A separate browser realm exposes accidental global-document and instanceof checks.
    const frame = document.createElement('iframe');
    frame.srcdoc =
      '<!doctype html><style>body{font-family:"Frame Sans";font-size:18px;margin:0;width:460px}</style><body><div>P\u0159\u00edli\u0161 \u017elu\u0165ou\u010dk\u00fd k\u016f\u0148</div></body>';
    const loaded = new Promise<void>((resolve) =>
      frame.addEventListener('load', () => resolve(), { once: true }),
    );
    document.body.append(frame);
    try {
      await loaded;
      const sourceDocument = frame.contentDocument!;
      // Explicit bytes are owned by the iframe's FontFaceSet, rather than the parent page.
      const response = await fetch('/fonts/NotoSans-Regular.ttf');
      const font = await api.registerFont({
        family: 'Frame Sans',
        data: await response.arrayBuffer(),
        document: sourceDocument,
      });
      const result = await api.renderPDF(sourceDocument.body, { fonts: [font], margin: 24 });
      return { bytes: Array.from(await result.toUint8Array()), pages: result.pageCount };
    } finally {
      frame.remove();
    }
  });
  expect(evidence.pages).toBe(1);
  const extracted = await page.evaluate(async (bytes) => {
    const inspectorPath = '/tests/browser/pdf-inspector.ts';
    const inspector = (await import(
      /* @vite-ignore */ inspectorPath
    )) as typeof import('./pdf-inspector');
    return (await inspector.inspectPdf(bytes)).flatMap((output) =>
      output.text.map((item) => item.text),
    );
  }, evidence.bytes);
  expect(extracted.join(' ')).toContain(
    'P\u0159\u00edli\u0161 \u017elu\u0165ou\u010dk\u00fd k\u016f\u0148',
  );
});

test('renderHTML relayouts a copied full document and releases its iframe', async ({ page }) => {
  await page.goto('/tests/fixtures/rendering.html');
  const evidence = await page.evaluate(async () => {
    const modulePath = '/src/index.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const response = await fetch('/fonts/NotoSans-Regular.ttf');
    const bytes = await response.arrayBuffer();
    const before = document.querySelectorAll('iframe').length;
    const result = await api.renderHTML(
      '<!doctype html><html><head><style>body{font-family:Tahoma;font-size:18px;margin:0;width:480px}</style></head><body><p>Full-document Unicode export \u017d\u0165\u010d\u00fd.</p></body></html>',
      {
        fonts: [{ family: 'Copy Sans', data: bytes }],
        sourceWidth: 480,
        fontFallback: 'Copy Sans',
      },
    );
    return {
      bytes: Array.from(await result.toUint8Array()),
      warnings: result.warnings.map((warning) => warning.code),
      before,
      after: document.querySelectorAll('iframe').length,
    };
  });
  expect(evidence.after).toBe(evidence.before);
  expect(evidence.warnings).toContain('FONT_SUBSTITUTED');
  const extracted = await page.evaluate(async (bytes) => {
    const inspectorPath = '/tests/browser/pdf-inspector.ts';
    const inspector = (await import(
      /* @vite-ignore */ inspectorPath
    )) as typeof import('./pdf-inspector');
    return (await inspector.inspectPdf(bytes)).flatMap((output) =>
      output.text.map((item) => item.text),
    );
  }, evidence.bytes);
  expect(extracted.join(' ')).toContain('Full-document Unicode export \u017d\u0165\u010d\u00fd.');
});

test('renderHTML shadow fragment keeps one local raster and one extraction layer', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/rendering.html');
  const evidence = await page.evaluate(async () => {
    const modulePath = '/src/index.ts';
    const inspectorPath = '/tests/browser/pdf-inspector.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const inspector = (await import(
      /* @vite-ignore */ inspectorPath
    )) as typeof import('./pdf-inspector');
    const response = await fetch('/fonts/NotoSans-Regular.ttf');
    const result = await api.renderHTML(
      '<style>.card{font-family:"Shadow Sans";font-size:18px;width:280px;height:80px;background:linear-gradient(90deg,#ecb54b,#3669ac)}</style><div class="card">Shadow Unicode text \u00ed\u010d\u00fd</div>',
      {
        isolation: 'shadow',
        sourceWidth: 400,
        fonts: [{ family: 'Shadow Sans', data: await response.arrayBuffer() }],
        fontFallback: 'Shadow Sans',
      },
    );
    const pages = await inspector.inspectPdf(Array.from(await result.toUint8Array()));
    return {
      pageCount: pages.length,
      imagePaints: pages[0]?.imagePaints ?? 0,
      text: pages.flatMap((output) => output.text.map((item) => item.text)).join(' '),
    };
  });
  expect(evidence.pageCount).toBe(1);
  expect(evidence.imagePaints).toBe(1);
  expect(evidence.text).toContain('Shadow Unicode text \u00ed\u010d\u00fd');
});

test('renderHTML keeps a wide document layout before fitting it to landscape paper', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/rendering.html');
  const evidence = await page.evaluate(async () => {
    const modulePath = '/src/index.ts';
    const inspectorPath = '/tests/browser/pdf-inspector.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const inspector = (await import(
      /* @vite-ignore */ inspectorPath
    )) as typeof import('./pdf-inspector');
    const response = await fetch('/fonts/NotoSans-Regular.ttf');
    const result = await api.renderHTML(
      '<!doctype html><html><head><style>body{margin:0;width:1200px;font:18px "Wide Sans"}.wide{width:1200px;background:#dde9fa}</style></head><body><div class="wide">Wide Unicode document \u0160\u010d\u00fd stays laid out at 1200 px.</div></body></html>',
      {
        fonts: [{ family: 'Wide Sans', data: await response.arrayBuffer() }],
        sourceWidth: 1200,
        orientation: 'auto',
        fit: 'width',
      },
    );
    const pages = await inspector.inspectPdf(Array.from(await result.toUint8Array()));
    return {
      pages: pages.length,
      width: pages[0]?.width ?? 0,
      height: pages[0]?.height ?? 0,
      text: pages.flatMap((output) => output.text.map((item) => item.text)).join(' '),
    };
  });
  expect(evidence.pages).toBe(1);
  expect(evidence.width).toBeGreaterThan(evidence.height);
  expect(evidence.text).toContain('Wide Unicode document');
});

test('renderHTML repeats custom HTML header and footer outside the body source', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/rendering.html');
  const evidence = await page.evaluate(async () => {
    const modulePath = '/src/index.ts';
    const inspectorPath = '/tests/browser/pdf-inspector.ts';
    const api = (await import(/* @vite-ignore */ modulePath)) as typeof import('../../src/index');
    const inspector = (await import(
      /* @vite-ignore */ inspectorPath
    )) as typeof import('./pdf-inspector');
    const response = await fetch('/fonts/NotoSans-Regular.ttf');
    const before = document.querySelectorAll('iframe').length;
    const result = await api.renderHTML(
      '<!doctype html><html><head><style>body{font-family:"Band Sans";font-size:18px;margin:0;width:500px}</style></head><body><p>Document body appears in the PDF once.</p></body></html>',
      {
        fonts: [{ family: 'Band Sans', data: await response.arrayBuffer() }],
        sourceWidth: 500,
        header: {
          height: 32,
          html: '<span style="font-family:Band Sans;font-size:14px">CUSTOM HEADER</span>',
        },
        footer: {
          height: 32,
          html: '<span style="font-family:Band Sans;font-size:14px">CUSTOM FOOTER</span>',
        },
      },
    );
    const pages = await inspector.inspectPdf(Array.from(await result.toUint8Array()));
    return {
      pages: pages.length,
      text: pages.flatMap((output) => output.text.map((item) => item.text)).join(' '),
      before,
      after: document.querySelectorAll('iframe').length,
    };
  });
  expect(evidence.after).toBe(evidence.before);
  expect(evidence.pages).toBe(1);
  expect(evidence.text.match(/Document body/g)).toHaveLength(1);
  expect(evidence.text).toContain('CUSTOM HEADER');
  expect(evidence.text).toContain('CUSTOM FOOTER');
});

test('mutation-only verification admits CSSOM edits that full verification detects', async ({
  page,
}) => {
  await page.goto('/tests/fixtures/rendering.html');
  const outcome = await page.evaluate(async () => {
    const modulePath = '/src/prepare.ts';
    const { prepareSource } = (await import(
      /* @vite-ignore */ modulePath
    )) as typeof import('../../src/prepare');
    // CSSOM insertRule changes computed color without creating a MutationObserver record.
    const style = document.createElement('style');
    style.textContent = '#source-check { color: black; }';
    document.head.append(style);
    const source = document.createElement('div');
    source.id = 'source-check';
    source.textContent = 'Stable node';
    document.body.append(source);
    try {
      const full = prepareSource(source);
      await full.ready();
      full.captureBaseline();
      style.sheet!.insertRule('#source-check { color: red; }', 1);
      let fullRejected = false;
      try {
        full.assertUnchanged();
      } catch (error) {
        fullRejected = error instanceof Error && 'code' in error && error.code === 'SOURCE_CHANGED';
      } finally {
        full.dispose();
      }
      const mutations = prepareSource(source, undefined, 'mutations');
      await mutations.ready();
      mutations.captureBaseline();
      style.sheet!.insertRule('#source-check { color: blue; }', 2);
      mutations.assertUnchanged();
      mutations.dispose();
      return { fullRejected };
    } finally {
      style.remove();
      source.remove();
    }
  });
  expect(outcome.fullRejected).toBe(true);
});
