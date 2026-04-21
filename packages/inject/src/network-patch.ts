import type { Dispatcher } from './dispatcher';

export function patchNetwork(dispatcher: Dispatcher): void {
  patchFetch(dispatcher);
  patchXHR(dispatcher);
}

function patchFetch(dispatcher: Dispatcher): void {
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const start = performance.now();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    let response: Response;
    try {
      response = await origFetch(input as any, init);
    } catch (err) {
      dispatcher.send({
        type: 'network',
        timestamp: Date.now(),
        url: window.location.href,
        payload: { method, url, status: 0, durationMs: performance.now() - start, requestSize: 0, responseSize: 0 },
      });
      throw err;
    }
    const durationMs = performance.now() - start;
    dispatcher.send({
      type: 'network',
      timestamp: Date.now(),
      url: window.location.href,
      payload: {
        method, url,
        status: response.status,
        durationMs,
        requestSize: getBodyLen(init?.body),
        responseSize: parseInt(response.headers.get('content-length') ?? '0', 10),
      },
    });
    return response;
  };
}

function patchXHR(dispatcher: Dispatcher): void {
  const OrigXHR = window.XMLHttpRequest;
  const origOpen = OrigXHR.prototype.open;
  const origSend = OrigXHR.prototype.send;
  OrigXHR.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
    (this as any).__vc = { method, url: url.toString(), start: 0, size: 0 };
    return (origOpen as any).call(this, method, url, ...rest);
  };
  OrigXHR.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const ctx = (this as any).__vc;
    if (ctx) {
      ctx.start = performance.now();
      ctx.size = getBodyLen(body);
      this.addEventListener('loadend', () => {
        dispatcher.send({
          type: 'network',
          timestamp: Date.now(),
          url: window.location.href,
          payload: {
            method: ctx.method, url: ctx.url,
            status: this.status,
            durationMs: performance.now() - ctx.start,
            requestSize: ctx.size,
            responseSize: parseInt(this.getResponseHeader('content-length') ?? '0', 10),
          },
        });
      });
    }
    return origSend.call(this, body as any);
  };
}

function getBodyLen(b: unknown): number {
  if (!b) return 0;
  if (typeof b === 'string') return b.length;
  if (b instanceof Blob) return b.size;
  if (b instanceof ArrayBuffer) return b.byteLength;
  return 0;
}
