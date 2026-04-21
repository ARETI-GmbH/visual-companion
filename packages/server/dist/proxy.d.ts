import { FastifyInstance } from 'fastify';
export interface ProxyOptions {
    targetOrigin: string;
    injectScriptTag?: string;
}
export declare function registerProxy(app: FastifyInstance, opts: ProxyOptions): Promise<void>;
export declare function attachWebSocketProxy(httpServer: {
    on: (evt: string, cb: (...args: any[]) => void) => void;
}, targetOrigin: string): void;
export declare function stripFrameAncestors(cspValue: string): string;
/**
 * Rewrite a Location header so that same-origin redirects stay inside
 * the /app proxy. External redirects are passed through unchanged.
 *
 *   "/de"                          → "/app/de"
 *   "http://localhost:3000/de"     → "/app/de"   (if targetOrigin matches)
 *   "https://auth.example.com/..." → unchanged   (external)
 */
export declare function rewriteLocation(loc: string, targetOrigin: string): string;
/**
 * Rewrite a Set-Cookie's Path attribute so cookies scoped to upstream paths
 * are sent back for the matching /app-prefixed paths the iframe uses.
 *
 *   "sid=x; Path=/api; HttpOnly" → "sid=x; Path=/app/api; HttpOnly"
 *   "sid=x; Path=/"              → "sid=x; Path=/app/"
 *   "sid=x" (no Path)            → unchanged
 */
export declare function rewriteCookiePath(cookie: string): string;
export declare function injectScript(html: string, scriptTag: string): string;
