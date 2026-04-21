#!/usr/bin/env node
/**
 * /visual-companion [url] entry point
 *
 * Pipeline:
 *  1. Resolve URL (CLI arg → .visual-companion.json → package.json scripts.dev)
 *  2. First-run bootstrap: npm install if node_modules missing
 *  3. Rebuild if dist/ artifacts missing
 *  4. Check if target URL is reachable; if not, auto-start dev server
 *  5. Spawn companion daemon, wait for "READY port=XXXX"
 *  6. Launch Chrome in app-mode with isolated profile
 *  7. Exit (daemon keeps running, self-shutdown via watchdog)
 */

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

const argv = process.argv.slice(2);
const pluginRoot = path.resolve(__dirname, '..');
const serverEntry = path.join(pluginRoot, 'packages/server/dist/index.js');
const shellDir = path.join(pluginRoot, 'packages/shell/dist');
const injectFile = path.join(pluginRoot, 'packages/inject/dist/inject.js');
const nodeModulesDir = path.join(pluginRoot, 'node_modules');

(async function main() {
  const cwd = process.cwd();

  // 1. Resolve URL
  let url = argv.find((a) => !a.startsWith('--'));
  let urlFromAutoDetect = false;
  if (!url) {
    url = autoDetectUrl(cwd);
    urlFromAutoDetect = true;
  }
  if (!url) {
    console.error('visual-companion: no URL provided and auto-detection failed.');
    console.error('  usage: /visual-companion <url>');
    console.error('  hint: create .visual-companion.json with { "default_url": "http://localhost:3000" }');
    console.error('        or ensure package.json scripts.dev contains --port N or -p N');
    process.exit(1);
  }

  // 2. First-run bootstrap
  if (!fs.existsSync(nodeModulesDir)) {
    console.log('visual-companion: first run — installing dependencies (this takes ~1 minute)...');
    const install = spawnSync('npm', ['install'], { cwd: pluginRoot, stdio: 'inherit' });
    if (install.status !== 0) {
      console.error('visual-companion: npm install failed (exit code', install.status, ')');
      process.exit(1);
    }
  }

  // 3. Rebuild if needed
  for (const f of [serverEntry, shellDir, injectFile]) {
    if (!fs.existsSync(f)) {
      console.log('visual-companion: missing build artifact, running npm run build...');
      const build = spawnSync('npm', ['run', 'build'], { cwd: pluginRoot, stdio: 'inherit' });
      if (build.status !== 0) {
        console.error('visual-companion: npm run build failed (exit code', build.status, ')');
        process.exit(1);
      }
      break;
    }
  }

  // 4. Port-reachability + dev-server autostart
  let devServerPid = null;
  const { hostname, portNum } = parseHostPort(url);
  const reachable = await checkPortReachable(hostname, portNum, 500);

  if (!reachable) {
    if (!isLocalhost(hostname)) {
      console.error('visual-companion: target URL', url, 'is not reachable and not localhost — not starting dev server.');
      process.exit(1);
    }
    const devCommand = detectDevCommand(cwd);
    if (!devCommand) {
      console.error('visual-companion:', hostname + ':' + portNum, 'not reachable and no dev command found in .visual-companion.json or package.json scripts.dev.');
      console.error('  options:');
      console.error('  1. start your dev server manually, then re-run /visual-companion');
      console.error('  2. add "start_command": "npm run dev" to .visual-companion.json');
      console.error('  3. ensure package.json has scripts.dev defined');
      process.exit(1);
    }
    console.log('visual-companion:', hostname + ':' + portNum, 'not reachable — starting dev server with:', devCommand.display);
    const devServer = spawn(devCommand.cmd, devCommand.args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      env: process.env,
    });
    devServerPid = devServer.pid;
    // forward dev-server output so user sees startup progress
    devServer.stdout?.on('data', (chunk) => process.stdout.write('[dev] ' + chunk.toString()));
    devServer.stderr?.on('data', (chunk) => process.stderr.write('[dev] ' + chunk.toString()));
    devServer.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error('visual-companion: dev server exited early, code=', code);
      }
    });

    const ready = await waitForPort(hostname, portNum, 30_000);
    if (!ready) {
      console.error('visual-companion: dev server started but', hostname + ':' + portNum, 'still not reachable after 30s.');
      try { process.kill(devServerPid, 'SIGTERM'); } catch {}
      process.exit(1);
    }
    console.log('visual-companion: dev server ready on', hostname + ':' + portNum);
    devServer.unref();
    devServer.stdout?.removeAllListeners('data');
    devServer.stderr?.removeAllListeners('data');
  } else if (urlFromAutoDetect) {
    console.log('visual-companion: using auto-detected URL', url, '(already running)');
  }

  // 5. Spawn companion daemon
  const serverEnv = {
    ...process.env,
    VISUAL_COMPANION_PORT: '0',
    VISUAL_COMPANION_TARGET_URL: url,
    VISUAL_COMPANION_CWD: cwd,
    VISUAL_COMPANION_SHELL_DIR: shellDir,
    VISUAL_COMPANION_INJECT_FILE: injectFile,
  };
  if (devServerPid) serverEnv.VISUAL_COMPANION_DEV_PID = String(devServerPid);

  const server = spawn(process.execPath, [serverEntry], {
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: serverEnv,
  });

  let bufferedOut = '';
  server.stdout.on('data', (chunk) => {
    bufferedOut += chunk.toString();
    const m = bufferedOut.match(/READY port=(\d+)/);
    if (m) {
      const port = m[1];
      launchChrome(port, server.pid, url);
      // Close the parent's end of the pipe so the daemon won't block on
      // future stdout writes. The daemon handles EPIPE gracefully.
      server.stdout.removeAllListeners('data');
      try { server.stdout.destroy(); } catch {}
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
})().catch((err) => {
  console.error('visual-companion: fatal', err);
  process.exit(1);
});

// --- helpers -------------------------------------------------------------

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
      // Framework defaults (best-effort)
      if (/\bnext\b/.test(dev)) return 'http://localhost:3000';
      if (/\bvite\b/.test(dev)) return 'http://localhost:5173';
      if (/\bastro\b/.test(dev)) return 'http://localhost:4321';
    } catch {}
  }
  return null;
}

function parseHostPort(rawUrl) {
  const u = new URL(rawUrl);
  const hostname = u.hostname;
  const portNum = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
  return { hostname, portNum };
}

function isLocalhost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function checkPortReachable(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

async function waitForPort(host, port, totalMs) {
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    if (await checkPortReachable(host, port, 500)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function detectDevCommand(cwd) {
  const config = path.join(cwd, '.visual-companion.json');
  if (fs.existsSync(config)) {
    try {
      const j = JSON.parse(fs.readFileSync(config, 'utf8'));
      if (j.start_command) {
        const parts = j.start_command.split(/\s+/);
        return { cmd: parts[0], args: parts.slice(1), display: j.start_command };
      }
    } catch {}
  }
  const pkg = path.join(cwd, 'package.json');
  if (fs.existsSync(pkg)) {
    try {
      const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      if (j?.scripts?.dev) {
        // Detect which package manager is in use
        if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return { cmd: 'pnpm', args: ['dev'], display: 'pnpm dev' };
        if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return { cmd: 'yarn', args: ['dev'], display: 'yarn dev' };
        if (fs.existsSync(path.join(cwd, 'bun.lockb'))) return { cmd: 'bun', args: ['run', 'dev'], display: 'bun run dev' };
        return { cmd: 'npm', args: ['run', 'dev'], display: 'npm run dev' };
      }
    } catch {}
  }
  return null;
}
