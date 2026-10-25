# Export benchmarks

Run from a clean checkout with Google Chrome installed and the Node version
recorded in `.node-version`:

```sh
npm ci
npm run benchmark
```

The command builds the library, then runs its built ESM entry in one headless
Chrome worker at a fixed 1000 × 900 viewport and device scale 1. Only synthetic
documents and the repository's licensed Noto Sans fixture font are used.

| Case          | Rows | Local raster regions |
| ------------- | ---: | -------------------: |
| Small native  |   12 |                    0 |
| Medium native |   96 |                    0 |
| Large native  |  384 |                    0 |
| Medium hybrid |   96 |                    1 |

Each case records its first export separately, then takes three warmed samples. Timings include source
validation, browser layout measurement, PDF generation and obtaining output
bytes. They exclude initial fixture/font loading, Playwright serialization,
download dialogs and writing files to disk. There is no result cache.
Only timing and output metadata cross the browser boundary between samples; the
last PDF is transferred once after measuring to avoid large serialization buffers
disturbing later exports.

Per-case `benchmark.json` and `last-export.pdf` files are written under the ignored
`artifacts/benchmarks/` directory. Reports include every sample, median, minimum,
maximum, input element count, page count, PDF size and browser/OS/CPU information.
`artifacts/benchmarks-report.json` also records the complete Playwright run.

Compare repeated runs on the same idle machine, browser and power settings. A
three-sample range describes that run; it is not a universal performance promise.
The benchmark asserts successful PDF output and stable pagination, with no hard
wall-time threshold on shared CI runners. Browser/PDF visual fidelity, selectable
text and local raster correctness are checked by `npm run test:browser`.

The GitHub workflow runs static checks, unit tests, browser verification, the
library build, package-content validation and these benchmarks. It also packs the
verified build and checks the independent playground against that archive. The
consumer dependency is reinstalled on the disposable runner because the local
`0.0.0` archive's integrity changes with the build. It retains test and timing
artifacts for inspecting failures and comparing runs. It does not publish a package.
