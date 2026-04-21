import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Agent, request as undiciRequest } from 'undici';
import net from 'node:net';
import { IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';

// Dual-stack dispatcher: many dev servers bind only IPv4 (127.0.0.1)
// while others bind only IPv6 (::1). Node's DNS for "localhost" on
// macOS commonly returns ::1 first, so a v4-only server would ECONN-
// REFUSE and a v6-only server would fail if we forced v4.
// autoSelectFamily races A/AAAA lookups and uses whichever connects
// first (RFC 8305 "Happy Eyeballs"). Available since Node 20.
const dualStackAgent = new Agent({
  connect: {
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 500,
  },
});

export interface ProxyOptions {
  targetOrigin: string; // e.g. "http://localhost:3000"
  injectScriptTag?: string; // will be inserted before </head>
}

const STRIPPED_RESPONSE_HEADERS = new Set([
  'x-frame-options',
  'content-length',
  'transfer-encoding',
]);

export async function registerProxy(app: FastifyInstance, opts: ProxyOptions): Promise<void> {
  const { targetOrigin } = opts;

  // Transparent catch-all proxy. Every request that isn't a companion-
  // specific route (/window/*, /_companion/*) is forwarded verbatim to
  // upstream. The browser sees the proxy origin as if it WERE upstream:
  // absolute asset paths like /_next/static/... resolve on the proxy
  // port and get forwarded through. No path rewriting, no /app/ prefix,
  // no surprises — that's what "debuggable like the real thing" means.
  app.all('/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const rawPath = (req.params as { '*': string })['*'] || '';
    // Hands off our own routes — specific route handlers get Fastify
    // priority, but the catch-all still sees these if they fall through.
    if (rawPath.startsWith('window/') || rawPath === 'window' ||
        rawPath.startsWith('_companion/') || rawPath === '_companion') {
      reply.callNotFound();
      return;
    }
    const upstreamUrl = new URL(rawPath, targetOrigin + '/');
    for (const [k, v] of Object.entries(req.query as Record<string, string>)) {
      upstreamUrl.searchParams.set(k, v);
    }
    const forwardHeaders = { ...(req.headers as Record<string, string>) };
    delete forwardHeaders.host;
    delete forwardHeaders['content-length'];
    // Tell upstream to keep the body uncompressed. undici.request does not
    // auto-decompress, so if we forward Accept-Encoding: gzip we'd read
    // gzip bytes as UTF-8 on the HTML-injection path and serve garbled
    // mojibake. The proxy is loopback — compression is pure overhead.
    delete forwardHeaders['accept-encoding'];

    let upstreamResp;
    try {
      upstreamResp = await undiciRequest(upstreamUrl.toString(), {
        method: req.method as any,
        headers: forwardHeaders,
        body: req.raw,
        // Dev-servers (Next.js Turbopack, Vite cold start) can take well over
        // a minute on the first request. Defaults would surface as a cryptic
        // UND_ERR_HEADERS_TIMEOUT 500 JSON in the iframe.
        headersTimeout: 10 * 60 * 1000,
        bodyTimeout: 10 * 60 * 1000,
        // Happy-Eyeballs-ish connect: try IPv6 and IPv4 in parallel,
        // use whichever answers first. Means "localhost" works whether
        // the dev server binds 127.0.0.1, ::1, or both.
        dispatcher: dualStackAgent,
      });
    } catch (err) {
      reply.status(502).type('text/html').send(upstreamErrorHtml(err, targetOrigin));
      return;
    }

    const ctype = upstreamResp.headers['content-type'];
    const isHtml = typeof ctype === 'string' && ctype.includes('text/html');

    for (const [key, value] of Object.entries(upstreamResp.headers)) {
      const lower = key.toLowerCase();
      if (STRIPPED_RESPONSE_HEADERS.has(lower)) continue;
      // Strip content-encoding on the HTML-injection path: we're about to
      // serve the decoded text, so leaving 'gzip' etc. on would make the
      // browser double-decode and fail.
      if (lower === 'content-encoding' && isHtml && opts.injectScriptTag) continue;
      if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only') {
        const filtered = stripFrameAncestors(Array.isArray(value) ? value.join(', ') : String(value));
        if (filtered) reply.header(key, filtered);
        continue;
      }
      if (lower === 'location') {
        // Strip the upstream origin so redirects stay on the proxy host;
        // otherwise a 302 would bounce the user to real :3000 and break
        // the iframe sandbox. Relative Location values pass through.
        const rewritten = rewriteLocation(
          Array.isArray(value) ? value.join(', ') : String(value),
          targetOrigin,
        );
        reply.header('location', rewritten);
        continue;
      }
      reply.header(key, value as string);
    }
    reply.status(upstreamResp.statusCode);

    if (isHtml && opts.injectScriptTag) {
      const body = await upstreamResp.body.text();
      const injected = injectScript(body, opts.injectScriptTag);
      reply.send(injected);
    } else {
      const buf = Buffer.from(await upstreamResp.body.arrayBuffer());
      reply.send(buf);
    }
  });

  app.addHook('onReady', async () => {
    attachWebSocketProxy(app.server, targetOrigin);
  });
}

type HttpUpgradeLike = {
  listeners: (evt: string) => Function[];
  removeAllListeners: (evt: string) => void;
  on: (evt: string, cb: (...args: any[]) => void) => void;
};

/**
 * Own the http server's 'upgrade' event entirely. Node's EventEmitter has
 * no stopPropagation, so when fastify-websocket ALSO has a listener both
 * fire on every upgrade — fastify destroys unknown paths' sockets while
 * we're still piping to them, producing "Invalid WebSocket frame" crashes.
 *
 * Fix: snapshot any pre-existing upgrade listeners (fastify-websocket's is
 * there because websocket.ts / pty-bridge.ts registered /_companion/* WS
 * routes), remove them, and attach a single router that dispatches:
 *   - /_companion/* → call the captured fastify-websocket handler(s)
 *   - anything else → raw-socket proxy to upstream
 *
 * Without this, Vite/webpack HMR WS attempts get a 404 from fastify,
 * Vite's client falls back to HTTP-polling /__vite_ping, sees 200
 * (because HTTP still works through the proxy), thinks "server came
 * back" and calls location.reload() — producing the infinite flicker
 * → gray-out loop the user saw in v0.3.12.
 */
export function attachWebSocketProxy(
  httpServer: HttpUpgradeLike,
  targetOrigin: string,
): void {
  const target = new URL(targetOrigin);
  const upstreamPort = parseInt(
    target.port || (target.protocol === 'https:' ? '443' : '80'),
    10,
  );
  const upstreamHost = target.hostname;

  const existing = httpServer.listeners('upgrade').slice();
  httpServer.removeAllListeners('upgrade');

  httpServer.on('upgrade', (req: IncomingMessage, clientSocket: Duplex, head: Buffer) => {
    const url = req.url ?? '';
    if (url.startsWith('/_companion/')) {
      for (const fn of existing) {
        try { (fn as any)(req, clientSocket, head); } catch { /* defensive */ }
      }
      return;
    }
    proxyUpgrade(req, clientSocket, head, upstreamHost, upstreamPort, target.host);
  });
}

function proxyUpgrade(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  upstreamHost: string,
  upstreamPort: number,
  upstreamHostHeader: string,
): void {
  // Dual-stack connect for upstream. Dev servers may bind IPv4-only
  // (127.0.0.1) or IPv6-only (::1); autoSelectFamily races both and
  // keeps the first one that answers.
  const upstream = net.connect({
    host: upstreamHost,
    port: upstreamPort,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 500,
  } as any);

  const cleanup = () => {
    try { upstream.destroy(); } catch {}
    try { (clientSocket as any).destroy?.(); } catch {}
  };

  upstream.on('error', cleanup);
  clientSocket.on('error', cleanup);

  upstream.once('connect', () => {
    const lines: string[] = [];
    lines.push(`${req.method} ${req.url} HTTP/${req.httpVersion}`);
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const lower = key.toLowerCase();
      if (lower === 'host') {
        lines.push(`Host: ${upstreamHostHeader}`);
        continue;
      }
      const vals = Array.isArray(value) ? value : [value];
      for (const v of vals) lines.push(`${key}: ${v}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);

    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
}

export function stripFrameAncestors(cspValue: string): string {
  return cspValue
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !/^frame-ancestors\b/i.test(part))
    .join('; ');
}

/**
 * Rewrite a Location header so absolute upstream URLs are replaced with
 * a same-origin path (strips the upstream origin). Keeps the browser
 * inside the proxy when the upstream responds with a 3xx.
 *
 *   "/de"                          → "/de"            (pass through)
 *   "http://localhost:3000/de"     → "/de"            (strip origin)
 *   "https://auth.example.com/..." → unchanged        (external)
 */
export function rewriteLocation(loc: string, targetOrigin: string): string {
  if (!loc) return loc;
  try {
    const target = new URL(targetOrigin);
    const resolved = new URL(loc, target);
    if (resolved.origin === target.origin) {
      return resolved.pathname + resolved.search + resolved.hash;
    }
    return loc;
  } catch {
    return loc;
  }
}

function upstreamErrorHtml(err: unknown, targetOrigin: string): string {
  const e = err as { code?: string; message?: string };
  const code = e?.code ?? 'UNKNOWN';
  const msg = e?.message ?? String(err);
  const hint =
    code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT'
      ? 'Der Dev-Server hat 10 Min lang keinen Response-Header geschickt. Meist heißt das: er ist abgestürzt oder ein Build-Fehler blockiert ihn. Check das Terminal.'
      : code === 'ECONNREFUSED'
      ? 'Der Dev-Server lauscht nicht auf dem Port. Wahrscheinlich beendet. Start ihn neu und drück reload.'
      : code === 'UND_ERR_SOCKET'
      ? 'Die Verbindung zum Dev-Server wurde abgerissen (Crash oder Restart). Reload in ein paar Sekunden.'
      : 'Unerwarteter Proxy-Fehler. Check das Terminal des Dev-Servers.';
  const safe = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <title>Visual Companion — Upstream nicht erreichbar</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 640px; margin: 80px auto; padding: 0 24px; color: #222; line-height: 1.5; }
    h1 { font-size: 22px; margin-bottom: 8px; }
    .sub { color: #888; font-size: 14px; margin-bottom: 24px; }
    pre { background: #fef2f2; color: #991b1b; padding: 14px; border-radius: 8px; border: 1px solid #fecaca; overflow-x: auto; font-size: 13px; }
    .hint { background: #f9fafb; border-left: 3px solid #6b7280; padding: 12px 16px; margin: 20px 0; border-radius: 4px; font-size: 14px; }
    .retry { color: #6b7280; font-size: 13px; margin-top: 32px; }
    code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  </style>
</head>
<body>
  <h1>Dev-Server antwortet nicht</h1>
  <div class="sub">Upstream: <code>${safe(targetOrigin)}</code></div>
  <pre>${safe(code)}: ${safe(msg)}</pre>
  <div class="hint">${safe(hint)}</div>
  <div class="retry">Diese Seite lädt sich alle 4 Sekunden neu — sobald der Dev-Server antwortet, ist deine App zurück.</div>
  <script>setTimeout(() => location.reload(), 4000);</script>
</body>
</html>`;
}

export function injectScript(html: string, scriptTag: string): string {
  const headClose = html.match(/<\/head\s*>/i);
  if (headClose) {
    return html.slice(0, headClose.index!) + scriptTag + html.slice(headClose.index!);
  }
  const bodyOpen = html.match(/<body\b[^>]*>/i);
  if (bodyOpen) {
    const insertAt = bodyOpen.index! + bodyOpen[0].length;
    return html.slice(0, insertAt) + scriptTag + html.slice(insertAt);
  }
  return scriptTag + html;
}
