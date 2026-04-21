import { Dispatcher } from './dispatcher';

const scriptTag = document.currentScript as HTMLScriptElement | null;
const port = parseInt(scriptTag?.dataset.companionPort ?? '7777', 10);

const dispatcher = new Dispatcher({
  port,
  onServerMessage: (msg) => {
    // placeholder — handlers attached in later tasks
    console.debug('[visual-companion] server msg:', msg);
  },
});

(window as any).__visualCompanion = { dispatcher };
