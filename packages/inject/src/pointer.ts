import type { Dispatcher } from './dispatcher';
import type { Overlay } from './overlay';
import { uniqueSelector } from './selector-gen';
import { filterComputedStyles } from './style-filter';
import { captureElementScreenshot } from './screenshot';
import { lookupSourceLocation } from './source-map';

export function installPointer(dispatcher: Dispatcher, overlay: Overlay): void {
  // Alt+Shift (not plain Alt) because on Mac Alt alone is used for
  // special characters — Alt+L types "@" on a German layout — and
  // having the picker activate on every Alt press swallowed clicks
  // and swapped the cursor while the user was just typing.
  let pickingActive = false;
  let regionStart: { x: number; y: number } | null = null;

  function refreshMode(e: KeyboardEvent): void {
    const shouldBeActive = e.altKey && e.shiftKey;
    if (shouldBeActive && !pickingActive) {
      pickingActive = true;
      document.body.style.cursor = 'crosshair';
      // Block native text-selection while picking so region drags
      // don't also highlight text on the page.
      document.body.style.userSelect = 'none';
      (document.body.style as any).webkitUserSelect = 'none';
      // Clear any already-selected text from before picking started.
      window.getSelection()?.removeAllRanges();
    } else if (!shouldBeActive && pickingActive) {
      pickingActive = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      (document.body.style as any).webkitUserSelect = '';
      overlay.hideHover();
      overlay.hideRegionBox();
      regionStart = null;
    }
  }
  document.addEventListener('keydown', refreshMode);
  document.addEventListener('keyup', refreshMode);

  // Belt-and-braces: prevent any selectstart while picking is active
  // (covers edge cases where the style reset didn't propagate).
  document.addEventListener('selectstart', (e) => {
    if (pickingActive) e.preventDefault();
  }, true);

  document.addEventListener('mousemove', (e) => {
    if (!pickingActive) return;
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
    if (!pickingActive || e.button !== 0) return;
    // Swallow the mousedown so the browser doesn't start its own
    // text-selection drag underneath our region box.
    e.preventDefault();
    regionStart = { x: e.clientX, y: e.clientY };
  }, true);

  document.addEventListener('mouseup', async (e) => {
    if (!pickingActive) { regionStart = null; return; }
    if (regionStart) {
      const dx = Math.abs(e.clientX - regionStart.x);
      const dy = Math.abs(e.clientY - regionStart.y);
      if (dx > 5 || dy > 5) {
        const start = regionStart;
        const end = { x: e.clientX, y: e.clientY };
        await emitRegion(dispatcher, start, end);
        const x = Math.min(start.x, end.x), y = Math.min(start.y, end.y);
        const w = Math.abs(end.x - start.x), h = Math.abs(end.y - start.y);
        overlay.showSelectedRegion(x, y, w, h);
        regionStart = null;
        overlay.hideRegionBox();
        e.preventDefault(); e.stopPropagation();
        return;
      }
    }
    regionStart = null;
  }, true);

  document.addEventListener('click', async (e) => {
    if (!pickingActive) return;
    e.preventDefault(); e.stopPropagation();
    const el = e.target as Element;
    const sel = uniqueSelector(el);
    // Hide the live hover frame and the in-progress region box as soon as
    // we commit a click — otherwise the user sees hover + selected at
    // the same time and it looks like we've selected two things.
    overlay.hideHover();
    overlay.hideRegionBox();
    overlay.showSelected(el, sel);
    await emitPointer(dispatcher, el);
  }, true);

  // Escape clears the persistent selection so the user can reset without
  // having to click an empty spot. Also tells the server to drop the
  // sticky pending prefix, so claude won't keep referencing a selection
  // the user has explicitly dismissed.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      overlay.hideSelected();
      overlay.hideSelectedRegion();
      dispatcher.sendRaw({ type: 'clear-selection', timestamp: Date.now() });
    }
  });
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
