import { build } from '../node_modules/.pnpm/esbuild@0.24.0/node_modules/esbuild/lib/main.js';

const banner = [
  'import{createRequire as _cr}from"module";',
  'const _origReq=_cr(import.meta.url);',
  'const require=(id)=>id==="node-fetch"?Object.assign(globalThis.fetch,{default:globalThis.fetch}):id==="abort-controller"?{AbortController:globalThis.AbortController}:_origReq(id);',
].join('');

const r = await build({
  entryPoints: ['services/telegram-bot/src/handler.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external: ['@aws-sdk/*'],
  outfile: '.tmp-deploy/index.mjs',
  write: true,
  minify: true,
  sourcemap: true,
  banner: { js: banner },
});
console.log('OK', r.errors.length, 'errors', r.warnings.length, 'warnings');
