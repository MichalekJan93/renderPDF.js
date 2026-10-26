import { defineConfig } from '@playwright/test';

/** Real vendor tests stay separate from dependency-free default checks. */
export default defineConfig({
  testDir: './tests/compat',
  testMatch: 'devextreme.spec.ts',
  outputDir: './artifacts/devextreme-test-results',
  workers: 1,
  timeout: 120_000,
  use: {
    browserName: 'chromium',
    channel: 'chrome',
    baseURL: 'http://127.0.0.1:5185',
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  },
  webServer: {
    command: 'npx vp dev --config vite.devextreme.config.ts --port 5185 --strictPort',
    url: 'http://127.0.0.1:5185/tests/fixtures/devextreme.html',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
