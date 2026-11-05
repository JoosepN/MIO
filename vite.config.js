import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const here = import.meta.dirname;

// index.html has a placeholder for the tool, so the markup stays in one file a host page can share.
const toolMarkup = {
  name: 'mio-tool-markup',
  transformIndexHtml: (html) => html.replace('<!-- mio:tool -->', readFileSync(resolve(here, 'ui/tool.html'), 'utf8')),
};

// `vite build` makes a complete site in dist/. `--mode embed` leaves out index.html and gives a
// stable main.js and tool.css, for placing ui/tool.html inside another page.
export default defineConfig(({ mode }) => ({
  base: './',
  publicDir: false,
  plugins: [toolMarkup],
  worker: { format: 'es' },
  build: {
    modulePreload: false,
    target: 'es2022',
    rollupOptions: {
      input: resolve(here, mode === 'embed' ? 'ui/main.js' : 'index.html'),
      output: {
        entryFileNames: 'main.js',
        assetFileNames: (asset) => (asset.names?.some((name) => name.endsWith('.css')) ? 'tool.css' : 'assets/[name]-[hash][extname]'),
      },
    },
  },
}));
