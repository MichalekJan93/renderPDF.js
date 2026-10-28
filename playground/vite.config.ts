import { defineConfig } from 'vite-plus';

/** Run an independent consumer without aliases to the library checkout or development services. */
export default defineConfig({
  server: { host: '127.0.0.1', port: 5180, strictPort: true },
  preview: { host: '127.0.0.1', port: 5180, strictPort: true },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {
    singleQuote: true,
    printWidth: 100,
    sortPackageJson: false,
    ignorePatterns: ['node_modules', 'dist', 'test-results', 'package-lock.json', 'public/fonts'],
  },
});
