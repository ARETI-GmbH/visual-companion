export interface DispatcherOptions {
  /** Optional explicit host (e.g. "localhost:51234"). If unset, uses
   *  window.location.host — which is the right answer whenever the
   *  companion proxy is serving the page the inject is embedded in. */
  host?: string;
  onServerMessage: (msg: any) => void;
}

export class Dispatcher {
  private ws: WebSocket | null = null;
  private queue: string[] = [];
  private reconnectMs = 1000;

  constructor(private opts: DispatcherOptions) {
    this.connect();
  }

  send(event: { type: string; payload: unknown; url: string; timestamp: number }): void {
    const msg = JSON.stringify(event);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    } else {
      this.queue.push(msg);
    }
  }

  sendRaw(message: any): void {
    const s = JSON.stringify(message);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
    else this.queue.push(s);
  }

  private connect(): void {
    const host = this.opts.host || window.location.host;
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${scheme}://${host}/_companion/ws`);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.reconnectMs = 1000;
      for (const q of this.queue) ws.send(q);
      this.queue = [];
    });
    ws.addEventListener('message', (ev) => {
      try { this.opts.onServerMessage(JSON.parse(String(ev.data))); } catch {}
    });
    ws.addEventListener('close', () => {
      this.ws = null;
      setTimeout(() => this.connect(), this.reconnectMs);
      this.reconnectMs = Math.min(this.reconnectMs * 2, 30_000);
    });
    ws.addEventListener('error', () => ws.close());
  }
}
