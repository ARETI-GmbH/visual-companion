import { Dispatcher } from './dispatcher';
import { patchConsole } from './console-patch';
import { patchNetwork } from './network-patch';

const scriptTag = document.currentScript as HTMLScriptElement | null;
const port = parseInt(scriptTag?.dataset.companionPort ?? '7777', 10);

const dispatcher = new Dispatcher({
  port,
  onServerMessage: (msg) => {
    // placeholder — handlers attached in later tasks
    console.debug('[visual-companion] server msg:', msg);
  },
});

patchConsole(dispatcher);
patchNetwork(dispatcher);

(window as any).__visualCompanion = { dispatcher };
