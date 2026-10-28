// Unicode regression samples use explicit escapes to preserve the tested glyphs.
import { expect, test } from '@playwright/test';

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
