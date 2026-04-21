import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

await mkdir('./dist', { recursive: true });
await build({
  entryPoints: ['./src/window.ts'],
  bundle: true,
  outfile: './dist/window.js',
  format: 'esm',
  target: ['chrome120'],
  sourcemap: 'inline',
  loader: { '.css': 'empty' }, // we copy xterm.css manually
  logLevel: 'info',
});
await copyFile('./src/window.html', './dist/window.html');
await copyFile('./src/styles.css', './dist/window.css');
await copyFile(require.resolve('xterm/css/xterm.css'), './dist/xterm.css');
console.log('shell: build complete');
