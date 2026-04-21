#!/usr/bin/env node
/**
 * /visual-companion [url] entry point
 *
 * In a project directory, `/visual-companion` with NO arguments should
 * just work: start the dev server (if not running), learn its URL, open
 * the window. Explicit URL arg bypasses all auto-detection.
 *
 * Pipeline:
 *  1. First-run bootstrap: npm install / build if needed
 *  2. Resolve URL:
 *     a) CLI arg or config default → use directly, probe port, start dev if needed
 *     b) No hint → must have a dev command. Start dev server, parse its
 *        stdout/stderr for a localhost URL ("http://localhost:NNNN").
 *  3. Spawn companion daemon, wait for "READY port=XXXX"
 *  4. Launch Chrome in app-mode with isolated profile, passing the
 *     upstream URL so the shell can show it in the URL bar (not /app/).
 *  5. Exit (daemon keeps running, self-shutdown via 60s watchdog)
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

  // 1. First-run bootstrap
  if (!fs.existsSync(nodeModulesDir)) {
    console.log('visual-companion: first run — installing dependencies (this takes ~1 minute)...');
    const install = spawnSync('npm', ['install'], { cwd: pluginRoot, stdio: 'inherit' });
    if (install.status !== 0) {
      console.error('visual-companion: npm install failed (exit code', install.status, ')');
      process.exit(1);
    }
  }
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

  // node-pty 1.x ships its darwin/linux `spawn-helper` without the exec bit in
  // some install paths (plugin cache, repos synced via tools that strip modes).
  // Without +x, posix_spawnp fails for every child — including claude itself.
  ensureSpawnHelperExecutable(nodeModulesDir);

  // 2. Resolve URL
  let explicitUrl = argv.find((a) => !a.startsWith('--'));
  let hintedUrl = explicitUrl || autoDetectUrl(cwd); // best-effort guess
  const devCommand = detectDevCommand(cwd);
  let url = null;
  let devServerPid = null;

  if (hintedUrl) {
    // We think we know the URL. Probe it.
    const { hostname, portNum } = parseHostPort(hintedUrl);
    const reachable = await checkPortReachable(hostname, portNum, 500);
    if (reachable) {
      url = hintedUrl;
      console.log('visual-companion: using', url, '(already running)');
    } else if (!isLocalhost(hostname)) {
      console.error('visual-companion: target URL', hintedUrl, 'is not reachable (not localhost — not starting a dev server).');
      process.exit(1);
    } else if (devCommand) {
      // Expected URL not reachable, start dev server and wait for that port
      console.log(`visual-companion: starting dev server (${devCommand.display}), expecting ${hintedUrl} ...`);
      const { pid } = startDevServer(cwd, devCommand);
      devServerPid = pid;
      const ready = await waitForPortOrStdoutUrl(hostname, portNum, DEV_STDOUT_BUFFER, 45_000);
      if (!ready.ok) {
        console.error(`visual-companion: dev server started but ${hostname}:${portNum} still not reachable after 45s.`);
        console.error('  check the [dev] output above for errors, or run the dev server manually and retry.');
        try { process.kill(devServerPid, 'SIGTERM'); } catch {}
        process.exit(1);
      }
      url = ready.url || hintedUrl;
      console.log('visual-companion: dev server ready on', url);
    } else {
      console.error('visual-companion:', hostname + ':' + portNum, 'is not reachable and no dev command found.');
      console.error('  start your dev server manually, or add a `"dev"` script to package.json, or use .visual-companion.json.');
      process.exit(1);
    }
  } else if (devCommand) {
    // No URL hint at all, but we have a dev command. Start it and parse its output.
    console.log(`visual-companion: no URL hint — starting dev server (${devCommand.display}) and detecting URL from its output ...`);
    const { pid } = startDevServer(cwd, devCommand);
    devServerPid = pid;
    const detected = await detectUrlFromStdout(DEV_STDOUT_BUFFER, 45_000);
    if (!detected) {
      console.error('visual-companion: dev server started but did not print a detectable localhost URL within 45s.');
      console.error('  add `"default_url": "http://localhost:XXXX"` to .visual-companion.json to skip auto-detection.');
      try { process.kill(devServerPid, 'SIGTERM'); } catch {}
      process.exit(1);
    }
    url = detected;
    console.log('visual-companion: dev server ready on', url);
  } else {
    console.error('visual-companion: no URL given, no .visual-companion.json, and no package.json scripts.dev — cannot proceed.');
    console.error('  usage:');
    console.error('    /visual-companion                      # in a project with scripts.dev');
    console.error('    /visual-companion http://host:port     # explicit URL');
    console.error('    /visual-companion                      # with .visual-companion.json { "default_url": "...", "start_command": "..." }');
    process.exit(1);
  }

  // 3. Spawn companion daemon
  const serverEnv = {
    ...process.env,
    VISUAL_COMPANION_PORT: '0',
    VISUAL_COMPANION_TARGET_URL: url,
    VISUAL_COMPANION_CWD: cwd,
    VISUAL_COMPANION_SHELL_DIR: shellDir,
    VISUAL_COMPANION_INJECT_FILE: injectFile,
  };
  if (devServerPid) serverEnv.VISUAL_COMPANION_DEV_PID = String(devServerPid);

  // Redirect daemon stdout/stderr to a log file so we can diagnose issues
  // after launch.js detaches. Log path is exposed via the daemon's /health.
  const logPath = `/tmp/visual-companion-${process.pid}.log`;
  const logFd = fs.openSync(logPath, 'a');
  // stdin ignored, stdout piped (so we can read READY), stderr to log
  const server = spawn(process.execPath, [serverEntry], {
    detached: true,
    stdio: ['ignore', 'pipe', logFd],
    env: { ...serverEnv, VISUAL_COMPANION_LOG_PATH: logPath },
  });
  console.log(`visual-companion: daemon log → ${logPath}`);

  let bufferedOut = '';
  server.stdout.on('data', (chunk) => {
    bufferedOut += chunk.toString();
    const m = bufferedOut.match(/READY port=(\d+)/);
    if (m) {
      const port = m[1];
      launchChrome(port, server.pid, url);
      // Redirect future stdout to the log file so the daemon never blocks
      // on a full pipe and we retain post-READY diagnostics.
      server.stdout.removeAllListeners('data');
      try {
        server.stdout.pipe(fs.createWriteStream(logPath, { flags: 'a' }));
      } catch {}
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

/** Shared buffer for dev-server stdout/stderr text, scanned for URLs. */
const DEV_STDOUT_BUFFER = { text: '' };

function launchChrome(port, serverPid, upstreamUrl) {
  const profileDir = `/tmp/visual-companion-${serverPid}`;
  const qs = new URLSearchParams({ target: '/app/', upstream: upstreamUrl });
  const appUrl = `http://localhost:${port}/window/?${qs.toString()}`;
  const chrome = spawn('open', [
    '-na', 'Google Chrome',
    '--args',
    `--app=${appUrl}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ], { detached: true, stdio: 'ignore' });
  chrome.unref();
  console.log(`visual-companion: opening ${upstreamUrl} (daemon port ${port})`);
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
      if (/\bnext\b/.test(dev)) return 'http://localhost:3000';
      if (/\bvite\b/.test(dev)) return 'http://localhost:5173';
      if (/\bastro\b/.test(dev)) return 'http://localhost:4321';
      if (/\bnuxt\b/.test(dev)) return 'http://localhost:3000';
    } catch {}
  }
  return null;
}

function parseHostPort(rawUrl) {
  const u = new URL(rawUrl);
  return {
    hostname: u.hostname,
    portNum: u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80),
  };
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
        if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return { cmd: 'pnpm', args: ['dev'], display: 'pnpm dev' };
        if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return { cmd: 'yarn', args: ['dev'], display: 'yarn dev' };
        if (fs.existsSync(path.join(cwd, 'bun.lockb'))) return { cmd: 'bun', args: ['run', 'dev'], display: 'bun run dev' };
        return { cmd: 'npm', args: ['run', 'dev'], display: 'npm run dev' };
      }
    } catch {}
  }
  return null;
}

/**
 * Spawn the dev server detached; tap its stdout+stderr into DEV_STDOUT_BUFFER
 * for URL detection, and forward it with "[dev]" prefix so the user sees
 * startup progress. Returns { pid }.
 */
function startDevServer(cwd, devCommand) {
  const devServer = spawn(devCommand.cmd, devCommand.args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
    env: process.env,
  });
  const tap = (stream, writer) => {
    stream?.on('data', (chunk) => {
      const str = chunk.toString();
      DEV_STDOUT_BUFFER.text += str;
      // Cap buffer to last 32kb to avoid unbounded growth.
      if (DEV_STDOUT_BUFFER.text.length > 32768) {
        DEV_STDOUT_BUFFER.text = DEV_STDOUT_BUFFER.text.slice(-32768);
      }
      writer.write('[dev] ' + str);
    });
  };
  tap(devServer.stdout, process.stdout);
  tap(devServer.stderr, process.stderr);
  devServer.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error('visual-companion: dev server exited early, code=', code);
    }
  });
  devServer.unref();
  return { pid: devServer.pid };
}

/**
 * Ensure node-pty's `spawn-helper` prebuilt binary has the exec bit set.
 * Silently skipped on Windows or if the file is missing.
 */
function ensureSpawnHelperExecutable(nodeModulesRoot) {
  const candidates = [
    path.join(nodeModulesRoot, 'node-pty/prebuilds/darwin-arm64/spawn-helper'),
    path.join(nodeModulesRoot, 'node-pty/prebuilds/darwin-x64/spawn-helper'),
    path.join(nodeModulesRoot, 'node-pty/build/Release/spawn-helper'),
  ];
  for (const p of candidates) {
    try {
      const st = fs.statSync(p);
      if (!(st.mode & 0o111)) {
        fs.chmodSync(p, st.mode | 0o755);
      }
    } catch {
      // missing or not our platform — skip
    }
  }
}

/**
 * Extract the first `http(s)://host:port` URL from a buffer, stripping ANSI
 * escape codes first. Returns null if none found.
 */
function extractLocalhostUrl(text) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, ''); // strip ANSI color codes
  const m = clean.match(/(https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d+))?(?:\/[^\s'"`<>]*)?)/);
  if (!m) return null;
  return m[1].replace(/\/+$/, ''); // trim trailing slash(es)
}

/** Poll the dev-server stdout buffer until a URL appears or timeout. */
async function detectUrlFromStdout(buffer, totalMs) {
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    const url = extractLocalhostUrl(buffer.text);
    if (url) {
      // Also probe the port to confirm the server is actually accepting connections
      try {
        const { hostname, portNum } = parseHostPort(url);
        if (await checkPortReachable(hostname, portNum, 500)) {
          return `http://${hostname}:${portNum}`;
        }
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/**
 * Wait for EITHER the expected port to be reachable OR the dev server to
 * print a URL (which wins if it's different from the expected port — common
 * when the default port is already taken and a framework falls back to +1).
 */
async function waitForPortOrStdoutUrl(host, port, buffer, totalMs) {
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    if (await checkPortReachable(host, port, 500)) return { ok: true, url: `http://${host}:${port}` };
    const urlFromStdout = extractLocalhostUrl(buffer.text);
    if (urlFromStdout) {
      try {
        const { hostname, portNum } = parseHostPort(urlFromStdout);
        if (await checkPortReachable(hostname, portNum, 500)) {
          return { ok: true, url: `http://${hostname}:${portNum}` };
        }
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { ok: false };
}
