import { describe, expect, it, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import { registerProxy } from '../src/proxy';
import { AddressInfo } from 'node:net';

describe('proxy WebSocket passthrough', () => {
  let app: FastifyInstance | null = null;
  let upstreamWss: WebSocketServer | null = null;
  afterEach(async () => {
    if (app) await app.close();
    if (upstreamWss) upstreamWss.close();
    app = null;
    upstreamWss = null;
  });

  it('forwards WebSocket messages both ways', async () => {
    upstreamWss = new WebSocketServer({ port: 0 });
    upstreamWss.on('connection', (ws) => {
      ws.on('message', (msg) => ws.send('echo:' + msg.toString()));
    });
    await new Promise<void>((res) => upstreamWss!.on('listening', res));
    const upstreamPort = (upstreamWss.address() as AddressInfo).port;

    app = Fastify();
    await registerProxy(app, { targetOrigin: `http://127.0.0.1:${upstreamPort}` });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const proxyPort = (app.server.address() as AddressInfo).port;

    const client = new WebSocket(`ws://127.0.0.1:${proxyPort}/app/ws`);
    const received = await new Promise<string>((resolve) => {
      client.on('open', () => client.send('hello'));
      client.on('message', (data) => resolve(data.toString()));
    });
    client.close();
    expect(received).toBe('echo:hello');
  });
});
