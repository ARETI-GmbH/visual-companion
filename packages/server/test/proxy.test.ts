import { describe, expect, it, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import http from 'node:http';
import { registerProxy } from '../src/proxy';

function startUpstream(handler: http.RequestListener): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address) resolve({ port: address.port, server });
    });
  });
}

describe('proxy', () => {
  let app: FastifyInstance | null = null;
  let upstream: http.Server | null = null;
  afterEach(async () => {
    if (app) await app.close();
    if (upstream) upstream.close();
    app = null;
    upstream = null;
  });

  it('strips X-Frame-Options and CSP frame-ancestors, preserves other headers', async () => {
    const { port, server } = await startUpstream((_req, res) => {
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; script-src 'self'");
      res.setHeader('X-Custom', 'keep-me');
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><head></head><body>hi</body></html>');
    });
    upstream = server;
    app = Fastify();
    await registerProxy(app, { targetOrigin: `http://127.0.0.1:${port}` });
    await app.ready();
    const resp = await app.inject({ method: 'GET', url: '/app/' });
    expect(resp.headers['x-frame-options']).toBeUndefined();
    expect(resp.headers['content-security-policy']).toBe("script-src 'self'");
    expect(resp.headers['x-custom']).toBe('keep-me');
  });

  it('forwards non-HTML responses untouched', async () => {
    const { port, server } = await startUpstream((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
    });
    upstream = server;
    app = Fastify();
    await registerProxy(app, { targetOrigin: `http://127.0.0.1:${port}` });
    await app.ready();
    const resp = await app.inject({ method: 'GET', url: '/app/api/data' });
    expect(resp.statusCode).toBe(200);
    expect(resp.payload).toBe('{"ok":true}');
  });

  it('injects companion script before </head>', async () => {
    const { port, server } = await startUpstream((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<html><head><title>t</title></head><body></body></html>');
    });
    upstream = server;
    app = Fastify();
    await registerProxy(app, {
      targetOrigin: `http://127.0.0.1:${port}`,
      injectScriptTag: '<script src="/_companion/inject.js"></script>',
    });
    await app.ready();
    const resp = await app.inject({ method: 'GET', url: '/app/' });
    expect(resp.payload).toContain('<script src="/_companion/inject.js"></script></head>');
  });

  it('falls back to <body> when no </head>', async () => {
    const { port, server } = await startUpstream((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end('<body><div>hi</div></body>');
    });
    upstream = server;
    app = Fastify();
    await registerProxy(app, {
      targetOrigin: `http://127.0.0.1:${port}`,
      injectScriptTag: '<script>X</script>',
    });
    await app.ready();
    const resp = await app.inject({ method: 'GET', url: '/app/' });
    expect(resp.payload).toMatch(/<body><script>X<\/script><div>hi/);
  });
});
