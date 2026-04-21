import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { getConfigFromEnv } from './config.js';
import { registerProxy } from './proxy.js';
import { registerCompanionWebSocket } from './websocket.js';
import { EventStore } from './event-store.js';
import { ScreenshotCache } from './screenshot-cache.js';
import { registerPtyBridge } from './pty-bridge.js';
import { registerMcpHandlers } from './mcp-handlers.js';
async function main() {
    const cfg = getConfigFromEnv();
    const app = Fastify({ logger: { level: 'error' } });
    // After launch.js detaches, our parent's stdout pipe is closed. Any
    // subsequent stdout write would throw EPIPE — swallow it so the daemon
    // keeps running silently for the window's lifetime.
    process.stdout.on('error', (err) => {
        if (err.code === 'EPIPE')
            return;
        throw err;
    });
    process.stderr.on('error', (err) => {
        if (err.code === 'EPIPE')
            return;
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
    let gatewayRef = null;
    let ptyBridgeRef = null;
    const gateway = registerCompanionWebSocket(app, {
        store,
        onEvent: (ev) => {
            if (ev.type !== 'pointer')
                return;
            const p = ev.payload;
            let pathname = '';
            try {
                pathname = new URL(ev.url).pathname;
            }
            catch { }
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
            // 2) Auto-inject a short context prefix straight into claude's
            //    prompt line. Then the user just types their question and hits
            //    Enter — claude's next turn receives the selection inline as
            //    part of the user message, so it understands exactly what
            //    "hier", "das hier", or "dieses Element" refers to, without
            //    needing the user to phrase the question carefully.
            const snippet = preview
                ? `[markiert: ${p.cssSelector} · ${pathname || '/'} · "${preview}"] `
                : `[markiert: ${p.cssSelector} · ${pathname || '/'}] `;
            ptyBridgeRef?.injectInput(snippet);
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
        const body = (req.body ?? {});
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
    try {
        mkdirSync(profileDir, { recursive: true });
    }
    catch { }
    // Shutdown watchdog: exit when client count stayed at 0 for 60s after initial connect
    let hadConnectionOnce = false;
    let gapStartMs = null;
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
        if (!hadConnectionOnce)
            return;
        if (gapStartMs === null)
            gapStartMs = Date.now();
        if (Date.now() - gapStartMs > IDLE_GRACE_MS) {
            console.log('visual-companion: no clients for 60s, shutting down');
            return shutdown();
        }
    }, 5000);
    async function shutdown() {
        clearInterval(watchdog);
        try {
            await app.close();
        }
        catch { }
        try {
            rmSync(profileDir, { recursive: true, force: true });
        }
        catch { }
        // Kill dev-server child that launch.js spawned, if any
        const devPidRaw = process.env.VISUAL_COMPANION_DEV_PID;
        if (devPidRaw) {
            const devPid = parseInt(devPidRaw, 10);
            if (devPid > 0) {
                try {
                    process.kill(devPid, 'SIGTERM');
                }
                catch { }
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
//# sourceMappingURL=index.js.map