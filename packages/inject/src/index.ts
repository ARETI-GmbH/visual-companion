import { Dispatcher } from './dispatcher';
import { patchConsole } from './console-patch';
import { patchNetwork } from './network-patch';
import { attachErrorHandlers } from './error-handler';
import { attachMutationObserver } from './mutation-observer';
import { attachNavigationHooks } from './navigation-hooks';
import { unregisterExistingServiceWorkers } from './sw-cleanup';

unregisterExistingServiceWorkers();

const scriptTag = document.currentScript as HTMLScriptElement | null;
const port = parseInt(scriptTag?.dataset.companionPort ?? '7777', 10);

const dispatcher = new Dispatcher({
  port,
  onServerMessage: (msg) => {
    console.debug('[visual-companion] server msg:', msg);
  },
});

patchConsole(dispatcher);
patchNetwork(dispatcher);
attachErrorHandlers(dispatcher);

if (document.body) attachMutationObserver(dispatcher);
else document.addEventListener('DOMContentLoaded', () => attachMutationObserver(dispatcher));

attachNavigationHooks(dispatcher);

(window as any).__visualCompanion = { dispatcher };
