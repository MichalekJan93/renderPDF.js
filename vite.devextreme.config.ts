import { defineConfig } from 'vite-plus';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Optional vendor integration uses an installed package supplied by the caller. */
const configured = process.env.RENDERPDF_DEVEXTREME_DIR;
if (!configured) {
  throw new Error('Set RENDERPDF_DEVEXTREME_DIR to an installed devextreme package directory.');
}
const vendorDirectory = realpathSync(resolve(configured));
const vendorManifest: unknown = JSON.parse(
  readFileSync(resolve(vendorDirectory, 'package.json'), 'utf8'),
);
if (
  !vendorManifest ||
  typeof vendorManifest !== 'object' ||
  !('name' in vendorManifest) ||
  vendorManifest.name !== 'devextreme' ||
  !('version' in vendorManifest) ||
  typeof vendorManifest.version !== 'string' ||
  !vendorManifest.version.startsWith('25.1.') ||
  !existsSync(resolve(vendorDirectory, 'ui/data_grid/package.json'))
) {
  throw new Error('The optional integration suite currently verifies DevExtreme 25.1.x.');
}
const workspace = fileURLToPath(new URL('.', import.meta.url));
const virtualModule = 'virtual:renderpdf-devextreme';
const vendorVersion = vendorManifest.version;

export default defineConfig({
  plugins: [
    {
      name: 'renderpdf-optional-devextreme',
      resolveId(id) {
        return id === virtualModule || id === '/__renderpdf_devextreme__.js'
          ? `\0${virtualModule}`
          : undefined;
      },
      load(id) {
        if (id !== `\0${virtualModule}`) return undefined;
        return [
          "import 'devextreme/dist/css/dx.light.css';",
          "export { default as DataGrid } from 'devextreme/ui/data_grid';",
          "export { exportDataGrid } from 'devextreme/pdf_exporter';",
          `export const installedVersion = ${JSON.stringify(vendorVersion)};`,
        ].join('\n');
      },
    },
  ],
  resolve: { alias: { devextreme: vendorDirectory } },
  // Dependencies can be siblings of the installed vendor package, never arbitrary local files.
  server: {
    host: '127.0.0.1',
    port: 5185,
    strictPort: true,
    fs: { allow: [workspace, dirname(vendorDirectory)] },
  },
});
