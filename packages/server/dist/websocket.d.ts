import { FastifyInstance } from 'fastify';
import { EventEmitter } from 'node:events';
import { EventStore } from './event-store';
import type { CompanionEvent } from './types';
export interface WebSocketOptions {
    store: EventStore;
    onEvent?: (event: CompanionEvent) => void;
    /** Fired right after a new client completes the WS upgrade. Useful
     *  for replaying server-authoritative state (e.g. the selection
     *  buffer) so reconnects don't start blank. */
    onNewClient?: () => void;
}
export interface ServerMessage {
    type: 'highlight' | 'scroll_to' | 'navigate' | 'reload' | 'evaluate';
    [k: string]: unknown;
}
export interface WebSocketGateway {
    broadcast(msg: ServerMessage): void;
    connectionCount(): number;
    once: EventEmitter['once'];
    emit: EventEmitter['emit'];
}
export declare function registerCompanionWebSocket(app: FastifyInstance, opts: WebSocketOptions): WebSocketGateway;
