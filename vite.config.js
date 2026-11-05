import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Served from the portfolio at /tools/image-optimizer/. The build lands inside Eleventy's output,
// so one deploy ships both. Only this route loads it, and codecs load per format on first use.
export default defineConfig({
  base: '/tools/image-optimizer/app/',
  publicDir: false,
  worker: { format: 'es' },
  build: {
    outDir: process.env.OUT_DIR ?? resolve(import.meta.dirname, '../../_site/tools/image-optimizer/app'),
    emptyOutDir: true,
    modulePreload: false,
    target: 'es2022',
    rollupOptions: {
      input: resolve(import.meta.dirname, 'ui/main.js'),
      output: { entryFileNames: 'main.js' },
    },
  },
});
