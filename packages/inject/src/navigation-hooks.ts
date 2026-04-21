import type { Dispatcher } from './dispatcher';
import type { Overlay } from './overlay';

export function attachNavigationHooks(dispatcher: Dispatcher, overlay?: Overlay): void {
  let previousHref = window.location.href;
  const emit = () => {
    const href = window.location.href;
    if (href === previousHref) return;
    const referrer = previousHref;
    previousHref = href;
    // Drop the visual overlay — the selected element's DOM node is
    // most likely detached now (SPA re-render) and the frame would
    // render at stale coordinates / zero size. Server-side snapshot
    // and the sticky pendingPrefix on the pty survive the nav, so
    // claude's context is preserved; only the on-screen frame hides.
    if (overlay) {
      overlay.hideSelected();
      overlay.hideSelectedRegion();
      overlay.hideHover();
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
