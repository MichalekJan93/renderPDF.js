import { defineConfig } from '@playwright/test';

/** Run timings alone so competing browser workers cannot distort the samples. */
export default defineConfig({
  testDir: './tests/benchmarks',
  workers: 1,
  retries: 0,
  timeout: 180_000,
  outputDir: './artifacts/benchmarks',
  reporter: [['list'], ['json', { outputFile: './artifacts/benchmarks-report.json' }]],
  use: {
    browserName: 'chromium',
    channel: 'chrome',
    baseURL: 'http://127.0.0.1:5184',
    viewport: { width: 1000, height: 900 },
    deviceScaleFactor: 1,
  },
  webServer: {
    command: 'npm run dev -- --port 5184 --strictPort',
    url: 'http://127.0.0.1:5184/tests/fixtures/benchmark.html',
    reuseExistingServer: false,
  },
});
