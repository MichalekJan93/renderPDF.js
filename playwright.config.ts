import { defineConfig } from '@playwright/test';

/** Optional official Chrome executable outside the system Applications directory. */
const chromeExecutablePath = process.env.RENDERPDF_CHROME_EXECUTABLE;

/** Chrome is a test dependency only; conversion itself has no browser automation dependency. */
export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  use: {
    browserName: 'chromium',
    ...(chromeExecutablePath
      ? { launchOptions: { executablePath: chromeExecutablePath } }
      : { channel: 'chrome' }),
    baseURL: 'http://127.0.0.1:5183',
    viewport: { width: 1000, height: 900 },
    deviceScaleFactor: 1,
  },
  webServer: {
    command: 'npm run dev -- --port 5183 --strictPort',
    url: 'http://127.0.0.1:5183/tests/fixtures/rendering.html',
    reuseExistingServer: false,
  },
});
