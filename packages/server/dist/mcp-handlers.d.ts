import { FastifyInstance } from 'fastify';
import { EventStore } from './event-store.js';
import { WebSocketGateway } from './websocket.js';
import { PtyBridgeControl } from './pty-bridge.js';
export interface McpHandlersOptions {
    store: EventStore;
    gateway: WebSocketGateway;
    pty: PtyBridgeControl;
}
export declare function registerMcpHandlers(app: FastifyInstance, opts: McpHandlersOptions): void;
