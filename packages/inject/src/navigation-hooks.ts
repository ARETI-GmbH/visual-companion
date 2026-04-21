import type { Dispatcher } from './dispatcher';

export function attachNavigationHooks(dispatcher: Dispatcher): void {
  let previousHref = window.location.href;
  const emit = () => {
    const href = window.location.href;
    if (href === previousHref) return;
    const referrer = previousHref;
    previousHref = href;
    dispatcher.send({
      type: 'navigation',
      timestamp: Date.now(),
      url: href,
      payload: { newUrl: href, referrer },
    });
  };

  window.addEventListener('popstate', emit);

  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = function (...args: [any, string, (string | URL | null)?]) {
    const ret = origPush(...args);
    queueMicrotask(emit);
    return ret;
  };
  history.replaceState = function (...args: [any, string, (string | URL | null)?]) {
    const ret = origReplace(...args);
    queueMicrotask(emit);
    return ret;
  };
}
