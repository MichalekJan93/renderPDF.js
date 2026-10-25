import { defineConfig } from '@playwright/test';

/** Test the independently built consumer rather than the library's source server. */
export default defineConfig({
  testDir: './tests',
  workers: 1,
  timeout: 120_000,
  use: {
    browserName: 'chromium',
    channel: 'chrome',
    baseURL: 'http://127.0.0.1:5181',
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  },
  webServer: {
    command: 'npm run preview -- --port 5181',
    url: 'http://127.0.0.1:5181',
    reuseExistingServer: false,
  },
});
