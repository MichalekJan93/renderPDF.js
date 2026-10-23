import { defineConfig } from '@playwright/test';

/** Installed Chromium is sufficient; conversion itself has no browser automation dependency. */
export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  use: {
    browserName: 'chromium',
    channel: 'chrome',
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1000, height: 900 },
    deviceScaleFactor: 1,
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173',
    reuseExistingServer: !process.env.CI,
  },
});
