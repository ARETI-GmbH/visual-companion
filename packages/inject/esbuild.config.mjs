import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('./dist', { recursive: true });

await build({
  entryPoints: ['./src/index.ts'],
  bundle: true,
  outfile: './dist/inject.js',
  format: 'iife',
  globalName: '__visualCompanion__',
  target: ['chrome100'],
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});

console.log('inject: build complete');
