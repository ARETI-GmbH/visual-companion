import { request as undiciRequest } from 'undici';
import net from 'node:net';
const STRIPPED_RESPONSE_HEADERS = new Set([
    'x-frame-options',
    'content-length',
    'transfer-encoding',
]);
export async function registerProxy(app, opts) {
    const { targetOrigin } = opts;
    app.all('/app/*', async (req, reply) => {
        const upstreamUrl = new URL(req.params['*'] || '', targetOrigin + '/');
        for (const [k, v] of Object.entries(req.query)) {
            upstreamUrl.searchParams.set(k, v);
        }
        const forwardHeaders = { ...req.headers };
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
                method: req.method,
                headers: forwardHeaders,
                body: req.raw,
                // Dev-servers (Next.js Turbopack, Vite cold start) can take well over
                // a minute on the first request. Defaults would surface as a cryptic
                // UND_ERR_HEADERS_TIMEOUT 500 JSON in the iframe.
                headersTimeout: 10 * 60 * 1000,
                bodyTimeout: 10 * 60 * 1000,
            });
        }
        catch (err) {
            reply.status(502).type('text/html').send(upstreamErrorHtml(err, targetOrigin));
            return;
        }
        const ctype = upstreamResp.headers['content-type'];
        const isHtml = typeof ctype === 'string' && ctype.includes('text/html');
        for (const [key, value] of Object.entries(upstreamResp.headers)) {
            const lower = key.toLowerCase();
            if (STRIPPED_RESPONSE_HEADERS.has(lower))
                continue;
            // Strip content-encoding on the HTML-injection path: we're about to
            // serve the decoded text, so leaving 'gzip' etc. on would make the
            // browser double-decode and fail.
            if (lower === 'content-encoding' && isHtml && opts.injectScriptTag)
                continue;
            if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only') {
                const filtered = stripFrameAncestors(Array.isArray(value) ? value.join(', ') : String(value));
                if (filtered)
                    reply.header(key, filtered);
                continue;
            }
            if (lower === 'location') {
                const rewritten = rewriteLocation(Array.isArray(value) ? value.join(', ') : String(value), targetOrigin);
                reply.header('location', rewritten);
                continue;
            }
            if (lower === 'set-cookie') {
                const cookies = Array.isArray(value) ? value : [String(value)];
                reply.header('set-cookie', cookies.map(rewriteCookiePath));
                continue;
            }
            reply.header(key, value);
        }
        reply.status(upstreamResp.statusCode);
        if (isHtml && opts.injectScriptTag) {
            const body = await upstreamResp.body.text();
            const injected = injectScript(body, opts.injectScriptTag);
            reply.send(injected);
        }
        else {
            const buf = Buffer.from(await upstreamResp.body.arrayBuffer());
            reply.send(buf);
        }
    });
    app.addHook('onReady', async () => {
        attachWebSocketProxy(app.server, targetOrigin);
    });
}
export function attachWebSocketProxy(httpServer, targetOrigin) {
    const target = new URL(targetOrigin);
    const upstreamHost = target.hostname;
    const upstreamPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    httpServer.on('upgrade', (req, socket, head) => {
        if (!req.url?.startsWith('/app/'))
            return;
        const upstreamPath = req.url.slice('/app'.length) || '/';
        const upstreamSocket = net.connect(upstreamPort, upstreamHost, () => {
            const headers = { ...req.headers };
            headers.host = target.host;
            const headerLines = [`${req.method} ${upstreamPath} HTTP/1.1`];
            for (const [k, v] of Object.entries(headers)) {
                if (v === undefined)
                    continue;
                if (Array.isArray(v)) {
                    for (const item of v)
                        headerLines.push(`${k}: ${item}`);
                }
                else {
                    headerLines.push(`${k}: ${v}`);
                }
            }
            upstreamSocket.write(headerLines.join('\r\n') + '\r\n\r\n');
            if (head && head.length > 0)
                upstreamSocket.write(head);
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
export function stripFrameAncestors(cspValue) {
    return cspValue
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.length > 0 && !/^frame-ancestors\b/i.test(part))
        .join('; ');
}
/**
 * Rewrite a Location header so that same-origin redirects stay inside
 * the /app proxy. External redirects are passed through unchanged.
 *
 *   "/de"                          → "/app/de"
 *   "http://localhost:3000/de"     → "/app/de"   (if targetOrigin matches)
 *   "https://auth.example.com/..." → unchanged   (external)
 */
export function rewriteLocation(loc, targetOrigin) {
    if (!loc)
        return loc;
    try {
        const target = new URL(targetOrigin);
        const resolved = new URL(loc, target);
        if (resolved.origin === target.origin) {
            return '/app' + resolved.pathname + resolved.search + resolved.hash;
        }
        return loc;
    }
    catch {
        return loc;
    }
}
/**
 * Rewrite a Set-Cookie's Path attribute so cookies scoped to upstream paths
 * are sent back for the matching /app-prefixed paths the iframe uses.
 *
 *   "sid=x; Path=/api; HttpOnly" → "sid=x; Path=/app/api; HttpOnly"
 *   "sid=x; Path=/"              → "sid=x; Path=/app/"
 *   "sid=x" (no Path)            → unchanged
 */
export function rewriteCookiePath(cookie) {
    return cookie.replace(/;\s*Path=([^;]*)/i, (_m, rawPath) => {
        const path = rawPath.trim();
        if (path === '' || path === '/')
            return '; Path=/app/';
        if (path.startsWith('/'))
            return '; Path=/app' + path;
        return '; Path=' + path;
    });
}
function upstreamErrorHtml(err, targetOrigin) {
    const e = err;
    const code = e?.code ?? 'UNKNOWN';
    const msg = e?.message ?? String(err);
    const hint = code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT'
        ? 'Der Dev-Server hat 10 Min lang keinen Response-Header geschickt. Meist heißt das: er ist abgestürzt oder ein Build-Fehler blockiert ihn. Check das Terminal.'
        : code === 'ECONNREFUSED'
            ? 'Der Dev-Server lauscht nicht auf dem Port. Wahrscheinlich beendet. Start ihn neu und drück reload.'
            : code === 'UND_ERR_SOCKET'
                ? 'Die Verbindung zum Dev-Server wurde abgerissen (Crash oder Restart). Reload in ein paar Sekunden.'
                : 'Unerwarteter Proxy-Fehler. Check das Terminal des Dev-Servers.';
    const safe = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
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
export function injectScript(html, scriptTag) {
    const headClose = html.match(/<\/head\s*>/i);
    if (headClose) {
        return html.slice(0, headClose.index) + scriptTag + html.slice(headClose.index);
    }
    const bodyOpen = html.match(/<body\b[^>]*>/i);
    if (bodyOpen) {
        const insertAt = bodyOpen.index + bodyOpen[0].length;
        return html.slice(0, insertAt) + scriptTag + html.slice(insertAt);
    }
    return scriptTag + html;
}
//# sourceMappingURL=proxy.js.map