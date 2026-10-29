import { defineConfig } from 'vite-plus';
import { fileURLToPath } from 'node:url';

/** Build a local ESM library while leaving runtime dependencies to the consuming bundler. */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    // Keep the licensed base font self-contained in the browser ESM bundle.
    assetsInlineLimit: 1_000_000,
    lib: {
      entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      formats: ['es'],
      fileName: 'index',
    },
    rolldownOptions: {
      external: ['pdf-lib', '@pdf-lib/fontkit', 'html-to-image', 'utif2'],
      output: {
        // The optional base font stays in a separate, package-owned browser module.
        chunkFileNames: '[name]-[hash].js',
      },
    },
  },
});
