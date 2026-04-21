import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
export function registerCompanionWebSocket(app, opts) {
    const clients = new Set();
    const emitter = new EventEmitter();
    app.get('/_companion/ws', { websocket: true }, (conn) => {
        const socket = conn.socket ?? conn;
        clients.add(socket);
        socket.on('message', (raw) => {
            try {
                const incoming = JSON.parse(raw.toString());
                if (incoming.type === 'response' && incoming.requestId) {
                    emitter.emit(`response:${incoming.requestId}`, incoming.data);
                    return;
                }
                const event = {
                    id: randomUUID(),
                    timestamp: incoming.timestamp ?? Date.now(),
                    type: incoming.type,
                    url: incoming.url ?? '',
                    payload: incoming.payload,
                };
                opts.store.append(event);
                try {
                    opts.onEvent?.(event);
                }
                catch { /* ignore notifier errors */ }
            }
            catch {
                // ignore malformed
            }
        });
        socket.on('close', () => clients.delete(socket));
    });
    return {
        broadcast(msg) {
            const payload = JSON.stringify(msg);
            for (const c of clients) {
                if (c.readyState === WebSocket.OPEN)
                    c.send(payload);
            }
        },
        connectionCount() { return clients.size; },
        once: emitter.once.bind(emitter),
        emit: emitter.emit.bind(emitter),
    };
}
//# sourceMappingURL=websocket.js.map