import { FastifyInstance } from 'fastify';
export interface ProxyOptions {
    targetOrigin: string;
    injectScriptTag?: string;
}
export declare function registerProxy(app: FastifyInstance, opts: ProxyOptions): Promise<void>;
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
export declare function attachWebSocketProxy(httpServer: HttpUpgradeLike, targetOrigin: string): void;
export declare function stripFrameAncestors(cspValue: string): string;
/**
 * Rewrite a Location header so absolute upstream URLs are replaced with
 * a same-origin path (strips the upstream origin). Keeps the browser
 * inside the proxy when the upstream responds with a 3xx.
 *
 *   "/de"                          → "/de"            (pass through)
 *   "http://localhost:3000/de"     → "/de"            (strip origin)
 *   "https://auth.example.com/..." → unchanged        (external)
 */
export declare function rewriteLocation(loc: string, targetOrigin: string): string;
export declare function injectScript(html: string, scriptTag: string): string;
export {};
