import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { request as undiciRequest } from 'undici';
import net from 'node:net';
import { IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';

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

export function attachWebSocketProxy(
  httpServer: { on: (evt: string, cb: (...args: any[]) => void) => void },
  targetOrigin: string,
): void {
  const target = new URL(targetOrigin);
  const upstreamHost = target.hostname;
  const upstreamPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Pass everything except companion-specific WS endpoints upstream.
    // The PTY bridge registers /_companion/pty and owns that upgrade.
    if (!req.url) return;
    if (req.url.startsWith('/_companion/') || req.url.startsWith('/window/')) return;
    const upstreamPath = req.url;

    const upstreamSocket = net.connect(upstreamPort, upstreamHost, () => {
      const headers = { ...req.headers } as Record<string, string | string[] | undefined>;
      headers.host = target.host;
      const headerLines: string[] = [`${req.method} ${upstreamPath} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          for (const item of v) headerLines.push(`${k}: ${item}`);
        } else {
          headerLines.push(`${k}: ${v}`);
        }
      }
      upstreamSocket.write(headerLines.join('\r\n') + '\r\n\r\n');
      if (head && head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });

    const cleanup = () => {
      socket.destroy();
      upstreamSocket.destroy();
    };
    upstreamSocket.on('error', cleanup);
    socket.on('error', cleanup);
    upstreamSocket.on('close', () => socket.destroy());
    socket.on('close', () => upstreamSocket.destroy());
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
