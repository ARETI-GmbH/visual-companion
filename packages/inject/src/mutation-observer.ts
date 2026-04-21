import type { Dispatcher } from './dispatcher';

export function attachMutationObserver(dispatcher: Dispatcher): void {
  let adds = 0, removes = 0, attributeChanges = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (!adds && !removes && !attributeChanges) return;
    dispatcher.send({
      type: 'mutation',
      timestamp: Date.now(),
      url: window.location.href,
      payload: { adds, removes, attributeChanges },
    });
    adds = removes = attributeChanges = 0;
  };

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') { adds += r.addedNodes.length; removes += r.removedNodes.length; }
      if (r.type === 'attributes') attributeChanges++;
    }
    if (!pending) {
      pending = setTimeout(() => { pending = null; flush(); }, 500);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
}
