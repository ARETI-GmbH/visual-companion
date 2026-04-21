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

  app.all('/app/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const upstreamUrl = new URL(
      (req.params as { '*': string })['*'] || '',
      targetOrigin + '/',
    );
    for (const [k, v] of Object.entries(req.query as Record<string, string>)) {
      upstreamUrl.searchParams.set(k, v);
    }
    const forwardHeaders = { ...(req.headers as Record<string, string>) };
    delete forwardHeaders.host;
    delete forwardHeaders['content-length'];

    const upstreamResp = await undiciRequest(upstreamUrl.toString(), {
      method: req.method as any,
      headers: forwardHeaders,
      body: req.raw,
    });

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
        const rewritten = rewriteLocation(
          Array.isArray(value) ? value.join(', ') : String(value),
          targetOrigin,
        );
        reply.header('location', rewritten);
        continue;
      }
      if (lower === 'set-cookie') {
        const cookies = Array.isArray(value) ? value : [String(value)];
        reply.header('set-cookie', cookies.map(rewriteCookiePath));
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
    if (!req.url?.startsWith('/app/')) return;
    const upstreamPath = req.url.slice('/app'.length) || '/';

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
 * Rewrite a Location header so that same-origin redirects stay inside
 * the /app proxy. External redirects are passed through unchanged.
 *
 *   "/de"                          → "/app/de"
 *   "http://localhost:3000/de"     → "/app/de"   (if targetOrigin matches)
 *   "https://auth.example.com/..." → unchanged   (external)
 */
export function rewriteLocation(loc: string, targetOrigin: string): string {
  if (!loc) return loc;
  try {
    const target = new URL(targetOrigin);
    const resolved = new URL(loc, target);
    if (resolved.origin === target.origin) {
      return '/app' + resolved.pathname + resolved.search + resolved.hash;
    }
    return loc;
  } catch {
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
export function rewriteCookiePath(cookie: string): string {
  return cookie.replace(/;\s*Path=([^;]*)/i, (_m, rawPath: string) => {
    const path = rawPath.trim();
    if (path === '' || path === '/') return '; Path=/app/';
    if (path.startsWith('/')) return '; Path=/app' + path;
    return '; Path=' + path;
  });
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
