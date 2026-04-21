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
export declare function injectScript(html: string, scriptTag: string): string;
