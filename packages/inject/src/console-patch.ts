import type { Dispatcher } from './dispatcher';

const LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const;

export function patchConsole(dispatcher: Dispatcher): void {
  for (const level of LEVELS) {
    const original = (console as any)[level].bind(console);
    (console as any)[level] = (...args: unknown[]) => {
      original(...args);
      try {
        dispatcher.send({
          type: 'console',
          timestamp: Date.now(),
          url: window.location.href,
          payload: { level, args: args.map(serializeArg) },
        });
      } catch {}
    };
  }
}

function serializeArg(arg: unknown): unknown {
  if (arg === null || arg === undefined) return arg;
  const t = typeof arg;
  if (t === 'string' || t === 'number' || t === 'boolean') return arg;
  if (arg instanceof Error) return { __type: 'Error', message: arg.message, stack: arg.stack };
  if (arg instanceof Node) {
    const el = arg as Element;
    return { __type: 'Node', tag: el.tagName?.toLowerCase(), id: el.id || null };
  }
  try {
    return JSON.parse(JSON.stringify(arg));
  } catch {
    return String(arg);
  }
}
