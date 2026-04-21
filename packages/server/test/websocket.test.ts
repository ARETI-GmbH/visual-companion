import { describe, expect, it, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket from 'ws';
import { AddressInfo } from 'node:net';
import { registerCompanionWebSocket } from '../src/websocket';
import { EventStore } from '../src/event-store';

describe('companion websocket', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => { if (app) await app.close(); app = null; });

  it('accepts connections and stores console events', async () => {
    app = Fastify();
    await app.register(fastifyWebsocket);
    const store = new EventStore({ maxEvents: 100, maxAgeMs: 300_000 });
    registerCompanionWebSocket(app, { store });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;

    const client = new WebSocket(`ws://127.0.0.1:${port}/_companion/ws`);
    await new Promise<void>((r) => client.once('open', r));
    client.send(JSON.stringify({
      type: 'console',
      payload: { level: 'log', args: ['hello'] },
      url: 'http://test',
      timestamp: Date.now(),
    }));
    await new Promise((r) => setTimeout(r, 50));
    client.close();
    expect(store.size()).toBe(1);
  });

  it('broadcasts server-to-browser messages to connected clients', async () => {
    app = Fastify();
    await app.register(fastifyWebsocket);
    const store = new EventStore({ maxEvents: 100, maxAgeMs: 300_000 });
    const gateway = registerCompanionWebSocket(app, { store });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;

    const client = new WebSocket(`ws://127.0.0.1:${port}/_companion/ws`);
    const received = new Promise<string>((resolve) => {
      client.on('message', (msg) => resolve(msg.toString()));
    });
    await new Promise<void>((r) => client.once('open', r));
    gateway.broadcast({ type: 'highlight', selector: '.foo', durationMs: 800 });
    expect(JSON.parse(await received)).toEqual({
      type: 'highlight', selector: '.foo', durationMs: 800,
    });
    client.close();
  });
});
