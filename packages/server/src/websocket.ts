import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { EventStore } from './event-store';
import type { CompanionEvent } from './types';

export interface WebSocketOptions {
  store: EventStore;
  onEvent?: (event: CompanionEvent) => void;
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

export function registerCompanionWebSocket(
  app: FastifyInstance,
  opts: WebSocketOptions,
): WebSocketGateway {
  const clients = new Set<WebSocket>();
  const emitter = new EventEmitter();

  app.get('/_companion/ws', { websocket: true } as any, (conn: any) => {
    const socket: WebSocket = conn.socket ?? conn;
    clients.add(socket);
    socket.on('message', (raw: Buffer) => {
      try {
        const incoming = JSON.parse(raw.toString());
        if (incoming.type === 'response' && incoming.requestId) {
          emitter.emit(`response:${incoming.requestId}`, incoming.data);
          return;
        }
        const event: CompanionEvent = {
          id: randomUUID(),
          timestamp: incoming.timestamp ?? Date.now(),
          type: incoming.type,
          url: incoming.url ?? '',
          payload: incoming.payload,
        };
        opts.store.append(event);
        try { opts.onEvent?.(event); } catch { /* ignore notifier errors */ }
      } catch {
        // ignore malformed
      }
    });
    socket.on('close', () => clients.delete(socket));
  });

  return {
    broadcast(msg: ServerMessage) {
      const payload = JSON.stringify(msg);
      for (const c of clients) {
        if (c.readyState === WebSocket.OPEN) c.send(payload);
      }
    },
    connectionCount() { return clients.size; },
    once: emitter.once.bind(emitter) as EventEmitter['once'],
    emit: emitter.emit.bind(emitter) as EventEmitter['emit'],
  };
}
