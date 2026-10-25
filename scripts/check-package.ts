import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Inspect npm's parsed JSON output; report incomplete builds and unintended package contents.
 * @param manifest Untrusted output from npm pack --dry-run --json.
 */
export function validatePackageManifest(manifest: unknown): readonly string[] {
  if (!Array.isArray(manifest) || manifest.length !== 1) {
    return ['Expected exactly one npm package manifest.'];
  }
  // npm's boundary is unknown until the package and each file entry have been checked.
  const packageEntry: unknown = manifest[0];
  if (
    typeof packageEntry !== 'object' ||
    packageEntry === null ||
    !('files' in packageEntry) ||
    !Array.isArray(packageEntry.files)
  ) {
    return ['Expected an npm package file list.'];
  }
  // These entry points and public assets must exist even after a clean checkout.
  const requiredPaths = new Set([
    'package.json',
    'README.md',
    'LICENSE',
    'assets/renderpdf-logo.png',
    'dist/index.js',
    'dist/index.d.ts',
  ]);
  // Keep diagnostics independent from the inventory so duplicate entries cannot hide omissions.
  const errors: string[] = [];
  const seenPaths = new Set<string>();
  const files: readonly unknown[] = packageEntry.files;
  for (const file of files) {
    if (
      typeof file !== 'object' ||
      file === null ||
      !('path' in file) ||
      typeof file.path !== 'string' ||
      !('size' in file) ||
      typeof file.size !== 'number'
    ) {
      errors.push('Malformed npm package file entry.');
      continue;
    }
    if (seenPaths.has(file.path)) errors.push(`Duplicate package file: ${file.path}`);
    seenPaths.add(file.path);
    if (!requiredPaths.has(file.path) && !/^dist\/[A-Za-z0-9_-]+\.d\.ts$/.test(file.path)) {
      errors.push(`Unexpected package file: ${file.path}`);
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      errors.push(`Package file must contain a positive integer byte size: ${file.path}`);
    }
  }
  // Missing exports fail independently of npm's treatment of absent files patterns.
  for (const path of requiredPaths) {
    if (!seenPaths.has(path)) errors.push(`Missing package file: ${path}`);
  }
  return errors;
}

/** Ask the active npm CLI for its actual pack inventory without recursively running prepack. */
function checkPackage(): void {
  // npm supplies its JavaScript entry, avoiding shell-dependent npm.cmd execution on Windows.
  const npmCli = process.env.npm_execpath;
  assert(npmCli, 'Run this check through npm run check:package.');
  // Resolve the checkout from this script so invocation does not depend on the caller's directory.
  const result = spawnSync(
    process.execPath,
    [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || 'npm pack inventory failed.');
  // Parse into unknown before validating npm's output contract and the package policy.
  const manifest: unknown = JSON.parse(result.stdout);
  const errors = validatePackageManifest(manifest);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.info(
    'Package contents verified: library JavaScript, declarations and public assets only.',
  );
}

// Unit tests import the validator without spawning npm or requiring an existing build.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkPackage();
}
