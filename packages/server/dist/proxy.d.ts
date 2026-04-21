import { FastifyInstance } from 'fastify';
export interface ProxyOptions {
    targetOrigin: string;
    injectScriptTag?: string;
}
export declare function registerProxy(app: FastifyInstance, opts: ProxyOptions): Promise<void>;
export declare function attachWebSocketProxy(_httpServer: {
    on: (evt: string, cb: (...args: any[]) => void) => void;
}, _targetOrigin: string): void;
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
