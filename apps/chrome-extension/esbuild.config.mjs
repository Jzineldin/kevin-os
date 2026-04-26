/**
 * Phase 5 Plan 05-00 scaffold — esbuild config for the Chrome MV3 extension.
 *
 * Bundles four entry points (background service worker, two content scripts,
 * options page script) to `dist/`. A small `copy-plugin` step also copies
 * the static manifest + options HTML into `dist/` so the directory can be
 * loaded directly via chrome://extensions "Load unpacked".
 *
 * Real wiring (zod-validated webhook URLs, Bearer + HMAC signing, retry
 * queue, alarms) arrives in Plans 05-01 / 05-02 / 05-03.
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const out = resolve(root, 'dist');

mkdirSync(out, { recursive: true });

const entries = {
  background: resolve(root, 'src/background.ts'),
  'content-highlight': resolve(root, 'src/content-highlight.ts'),
  'content-linkedin': resolve(root, 'src/content-linkedin.ts'),
  options: resolve(root, 'src/options.ts'),
};

await build({
  entryPoints: entries,
  outdir: out,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  minify: true,
  sourcemap: true,
  logLevel: 'info',
});

// Copy static assets that esbuild does not bundle.
copyFileSync(resolve(root, 'src/manifest.json'), resolve(out, 'manifest.json'));
copyFileSync(resolve(root, 'src/options.html'), resolve(out, 'options.html'));

console.log('chrome-extension build complete →', out);
