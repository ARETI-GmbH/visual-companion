import type { Dispatcher } from './dispatcher';
import { filterComputedStyles } from './style-filter';
import { captureElementScreenshot } from './screenshot';
import { lookupSourceLocation } from './source-map';

export function handleEvaluate(dispatcher: Dispatcher, msg: any): void {
  const { requestId, kind } = msg;
  Promise.resolve().then(async () => {
    let data: any;
    try {
      switch (kind) {
        case 'dom_snapshot': {
          const root = msg.selector ? document.querySelector(msg.selector) : document.documentElement;
          data = { html: (root?.outerHTML || '').slice(0, 50_000) };
          break;
        }
        case 'computed_styles': {
          const el = document.querySelector(msg.selector);
          data = el ? filterComputedStyles(window.getComputedStyle(el)) : { error: 'not found' };
          break;
        }
        case 'source_location': {
          const el = document.querySelector(msg.selector);
          data = el ? await lookupSourceLocation(el) : null;
          break;
        }
        case 'screenshot': {
          const el = msg.selector ? document.querySelector(msg.selector) : document.body;
          data = el ? { png: await captureElementScreenshot(el) } : { error: 'not found' };
          break;
        }
        case 'page_info': {
          data = {
            url: window.location.href,
            title: document.title,
            viewport: { w: window.innerWidth, h: window.innerHeight },
            userAgent: navigator.userAgent,
            localStorageKeys: Object.keys(localStorage ?? {}),
          };
          break;
        }
        case 'evaluate': {
          // User-confirmation happens server-side; inject just runs
          try {
            // eslint-disable-next-line no-eval
            data = { result: eval(msg.expression) };
          } catch (e) {
            data = { error: (e as Error).message };
          }
          break;
        }
        default:
          data = { error: `unknown kind ${kind}` };
      }
    } catch (err) {
      data = { error: (err as Error).message };
    }
    dispatcher.sendRaw({ type: 'response', requestId, data });
  });
}
