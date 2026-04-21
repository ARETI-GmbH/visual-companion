import type { Dispatcher } from './dispatcher';

export function attachErrorHandlers(dispatcher: Dispatcher): void {
  window.addEventListener('error', (e) => {
    dispatcher.send({
      type: 'error',
      timestamp: Date.now(),
      url: window.location.href,
      payload: { message: e.message, stack: (e.error instanceof Error) ? e.error.stack ?? null : null },
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = (e.reason instanceof Error) ? e.reason : null;
    dispatcher.send({
      type: 'error',
      timestamp: Date.now(),
      url: window.location.href,
      payload: { message: reason?.message ?? String(e.reason), stack: reason?.stack ?? null },
    });
  });
}
