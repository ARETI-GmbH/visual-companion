import type { Dispatcher } from './dispatcher';
import type { Overlay } from './overlay';
import { uniqueSelector } from './selector-gen';
import { filterComputedStyles } from './style-filter';
import { captureElementScreenshot } from './screenshot';
import { lookupSourceLocation } from './source-map';

export function installPointer(dispatcher: Dispatcher, overlay: Overlay): void {
  let altDown = false;
  let regionStart: { x: number; y: number } | null = null;

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Alt' && !altDown) {
      altDown = true;
      document.body.style.cursor = 'crosshair';
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Alt') {
      altDown = false;
      document.body.style.cursor = '';
      overlay.hideHover();
      overlay.hideRegionBox();
      regionStart = null;
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (!altDown) return;
    if (regionStart) {
      overlay.showRegionBox(regionStart.x, regionStart.y, e.clientX, e.clientY);
      return;
    }
    const target = e.target as Element | null;
    if (target && target.nodeType === 1) {
      const sel = uniqueSelector(target);
      overlay.showHover(target, sel);
    }
  }, true);

  document.addEventListener('mousedown', (e) => {
    if (!altDown || e.button !== 0) return;
    if (e.shiftKey) return;
    regionStart = { x: e.clientX, y: e.clientY };
  }, true);

  document.addEventListener('mouseup', async (e) => {
    if (!altDown) { regionStart = null; return; }
    if (regionStart) {
      const dx = Math.abs(e.clientX - regionStart.x);
      const dy = Math.abs(e.clientY - regionStart.y);
      if (dx > 5 || dy > 5) {
        await emitRegion(dispatcher, regionStart, { x: e.clientX, y: e.clientY });
        regionStart = null;
        overlay.hideRegionBox();
        e.preventDefault(); e.stopPropagation();
        return;
      }
    }
    regionStart = null;
  }, true);

  document.addEventListener('click', async (e) => {
    if (!altDown) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.target as Element;
    await emitPointer(dispatcher, el);
  }, true);
}

async function emitPointer(dispatcher: Dispatcher, el: Element): Promise<void> {
  const r = el.getBoundingClientRect();
  const styles = filterComputedStyles(window.getComputedStyle(el));
  const [screenshot, sourceLocation] = await Promise.all([
    captureElementScreenshot(el, 20),
    lookupSourceLocation(el),
  ]);
  const ancestors: Array<any> = [];
  let cur = el.parentElement;
  while (cur && cur !== document.body.parentElement) {
    ancestors.push({
      tagName: cur.tagName.toLowerCase(),
      id: cur.id || null,
      classes: Array.from(cur.classList),
      cssSelector: uniqueSelector(cur),
    });
    cur = cur.parentElement;
  }
  const dataAttributes: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith('data-')) dataAttributes[attr.name] = attr.value;
  }
  dispatcher.send({
    type: 'pointer',
    timestamp: Date.now(),
    url: window.location.href,
    payload: {
      tagName: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: Array.from(el.classList),
      dataAttributes,
      outerHTML: (el.outerHTML || '').slice(0, 5000),
      cssSelector: uniqueSelector(el),
      boundingBox: { x: r.left, y: r.top, width: r.width, height: r.height },
      textContent: (el.textContent || '').slice(0, 500),
      computedStyles: styles,
      screenshotDataUrl: screenshot,
      sourceLocation,
      ancestors,
    },
  });
}

async function emitRegion(
  dispatcher: Dispatcher,
  start: { x: number; y: number },
  end: { x: number; y: number }
): Promise<void> {
  const x = Math.min(start.x, end.x), y = Math.min(start.y, end.y);
  const w = Math.abs(end.x - start.x), h = Math.abs(end.y - start.y);
  const enclosed: Element[] = [];
  document.querySelectorAll('*').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.left >= x && r.top >= y && r.right <= x + w && r.bottom <= y + h) enclosed.push(el);
  });
  const anchor = enclosed[0];
  if (!anchor) return;
  await emitPointer(dispatcher, anchor);
}
