#!/usr/bin/env node
/**
 * /visual-companion [url] entry point
 * 1. starts the companion server as detached child
 * 2. waits for "READY port=XXXX" on stdout
 * 3. launches Chrome in app-mode with isolated profile
 * 4. exits (server keeps running, self-shutdown via watchdog)
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const argv = process.argv.slice(2);
let url = argv.find((a) => !a.startsWith('--'));
const cwd = process.cwd();

// URL auto-detection
if (!url) url = autoDetectUrl(cwd);
if (!url) {
  console.error('visual-companion: no URL provided and auto-detection failed.');
  console.error('  usage: /visual-companion <url>');
  console.error('  hint: create .visual-companion.json with { "default_url": "http://localhost:3000" }');
  process.exit(1);
}

const pluginRoot = path.resolve(__dirname, '..');
const serverEntry = path.join(pluginRoot, 'packages/server/dist/index.js');
const shellDir = path.join(pluginRoot, 'packages/shell/dist');
const injectFile = path.join(pluginRoot, 'packages/inject/dist/inject.js');

for (const f of [serverEntry, shellDir, injectFile]) {
  if (!fs.existsSync(f)) {
    console.error('visual-companion: missing build artifact:', f);
    console.error('  run `npm run build` in the plugin dir first.');
    process.exit(1);
  }
}

const server = spawn(process.execPath, [serverEntry], {
  detached: true,
  stdio: ['ignore', 'pipe', 'inherit'],
  env: {
    ...process.env,
    VISUAL_COMPANION_PORT: '0',
    VISUAL_COMPANION_TARGET_URL: url,
    VISUAL_COMPANION_CWD: cwd,
    VISUAL_COMPANION_SHELL_DIR: shellDir,
    VISUAL_COMPANION_INJECT_FILE: injectFile,
  },
});

let bufferedOut = '';
server.stdout.on('data', (chunk) => {
  bufferedOut += chunk.toString();
  const m = bufferedOut.match(/READY port=(\d+)/);
  if (m) {
    const port = m[1];
    launchChrome(port, server.pid, url);
    server.stdout.removeAllListeners('data');
    server.unref();
    setTimeout(() => process.exit(0), 200);
  }
});

server.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.error('visual-companion server exited early, code=', code);
    process.exit(1);
  }
});

function launchChrome(port, serverPid, targetUrl) {
  const profileDir = `/tmp/visual-companion-${serverPid}`;
  const appUrl = `http://localhost:${port}/window/?target=${encodeURIComponent('/app/')}`;
  const chrome = spawn('open', [
    '-na', 'Google Chrome',
    '--args',
    `--app=${appUrl}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ], { detached: true, stdio: 'ignore' });
  chrome.unref();
  console.log(`visual-companion: opening ${targetUrl} on port ${port}`);
}

function autoDetectUrl(cwd) {
  const config = path.join(cwd, '.visual-companion.json');
  if (fs.existsSync(config)) {
    try {
      const j = JSON.parse(fs.readFileSync(config, 'utf8'));
      if (j.default_url) return j.default_url;
    } catch {}
  }
  const pkg = path.join(cwd, 'package.json');
  if (fs.existsSync(pkg)) {
    try {
      const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      const dev = j?.scripts?.dev || '';
      const m = dev.match(/--port[= ](\d+)/) || dev.match(/-p[= ](\d+)/) || dev.match(/PORT=(\d+)/);
      if (m) return `http://localhost:${m[1]}`;
    } catch {}
  }
  return null;
}
