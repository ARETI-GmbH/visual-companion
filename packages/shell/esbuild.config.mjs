import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('./dist', { recursive: true });

await build({
  entryPoints: ['./src/window.ts'],
  bundle: true,
  outfile: './dist/window.js',
  format: 'esm',
  target: ['chrome120'],
  sourcemap: 'inline',
  logLevel: 'info',
});

await copyFile('./src/window.html', './dist/window.html');
await copyFile('./src/styles.css', './dist/window.css');
console.log('shell: build complete');
