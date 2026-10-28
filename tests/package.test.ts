import { describe, expect, it } from 'vite-plus/test';
import { validatePackageManifest } from '../scripts/check-package';

/** An independently constructed pack entry keeps the fixture separate from policy implementation. */
type PackedFile = { path: string; size: number };

/** Construct the smallest complete npm package with nonempty generated entry points. */
function requiredFiles(): PackedFile[] {
  // These public assets and entry points must survive a clean build and pack.
  const paths = [
    'package.json',
    'README.md',
    'API.md',
    'CHANGELOG.md',
    'LICENSE',
    'assets/renderpdf-logo.png',
    'dist/index.js',
    'dist/index.d.ts',
  ];
  return paths.map((path) => ({ path, size: 100 }));
}

describe('npm package contents', () => {
  it('accepts the public package and flat declarations used by exported types', () => {
    // Additional declarations are needed when index.d.ts imports internal contracts.
    const files = [...requiredFiles(), { path: 'dist/api-types.d.ts', size: 80 }];
    expect(validatePackageManifest([{ files }])).toEqual([]);
  });

  it.each([
    'AGENTS.md',
    'docs/feasibility.md',
    'artifacts/preview/private.html',
    'node_modules/pdf-lib/package.json',
    'experiments/demo.ts',
    'public/fonts/NotoSans-Regular.ttf',
    'dist/demo/index.html',
    'dist/stale.js',
    'dist/nested/contract.d.ts',
  ])('rejects an unintended packed file: %s', (path) => {
    // The candidate path models a private input, development asset or stale build product.
    const files = [...requiredFiles(), { path, size: 100 }];
    expect(validatePackageManifest([{ files }])).not.toEqual([]);
  });

  it.each([
    'dist/index.js',
    'dist/index.d.ts',
    'CHANGELOG.md',
    'LICENSE',
    'assets/renderpdf-logo.png',
  ])('rejects a package missing its required file: %s', (path) => {
    // Removing a required path simulates an incomplete build or overbroad exclusion.
    const files = requiredFiles().filter((file) => file.path !== path);
    expect(validatePackageManifest([{ files }])).not.toEqual([]);
  });

  it('rejects duplicate entries even when every required path is present', () => {
    // A duplicate manifest entry must not conceal an ambiguous package inventory.
    const files = [...requiredFiles(), { path: 'dist/index.js', size: 200 }];
    expect(validatePackageManifest([{ files }])).not.toEqual([]);
  });

  it.each([0, -1, 1.5])('rejects a required entry with invalid byte size: %s', (size) => {
    // Replacing the JavaScript entry models an empty or malformed build artifact.
    const files = requiredFiles().map((file) =>
      file.path === 'dist/index.js' ? { ...file, size } : file,
    );
    expect(validatePackageManifest([{ files }])).not.toEqual([]);
  });

  it.each([
    null,
    {},
    [],
    [{ files: [] }],
    [{ files: [] }, { files: [] }],
    [{ files: [null] }],
    [{ files: [{ path: 7, size: 100 }] }],
  ])('reports malformed or empty npm output without throwing: %j', (manifest) => {
    // The unknown npm response must be validated before its entries are inspected.
    expect(validatePackageManifest(manifest)).not.toEqual([]);
  });
});
