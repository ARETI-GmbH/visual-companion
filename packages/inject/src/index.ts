import { Dispatcher } from './dispatcher';
import { patchConsole } from './console-patch';
import { patchNetwork } from './network-patch';
import { attachErrorHandlers } from './error-handler';
import { attachMutationObserver } from './mutation-observer';
import { attachNavigationHooks } from './navigation-hooks';
import { unregisterExistingServiceWorkers } from './sw-cleanup';
import { createOverlay } from './overlay';
import { installPointer } from './pointer';
import { handleEvaluate } from './evaluate';

unregisterExistingServiceWorkers();

const overlay = createOverlay();

// We used to read the companion port out of the <script> data attribute,
// but the daemon built that tag before `app.listen()` resolved the real
// port — so it was always 0, and ws://localhost:0 silently refused every
// connection. window.location.host IS the proxy origin (since the proxy
// serves the page the inject is embedded in), so just use it.
const dispatcher = new Dispatcher({
  onServerMessage: (msg) => {
    if (msg.type === 'highlight') overlay.pulseHighlight(msg.selector, msg.durationMs ?? 800);
    else if (msg.type === 'scroll_to') document.querySelector(msg.selector)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else if (msg.type === 'navigate') window.location.href = msg.url;
    else if (msg.type === 'reload') window.location.reload();
    else if (msg.type === 'evaluate') handleEvaluate(dispatcher, msg);
    else if (msg.type === 'buffer-update') overlay.setSelections(msg.items ?? []);
    else if (msg.type === 'claude-activity') overlay.setBusy(!!msg.isBusy);
  },
});

patchConsole(dispatcher);
patchNetwork(dispatcher);
attachErrorHandlers(dispatcher);

if (document.body) {
  attachMutationObserver(dispatcher);
  installPointer(dispatcher, overlay);
} else {
  document.addEventListener('DOMContentLoaded', () => {
    attachMutationObserver(dispatcher);
    installPointer(dispatcher, overlay);
  });
}

attachNavigationHooks(dispatcher, overlay);

(window as any).__visualCompanion = { dispatcher, overlay };
