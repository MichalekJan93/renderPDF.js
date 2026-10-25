import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release } from 'node:os';
import type { BenchmarkFixture } from '../fixtures/benchmark';

const scenarios = ['small-native', 'medium-native', 'large-native', 'medium-hybrid'] as const;
const measuredSamples = 3;

for (const name of scenarios) {
  test(name, async ({ page, browser }, testInfo) => {
    await page.goto('/tests/fixtures/benchmark.html');
    await page.waitForFunction(() => Boolean(window.benchmark));
    const input = await page.evaluate((scenario) => window.benchmark.select(scenario), name);
    // Warm font embedding and browser/JIT paths equally, but retain the first-export cost too.
    const firstExport = await page.evaluate(() => window.benchmark.run());
    const samples: Awaited<ReturnType<BenchmarkFixture['run']>>[] = [];
    for (let index = 0; index < measuredSamples; index += 1) {
      samples.push(await page.evaluate(() => window.benchmark.run()));
    }
    const durations = samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
    const report = {
      scenario: name,
      input,
      environment: {
        browser: browser.version(),
        userAgent: await page.evaluate(() => navigator.userAgent),
        node: process.version,
        os: `${platform()} ${release()} ${arch()}`,
        cpu: cpus()[0]?.model ?? 'unknown',
      },
      warmupExports: 1,
      firstExportMs: firstExport.elapsedMs,
      measuredExports: measuredSamples,
      medianMs: durations[1]!,
      minMs: durations[0]!,
      maxMs: durations[2]!,
      samples,
    };
    // Transfer a single PDF after timing; repeated large IPC arrays would disturb later samples.
    const lastBytes = await page.evaluate(() => window.benchmark.lastBytes());
    await writeFile(testInfo.outputPath('benchmark.json'), JSON.stringify(report, null, 2));
    await writeFile(testInfo.outputPath('last-export.pdf'), Uint8Array.from(lastBytes));
    await testInfo.attach('benchmark', {
      path: testInfo.outputPath('benchmark.json'),
      contentType: 'application/json',
    });
    console.log(
      `${name}: median ${report.medianMs.toFixed(1)} ms (${report.minMs.toFixed(1)}–${report.maxMs.toFixed(1)}), ${samples[0]!.pageCount} pages, ${samples[0]!.bytes} bytes`,
    );
    // Correctness gates remain deterministic; wall time is evidence, not a shared-runner speed gate.
    expect(new Set([firstExport, ...samples].map((sample) => sample.pageCount)).size).toBe(1);
    expect(samples[0]!.pageCount).toBeGreaterThan(0);
    if (name === 'large-native') expect(samples[0]!.pageCount).toBeGreaterThan(3);
    expect(lastBytes).toHaveLength(samples.at(-1)!.bytes);
    expect(Buffer.from(lastBytes).subarray(0, 5).toString()).toBe('%PDF-');
    for (const sample of [firstExport, ...samples]) {
      expect(Number.isFinite(sample.elapsedMs) && sample.elapsedMs > 0).toBe(true);
      expect(sample.header).toBe('%PDF-');
      expect(sample.bytes).toBeGreaterThan(1_000);
      expect(sample.warningCodes.filter((code) => code === 'RASTER_FALLBACK')).toHaveLength(
        input.rasterRegions,
      );
    }
  });
}
