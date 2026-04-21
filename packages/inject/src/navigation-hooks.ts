import type { Dispatcher } from './dispatcher';
import type { Overlay } from './overlay';

export function attachNavigationHooks(dispatcher: Dispatcher, overlay?: Overlay): void {
  let previousHref = window.location.href;
  const emit = () => {
    const href = window.location.href;
    if (href === previousHref) return;
    const referrer = previousHref;
    previousHref = href;
    if (overlay) {
      // Clear transient frames and let setSelections reconcile the
      // persistent buffer overlays against the new page. Re-attach
      // on navigate-back is "free": same-page items' querySelectors
      // resolve again, others stay hidden.
      overlay.hideHover();
      // Give SPA frameworks a couple of microtasks to apply their DOM
      // update before we querySelector — otherwise the first refresh
      // runs on the outgoing page and the selector misses.
      queueMicrotask(() => overlay.refresh());
      setTimeout(() => overlay.refresh(), 0);
      setTimeout(() => overlay.refresh(), 150);
    }
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
