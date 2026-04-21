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

const { spawn, spawnSync, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

const argv = process.argv.slice(2);
const pluginRoot = path.resolve(__dirname, '..');
const serverEntry = path.join(pluginRoot, 'packages/server/dist/index.js');
const shellDir = path.join(pluginRoot, 'packages/shell/dist');
const injectFile = path.join(pluginRoot, 'packages/inject/dist/inject.js');
const nodeModulesDir = path.join(pluginRoot, 'node_modules');

/** Shared buffer for dev-server stdout/stderr text, scanned for URLs.
 *  Declared at module scope BEFORE the main IIFE so the async body can
 *  safely reference it without hitting TDZ. */
const DEV_STDOUT_BUFFER = { text: '' };

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

  // 2. Parse flags + resolve URL
  const claudeArgs = [];
  if (argv.some((a) => a === '--dsp' || a === '--dangerously-skip-permissions')) {
    claudeArgs.push('--dangerously-skip-permissions');
    console.log('visual-companion: claude will run with --dangerously-skip-permissions');
  }

  // Default: take over the user's current claude conversation. Skipped
  // only when the user explicitly asks for a fresh session.
  const wantsFresh = argv.includes('--new') || argv.includes('--fresh');
  const resumeIdx = argv.findIndex((a) => a === '-r' || a === '--resume');
  const wantsResume = resumeIdx >= 0;
  if (wantsResume) {
    const id = argv[resumeIdx + 1];
    if (!id || id.startsWith('-')) {
      console.error(
        'visual-companion: --resume needs a session id, e.g. /visual-companion --resume abc123.',
      );
      process.exit(1);
    }
    claudeArgs.push('--resume', id);
    console.log(`visual-companion: resuming session ${id}.`);
  } else if (!wantsFresh) {
    claudeArgs.push('--continue');
    console.log(
      'visual-companion: continuing your current conversation (--continue). Use --new for a fresh session.',
    );
  } else {
    console.log('visual-companion: starting a fresh claude session (--new).');
  }
  const shouldCloseOuterClaude = !wantsFresh;

  // Strip flag arguments from positional URL detection.
  const positional = argv.filter((a, i) => {
    if (a.startsWith('-')) return false;
    if (i > 0 && (argv[i - 1] === '-r' || argv[i - 1] === '--resume')) return false;
    return true;
  });
  let explicitUrl = positional[0];
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
  if (claudeArgs.length) serverEnv.VISUAL_COMPANION_CLAUDE_ARGS = claudeArgs.join(' ');

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
      setTimeout(() => {
        // Close the outer claude so the user doesn't end up with two
        // windows running against the same session. Default behavior
        // unless /visual-companion --new was used.
        //
        // We also try to close the exact terminal tab/window the user
        // launched us from — matched by TTY so we never touch the
        // wrong one. If the user's terminal app isn't scriptable
        // (Terminal.app and iTerm2 are), the SIGTERM still lands and
        // the window drops back to a shell prompt for manual Cmd+W.
        if (shouldCloseOuterClaude) {
          const outerPid = findOuterClaudePid();
          const ownTty = findOwnTty();
          const termApp = ownTty ? findTerminalAppForTty(ownTty) : null;
          if (outerPid) {
            console.log(
              `visual-companion: closing outer claude (pid ${outerPid})${termApp ? ` + ${termApp} tab ${ownTty}` : ''}.`,
            );
            try { process.kill(outerPid, 'SIGTERM'); } catch {}
          }
          // Small delay so claude exits cleanly and leaves just the
          // shell in the tab — then the terminal app won't prompt
          // "running processes" when we close the window.
          if (termApp) {
            setTimeout(() => {
              try { closeTerminalTabByTty(ownTty, termApp); } catch {}
              process.exit(0);
            }, 300);
            return;
          }
        }
        process.exit(0);
      }, 300);
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

/**
 * Find the PID of the claude process that launched us (via a slash-command
 * → bash subshell → node launch.js chain). Walks up the process tree until
 * we find a binary called `claude`; returns 0 if nothing matching is found.
 */
/**
 * Find the TTY path of the terminal tab that launched us
 * (e.g. "/dev/ttys003"). Used to target exactly that tab for close.
 * Returns null if we can't determine it (non-macOS, detached shells, …).
 */
function findOwnTty() {
  try {
    // launch.js's parent is bash (the slash-command subshell). Its tty
    // is the terminal tab's tty.
    const bashPid = process.ppid;
    const tty = execSync(`ps -o tty= -p ${bashPid}`, {
      encoding: 'utf8',
      timeout: 1500,
    }).trim();
    if (!tty || tty === '??' || tty === '?') return null;
    return '/dev/' + tty;
  } catch {
    return null;
  }
}

/**
 * Which terminal app owns the tab with this tty? Returns 'Terminal',
 * 'iTerm', or null. We probe Terminal.app and iTerm2 — other apps
 * (Warp, Ghostty, kitty, Alacritty, …) aren't AppleScript-controllable
 * this way, so we give up silently and fall back to "user Cmd+W".
 */
function findTerminalAppForTty(tty) {
  if (process.platform !== 'darwin') return null;
  const terminalAppProbe = `
    tell application "System Events"
      if not ((name of processes) contains "Terminal") then return ""
    end tell
    tell application "Terminal"
      repeat with w in windows
        repeat with t in tabs of w
          if tty of t is "${tty}" then return "Terminal"
        end repeat
      end repeat
    end tell
    return ""
  `;
  const iTermProbe = `
    tell application "System Events"
      if not ((name of processes) contains "iTerm2") then return ""
    end tell
    tell application "iTerm"
      repeat with w in windows
        repeat with tb in tabs of w
          tell current session of tb
            if tty is "${tty}" then return "iTerm"
          end tell
        end repeat
      end repeat
    end tell
    return ""
  `;
  for (const script of [terminalAppProbe, iTermProbe]) {
    try {
      const out = execSync(`osascript -e ${JSON.stringify(script)}`, {
        timeout: 2000,
        encoding: 'utf8',
      }).trim();
      if (out === 'Terminal' || out === 'iTerm') return out;
    } catch {
      // app not running or not scriptable
    }
  }
  return null;
}

/**
 * Close the tab/window identified by (tty, app). Only touches that one
 * window — every other window of every other app stays untouched.
 */
function closeTerminalTabByTty(tty, app) {
  if (process.platform !== 'darwin') return;
  let script = '';
  if (app === 'Terminal') {
    script = `
      tell application "Terminal"
        repeat with w in windows
          repeat with t in tabs of w
            if tty of t is "${tty}" then
              close w saving no
              return
            end if
          end repeat
        end repeat
      end tell
    `;
  } else if (app === 'iTerm') {
    script = `
      tell application "iTerm"
        repeat with w in windows
          repeat with tb in tabs of w
            tell current session of tb
              if tty is "${tty}" then
                close w
                return
              end if
            end tell
          end repeat
        end repeat
      end tell
    `;
  } else {
    return;
  }
  try {
    execSync(`osascript -e ${JSON.stringify(script)}`, {
      timeout: 2500,
      stdio: 'ignore',
    });
  } catch {
    // best-effort
  }
}

function findOuterClaudePid() {
  try {
    // process.ppid is the bash subshell. Walk up twice to be robust to
    // extra wrappers (sh, script, tee, …).
    let pid = process.ppid;
    for (let hop = 0; hop < 4; hop++) {
      const parent = parseInt(
        execSync(`ps -o ppid= -p ${pid}`, { encoding: 'utf8', timeout: 2000 }).trim(),
        10,
      );
      if (!parent || parent === 1 || parent === pid) break;
      const name = execSync(`ps -o command= -p ${parent}`, { encoding: 'utf8', timeout: 2000 }).trim();
      if (/(^|\/)claude(\s|$)/.test(name)) return parent;
      pid = parent;
    }
  } catch {}
  return 0;
}

function launchChrome(port, serverPid, upstreamUrl) {
  const profileDir = `/tmp/visual-companion-${serverPid}`;
  const qs = new URLSearchParams({ target: '/', upstream: upstreamUrl });
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
  // Only return an explicit hint — framework defaults (3000, 5173 …) are
  // unreliable because Next/Vite fall back to +1 when the port is busy, or
  // the same port is already held by an unrelated dev server. Without an
  // explicit hint we'd rather start the dev server and read the real URL
  // from its stdout.
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
 * Spawn the dev server detached, writing its stdout+stderr into a log file.
 *
 * CRITICAL: we must NOT use `stdio: ['ignore', 'pipe', 'pipe']` here. The
 * pipes are bound to launch.js's process; when launch.js exits (200ms after
 * daemon is ready), the pipes close, and the next Next.js / Vite log write
 * raises EPIPE → the dev server crashes. That left the user with a daemon
 * proxying to a port that no longer answers.
 *
 * Using a file descriptor from fs.openSync gives the child its own dup'd
 * fd that survives launch.js's exit. The file also doubles as a durable
 * log (`/tmp/visual-companion-dev-<pid>.log`) the user can tail for
 * Turbopack errors after detach.
 *
 * URL detection switches from stream tapping to file polling, feeding the
 * same DEV_STDOUT_BUFFER shape everyone else already reads.
 */
function startDevServer(cwd, devCommand) {
  const devLogPath = `/tmp/visual-companion-dev-${process.pid}.log`;
  try { fs.writeFileSync(devLogPath, ''); } catch {}
  const devLogFd = fs.openSync(devLogPath, 'a');
  const devServer = spawn(devCommand.cmd, devCommand.args, {
    detached: true,
    stdio: ['ignore', devLogFd, devLogFd],
    cwd,
    env: process.env,
  });
  fs.closeSync(devLogFd); // child holds its own dup; we don't need ours

  // Tail the log file into the shared buffer so URL detection sees updates
  // and the user sees `[dev] …` lines in launch.js's stdout until detach.
  let lastSize = 0;
  const tail = setInterval(() => {
    try {
      const st = fs.statSync(devLogPath);
      if (st.size <= lastSize) return;
      const fh = fs.openSync(devLogPath, 'r');
      const buf = Buffer.alloc(st.size - lastSize);
      fs.readSync(fh, buf, 0, buf.length, lastSize);
      fs.closeSync(fh);
      lastSize = st.size;
      const chunk = buf.toString('utf8');
      DEV_STDOUT_BUFFER.text += chunk;
      if (DEV_STDOUT_BUFFER.text.length > 32768) {
        DEV_STDOUT_BUFFER.text = DEV_STDOUT_BUFFER.text.slice(-32768);
      }
      process.stdout.write(chunk.replace(/^/gm, '[dev] '));
    } catch {}
  }, 200);
  // When launch.js exits via process.exit(), intervals die with it — no
  // need for an explicit clear. Keep the ref so the tick survives GC.
  void tail;

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
