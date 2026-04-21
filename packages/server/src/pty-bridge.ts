import { FastifyInstance } from 'fastify';
import { spawn, IPty } from 'node-pty';
import WebSocket from 'ws';

export interface PtyBridgeOptions {
  cwd: string;
  companionPort: number | (() => number);
  shell?: string;
  claudeArgs?: string[];
}

export interface PtyBridgeControl {
  writeToTerminal(text: string): void;
  onTerminalInput(handler: (data: string) => void): () => void;
}

export function registerPtyBridge(app: FastifyInstance, opts: PtyBridgeOptions): PtyBridgeControl {
  let currentPty: IPty | null = null;
  const inputListeners = new Set<(d: string) => void>();

  app.get('/_companion/pty', { websocket: true } as any, (conn: any) => {
    const socket: WebSocket = conn.socket ?? conn;
    const pty = spawn(
      opts.shell ?? process.env.SHELL ?? '/bin/zsh',
      ['-lc', ['claude', ...(opts.claudeArgs ?? [])].join(' ')],
      {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: opts.cwd,
        env: {
          ...process.env,
          VISUAL_COMPANION_PORT: String(
            typeof opts.companionPort === 'function' ? opts.companionPort() : opts.companionPort,
          ),
        },
      }
    );
    currentPty = pty;

    pty.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'data', data }));
      }
    });
    pty.onExit(({ exitCode }) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'exit', exitCode }));
      }
      currentPty = null;
    });

    socket.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'data') {
          pty.write(msg.data);
          for (const h of inputListeners) h(msg.data);
        }
        if (msg.type === 'resize') pty.resize(msg.cols, msg.rows);
      } catch {
        // ignore malformed
      }
    });
    socket.on('close', () => { pty.kill(); currentPty = null; });
  });

  return {
    writeToTerminal(text: string) {
      if (currentPty) currentPty.write(text);
    },
    onTerminalInput(handler) {
      inputListeners.add(handler);
      return () => inputListeners.delete(handler);
    },
  };
}
