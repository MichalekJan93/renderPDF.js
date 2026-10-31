import { defineConfig } from '@playwright/test';

/** Optional official Edge executable outside the system Applications directory. */
const edgeExecutablePath = process.env.RENDERPDF_EDGE_EXECUTABLE;

/** Repeat the packaged playground workflows in three independently launched engines. */
export default defineConfig({
  testDir: './tests',
  workers: 1,
  timeout: 120_000,
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
    { name: 'firefox', use: { browserName: 'firefox' } },
    // Playwright WebKit is Safari-engine coverage, not automation of Safari.app.
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  use: {
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
