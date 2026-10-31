import { defineConfig } from '@playwright/test';

/** Optional local Edge application outside the system Applications directory. */
const edgeExecutablePath = process.env.RENDERPDF_EDGE_EXECUTABLE;

/** Exercise installed browser engines independently with the same small public-API smoke suite. */
export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'cross-browser.spec.ts',
  workers: 1,
  projects: [
    {
      name: 'edge',
      use: {
        browserName: 'chromium',
        ...(edgeExecutablePath
          ? { launchOptions: { executablePath: edgeExecutablePath } }
          : { channel: 'msedge' }),
      },
    },
    {
      name: 'firefox',
      use: { browserName: 'firefox' },
    },
    {
      // Playwright WebKit exercises Safari's engine, not the Safari application.
      name: 'webkit',
      use: { browserName: 'webkit' },
    },
  ],
  use: {
    baseURL: 'http://127.0.0.1:5184',
    viewport: { width: 1000, height: 900 },
    deviceScaleFactor: 1,
  },
  webServer: {
    command: 'npm run dev -- --port 5184 --strictPort',
    url: 'http://127.0.0.1:5184/tests/fixtures/hybrid-pages.html',
    reuseExistingServer: false,
  },
});
