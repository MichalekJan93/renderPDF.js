import { defineConfig } from 'vite-plus';
import { fileURLToPath } from 'node:url';

/** Build a local ESM library while leaving runtime dependencies to the consuming bundler. */
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    lib: {
      entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      formats: ['es'],
      fileName: 'index',
    },
    rolldownOptions: {
      external: ['pdf-lib', '@pdf-lib/fontkit', 'html-to-image', 'utif2'],
    },
  },
});
