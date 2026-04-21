import { Dispatcher } from './dispatcher';
import { patchConsole } from './console-patch';
import { patchNetwork } from './network-patch';
import { attachErrorHandlers } from './error-handler';
import { attachMutationObserver } from './mutation-observer';
import { attachNavigationHooks } from './navigation-hooks';
import { unregisterExistingServiceWorkers } from './sw-cleanup';
import { createOverlay } from './overlay';
import { installPointer } from './pointer';

unregisterExistingServiceWorkers();

const scriptTag = document.currentScript as HTMLScriptElement | null;
const port = parseInt(scriptTag?.dataset.companionPort ?? '7777', 10);

const overlay = createOverlay();

const dispatcher = new Dispatcher({
  port,
  onServerMessage: (msg) => {
    if (msg.type === 'highlight') overlay.pulseHighlight(msg.selector, msg.durationMs ?? 800);
    else if (msg.type === 'scroll_to') document.querySelector(msg.selector)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else if (msg.type === 'navigate') window.location.href = msg.url;
    else if (msg.type === 'reload') window.location.reload();
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

attachNavigationHooks(dispatcher);

(window as any).__visualCompanion = { dispatcher, overlay };
