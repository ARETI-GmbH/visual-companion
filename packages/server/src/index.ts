import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { readFileSync, mkdirSync, rmSync, watch as fsWatch } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { getConfigFromEnv } from './config.js';
import { registerProxy } from './proxy.js';
import { registerCompanionWebSocket } from './websocket.js';
import { EventStore } from './event-store.js';
import { ScreenshotCache } from './screenshot-cache.js';
import { registerPtyBridge } from './pty-bridge.js';
import { registerMcpHandlers } from './mcp-handlers.js';

async function main(): Promise<void> {
  const cfg = getConfigFromEnv();
  const app = Fastify({ logger: { level: 'error' } });

  // After launch.js detaches, our parent's stdout pipe is closed. Any
  // subsequent stdout write would throw EPIPE — swallow it so the daemon
  // keeps running silently for the window's lifetime.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return;
    throw err;
  });
  process.stderr.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') return;
    throw err;
  });
  await app.register(fastifyWebsocket);

  if (cfg.shellDir) {
    await app.register(fastifyStatic, {
      root: cfg.shellDir,
      prefix: '/window/',
      index: ['window.html'],
      setHeaders: (res) => {
        // Shell bundle changes when we release — never let Chrome cache it.
        res.setHeader('cache-control', 'no-store, must-revalidate');
      },
    });
  }

  const store = new EventStore({ maxEvents: 5000, maxAgeMs: 5 * 60 * 1000 });
  const screenshots = new ScreenshotCache(100);
  let gatewayRef: { broadcast(msg: any): void } | null = null;
  let ptyBridgeRef: { injectInput(text: string): void } | null = null;
  const gateway = registerCompanionWebSocket(app, {
    store,
    onEvent: (ev) => {
      if (ev.type !== 'pointer') return;
      const p = ev.payload as {
        cssSelector: string;
        boundingBox: { width: number; height: number };
        textContent: string;
      };
      let pathname = '';
      try { pathname = new URL(ev.url).pathname; } catch {}
      const preview = p.textContent
        ? p.textContent.replace(/\s+/g, ' ').slice(0, 80).trim()
        : '';
      // 1) Show the sidebar badge so the user gets visual feedback.
      gatewayRef?.broadcast({
        type: 'selection-update',
        selector: p.cssSelector,
        url: ev.url,
        pathname,
        width: Math.round(p.boundingBox.width),
        height: Math.round(p.boundingBox.height),
        text: preview,
      });

      // 2) Queue the selection context as a hidden prefix for claude's
      //    next prompt. The prompt line stays clean for the user — the
      //    pty bridge rewrites the line at Enter time so claude sees
      //    "[markiert: …] <user's question>" as a single message.
      //
      //    We include an inline MCP hint. Server-level instructions
      //    already tell claude to call get_pointed_element on
      //    [markiert], but some sessions don't pick those up on the
      //    first initialize — the inline nudge is a defensive
      //    second layer so the flow works regardless.
      const selector = p.cssSelector;
      const path = pathname || '/';
      const snippet = preview
        ? `[markiert: ${selector} · ${path} · "${preview}" — bitte zuerst MCP get_pointed_element aufrufen] `
        : `[markiert: ${selector} · ${path} — bitte zuerst MCP get_pointed_element aufrufen] `;
      ptyBridgeRef?.setPendingPrefix(snippet);
    },
  });
  gatewayRef = gateway;

  if (cfg.injectFile) {
    app.get('/_companion/inject.js', async (_req, reply) => {
      reply.type('application/javascript');
      return readFileSync(cfg.injectFile);
    });
  }

  const injectTag = `<script src="/_companion/inject.js" data-companion-port="${cfg.port}"></script>`;
  await registerProxy(app, { targetOrigin: cfg.targetUrl, injectScriptTag: injectTag });

  // NB: we used to redirect `/` to `/window/`, but the proxy now owns `/`
  // (so the upstream homepage renders on the proxy origin). The companion
  // shell is addressed explicitly via /window/.
  app.get('/_companion/health', async () => ({ ok: true, events: store.size() }));

  // Used by the shell's selection badge "send to claude" button. POSTs
  // a plain-text snippet which we type into claude's prompt line as
  // if the user had typed it. Claude's LLM then sees the context and
  // can run get_pointed_element for full detail.
  app.post('/_companion/pty/inject', async (req, reply) => {
    const body = (req.body ?? {}) as { text?: unknown };
    if (typeof body.text !== 'string' || body.text.length === 0) {
      reply.status(400);
      return { ok: false, error: 'text must be a non-empty string' };
    }
    if (body.text.length > 2000) {
      reply.status(400);
      return { ok: false, error: 'text too long (max 2000)' };
    }
    ptyBridgeRef?.injectInput(body.text);
    return { ok: true };
  });

  // Register PTY bridge route before listen (Fastify v4 forbids adding
  // routes after the server is listening). companionPort is resolved
  // lazily at spawn time so we can pass the actual listening port.
  let resolvedPort = cfg.port;
  const pty = registerPtyBridge(app, {
    cwd: cfg.cwd,
    companionPort: () => resolvedPort,
    claudeArgs: cfg.claudeArgs,
  });
  ptyBridgeRef = pty;

  registerMcpHandlers(app, { store, gateway, pty });

  // Profile dir for potential cleanup later
  const profileDir = `/tmp/visual-companion-${process.pid}`;
  try { mkdirSync(profileDir, { recursive: true }); } catch {}

  // Auto-reload: watch the project directory and hard-refresh the
  // iframe when the user (or claude) edits source files. Debounced so
  // a burst of saves produces exactly one reload after things quiet
  // down. inject.js already handles { type: 'reload' } by calling
  // window.location.reload() on the iframe's own origin.
  const stopFileWatcher = startFileWatcher(cfg.cwd, () => {
    gateway.broadcast({ type: 'reload' });
  });

  // Shutdown watchdog: exit when client count stayed at 0 for 60s after initial connect
  let hadConnectionOnce = false;
  let gapStartMs: number | null = null;
  const IDLE_GRACE_MS = 60_000;
  const MAX_RUNTIME_MS = 8 * 3600 * 1000;
  const startedAt = Date.now();

  const watchdog = setInterval(async () => {
    if (Date.now() - startedAt > MAX_RUNTIME_MS) {
      console.log('visual-companion: 8h runtime limit reached, shutting down');
      return shutdown();
    }
    const connected = gateway.connectionCount() > 0;
    if (connected) {
      hadConnectionOnce = true;
      gapStartMs = null;
      return;
    }
    if (!hadConnectionOnce) return;
    if (gapStartMs === null) gapStartMs = Date.now();
    if (Date.now() - gapStartMs > IDLE_GRACE_MS) {
      console.log('visual-companion: no clients for 60s, shutting down');
      return shutdown();
    }
  }, 5000);

  async function shutdown(): Promise<void> {
    clearInterval(watchdog);
    try { stopFileWatcher(); } catch {}
    try { await app.close(); } catch {}
    try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
    // Clean our own state file so stop.js's per-session listing
    // stays accurate.
    try { rmSync(`/tmp/visual-companion-state-${process.pid}.json`, { force: true }); } catch {}
    // Reverse transform: if this daemon was started as a carry-over
    // (the user's outer claude was replaced by the companion window),
    // now that the window is going away we re-open a terminal at the
    // same cwd and resume the conversation — so they end up exactly
    // where they started, with all the intermediate work preserved.
    const returnApp = process.env.VISUAL_COMPANION_RETURN_APP;
    const returnCwd = process.env.VISUAL_COMPANION_RETURN_CWD;
    if (returnApp && returnCwd) {
      spawnReturnTerminal(returnApp, returnCwd);
    }
    // Kill dev-server child that launch.js spawned, if any
    const devPidRaw = process.env.VISUAL_COMPANION_DEV_PID;
    if (devPidRaw) {
      const devPid = parseInt(devPidRaw, 10);
      if (devPid > 0) {
        try { process.kill(devPid, 'SIGTERM'); } catch {}
      }
    }
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const address = await app.listen({ port: cfg.port, host: '127.0.0.1' });
  resolvedPort = parseInt(new URL(address).port, 10);
  // CRITICAL: DO NOT CHANGE FORMAT — launch.js parses this exact line
  console.log(`READY port=${resolvedPort}`);

  // silence unused vars
  void screenshots;
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});

/**
 * Watch the project directory for file changes and fire `onQuiet` after
 * a 1500 ms debounce — one reload per burst of saves, not one per keystroke.
 * Returns a disposer that closes the underlying fs.watch handle.
 *
 * fs.watch(recursive) is supported on macOS + Windows; on Linux kernel
 * 4.9+ since Node 20 (our engines field pins >=20). Directories we never
 * want to reload on (node_modules, build output, version control) are
 * filtered by filename regex — cheaper and enough for our use.
 */
const IGNORE = /(^|[\/\\])(node_modules|\.git|\.next|\.nuxt|\.vite|\.turbo|\.cache|\.parcel-cache|\.svelte-kit|\.astro|\.remix|\.rollup\.cache|\.DS_Store|dist|build|out|coverage|tmp)([\/\\]|$)/;
const IGNORE_TAIL = /(\.swp|\.swx|~|\.tmp|\.log|\.lock|\.tsbuildinfo)$/;
// Even if the ignore list misses something, never broadcast reloads
// more frequently than this window — kills the "dev server writes
// cache → watcher fires → reload → dev server rebuilds → writes cache
// → reload" loop that crashed Vite's HMR in user reports.
const MIN_RELOAD_INTERVAL_MS = 5000;

/**
 * Open a new terminal window in `cwd` and start `claude --continue`.
 * Called during shutdown when the outer claude had been closed on launch;
 * this restores the user to an interactive claude session on the same
 * conversation state they were in before they opened the companion.
 */
function spawnReturnTerminal(app: string, cwd: string): void {
  if (process.platform !== 'darwin') return;
  // Tiny synchronous pause so the pty-claude has a moment to flush its
  // save to disk before the new --continue reads it.
  const waitUntil = Date.now() + 400;
  while (Date.now() < waitUntil) { /* intentional busy wait — <1 tick */ }

  const cmd = `cd ${JSON.stringify(cwd)} && claude --continue`;
  let script = '';
  if (app === 'Terminal') {
    script = `
      try
        tell application "Terminal"
          activate
          do script ${JSON.stringify(cmd)}
        end tell
      on error
      end try
    `;
  } else if (app === 'iTerm') {
    script = `
      try
        tell application "iTerm"
          activate
          create window with default profile
          tell current session of current window
            write text ${JSON.stringify(cmd)}
          end tell
        end tell
      on error
      end try
    `;
  } else {
    return;
  }
  const result = spawnSync('osascript', ['-e', script], {
    timeout: 4000,
    encoding: 'utf8',
  });
  process.stderr.write(
    `[vc] spawnReturnTerminal(${app}): status=${result.status} ` +
      `stderr=${(result.stderr || '').trim()}\n`,
  );
}

function startFileWatcher(cwd: string, onQuiet: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: ReturnType<typeof fsWatch> | null = null;
  let lastReloadAt = 0;
  try {
    watcher = fsWatch(cwd, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const name = String(filename);
      if (IGNORE.test(name) || IGNORE_TAIL.test(name)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const now = Date.now();
        if (now - lastReloadAt < MIN_RELOAD_INTERVAL_MS) {
          process.stderr.write(
            `[vc] auto-reload: suppressed (last reload ${now - lastReloadAt}ms ago, min ${MIN_RELOAD_INTERVAL_MS}ms) — ${name}\n`,
          );
          return;
        }
        lastReloadAt = now;
        process.stderr.write(`[vc] auto-reload: file change (${name}) — broadcasting reload\n`);
        try { onQuiet(); } catch {}
      }, 1500);
    });
    watcher.on('error', (err) => {
      process.stderr.write(`[vc] file watcher error: ${(err as Error).message}\n`);
    });
  } catch (err) {
    process.stderr.write(`[vc] could not watch ${cwd}: ${(err as Error).message}\n`);
  }
  return () => {
    if (timer) clearTimeout(timer);
    try { watcher?.close(); } catch {}
  };
}
