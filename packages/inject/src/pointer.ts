import type { Dispatcher } from './dispatcher';
import type { Overlay } from './overlay';
import { uniqueSelector } from './selector-gen';
import { filterComputedStyles } from './style-filter';
import { captureElementScreenshot } from './screenshot';
import { lookupSourceLocation } from './source-map';

export function installPointer(dispatcher: Dispatcher, overlay: Overlay): void {
  // Cmd (metaKey) alone because on Mac:
  //   - Cmd has no default OS action when held by itself
  //   - Cmd combos (Cmd+C, Cmd+V, Cmd+A) only fire on a letter
  //     keypress, and typically AFTER the user has already made a
  //     selection — so the "picker mode while holding Cmd" window
  //     doesn't collide with normal keyboard use
  //   - Alt on Mac is needed for special chars (Alt+L = "@" on DE
  //     layout), which made Alt-based activation disruptive
  let pickingActive = false;
  let regionStart: { x: number; y: number } | null = null;
  // Set briefly after a region-drag so the synthetic click that the
  // browser fires right after mouseup doesn't ALSO trigger an element
  // pick (which would add the body/root element on top of the region,
  // making every drag produce two buffer entries — the "body is
  // selected after drag" bug users saw).
  let suppressNextClick = false;

  function setPicking(meta: boolean): void {
    const shouldBeActive = meta;
    if (shouldBeActive && !pickingActive) {
      pickingActive = true;
      document.body.style.cursor = 'crosshair';
      // Prevent NEW text selection while picking — region drags
      // otherwise also select text. Does NOT clear existing
      // selections: the user might be holding Cmd to type Cmd+C
      // on already-selected text, and zapping their selection
      // would silently break copy.
      document.body.style.userSelect = 'none';
      (document.body.style as any).webkitUserSelect = 'none';
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
  // Keyboard events only reach the iframe while the iframe has focus.
  // If the user was typing in claude's terminal and then moves the
  // mouse over the iframe with Cmd already held, keydown never fired
  // on us — so picking wouldn't activate until they clicked.
  // MouseEvents carry metaKey too, so we also sync from mousemove:
  // hovering into the iframe with Cmd held flips us into picking
  // mode immediately. Cheap (same state transitions as keyboard path).
  document.addEventListener('keydown', (e) => setPicking(e.metaKey));
  document.addEventListener('keyup', (e) => setPicking(e.metaKey));
  document.addEventListener('mousemove', (e) => setPicking(e.metaKey), true);
  document.addEventListener('mouseenter', (e) => setPicking(e.metaKey));

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
    // Clear any existing text selection — at THIS point the user has
    // committed to a pick (mouse is going down inside the iframe with
    // Cmd held), so whatever text they had highlighted before can be
    // dropped. Doing this on mousedown instead of modifier-down keeps
    // Cmd+C-on-selected-text working.
    window.getSelection()?.removeAllRanges();
    // Swallow the mousedown so the browser doesn't start its own
    // text-selection drag underneath our region box.
    e.preventDefault();
    regionStart = { x: e.clientX, y: e.clientY };
  }, true);

  document.addEventListener('mouseup', (e) => {
    if (!pickingActive) { regionStart = null; return; }
    if (!regionStart) return;
    const dx = Math.abs(e.clientX - regionStart.x);
    const dy = Math.abs(e.clientY - regionStart.y);
    if (dx > 5 || dy > 5) {
      // --- region drag path ---
      const start = regionStart;
      const end = { x: e.clientX, y: e.clientY };
      regionStart = null;
      overlay.hideRegionBox();
      suppressNextClick = true;
      setTimeout(() => { suppressNextClick = false; }, 500);
      e.preventDefault(); e.stopPropagation();
      overlay.setBusy(false);
      void emitRegion(dispatcher, start, end);
      return;
    }
    // --- element pick path ---
    // Emit the pick here on mouseup instead of the click event.
    // Chrome-on-Mac sometimes swallows or re-routes the click event
    // for modifier-click gestures (Cmd+Click on links = "open in
    // new tab"; Cmd+Click on some inputs/buttons goes through
    // native handlers before firing click). Multi-select was
    // "sometimes not registering" exactly because of this — picking
    // on mouseup is identical from the user's perspective but
    // reliable regardless of what Chrome does with the click.
    const el = e.target as Element;
    regionStart = null;
    overlay.hideHover();
    overlay.hideRegionBox();
    // Suppress the native click too so links don't open new tabs
    // and buttons don't trigger their defaults while we're picking.
    suppressNextClick = true;
    setTimeout(() => { suppressNextClick = false; }, 500);
    e.preventDefault(); e.stopPropagation();
    overlay.setBusy(false);
    void emitPointer(dispatcher, el, 'element');
  }, true);

  // Safety net: if a click somehow fires while picking is active
  // (e.g. on platforms where mouseup → click behaves differently),
  // swallow it so the app underneath doesn't receive a stray click
  // at the picker target. The real pick is already in flight from
  // mouseup above.
  document.addEventListener('click', (e) => {
    if (!pickingActive) return;
    e.preventDefault(); e.stopPropagation();
    if (suppressNextClick) suppressNextClick = false;
  }, true);

  // Escape clears the entire multi-select buffer server-side. The
  // buffer-update broadcast that follows wipes all on-screen frames.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      dispatcher.sendRaw({ type: 'clear-selection', timestamp: Date.now() });
    }
  });
}

async function emitPointer(
  dispatcher: Dispatcher,
  el: Element,
  kind: 'element' | 'region',
  regionRect?: { x: number; y: number; w: number; h: number },
): Promise<void> {
  const r = el.getBoundingClientRect();
  const styles = filterComputedStyles(window.getComputedStyle(el));
  // source-map lookup is a few sync property reads through React's
  // __reactFiber debug hook — cheap, include in the base event.
  const sourceLocation = await lookupSourceLocation(el);
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
  const cssSelector = uniqueSelector(el);
  // Fire the pointer event IMMEDIATELY with a null screenshot. The
  // chip in the shell panel only needs selector + label + kind +
  // pathname — all present here. html2canvas is expensive (~0.5–1.5 s
  // on complex pages) and blocking on it made the chip appear long
  // after the click. We enrich the buffer entry with the screenshot
  // asynchronously below once html2canvas finishes.
  dispatcher.send({
    type: 'pointer',
    timestamp: Date.now(),
    url: window.location.href,
    payload: {
      kind,
      tagName: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: Array.from(el.classList),
      dataAttributes,
      outerHTML: (el.outerHTML || '').slice(0, 5000),
      cssSelector,
      boundingBox: { x: r.left, y: r.top, width: r.width, height: r.height },
      textContent: (el.textContent || '').slice(0, 500),
      computedStyles: styles,
      screenshotDataUrl: null,
      sourceLocation,
      ancestors,
      ...(regionRect ? { regionRect } : {}),
    },
  });

  // Background enrichment: once html2canvas delivers, patch the
  // freshly-added buffer entry with the screenshot so
  // get_pointed_element returns it on subsequent claude calls.
  // If claude calls the tool before this resolves it just gets
  // null for the screenshot — the rest of the payload is already
  // there.
  captureElementScreenshot(el, 20)
    .then((screenshot) => {
      if (!screenshot) return;
      dispatcher.sendRaw({
        type: 'pointer-enrich',
        timestamp: Date.now(),
        url: window.location.href,
        payload: { cssSelector, screenshotDataUrl: screenshot },
      });
    })
    .catch(() => {});
}

async function emitRegion(
  dispatcher: Dispatcher,
  start: { x: number; y: number },
  end: { x: number; y: number }
): Promise<void> {
  // Viewport coords of the drawn rectangle.
  const vx = Math.min(start.x, end.x), vy = Math.min(start.y, end.y);
  const vw = Math.abs(end.x - start.x), vh = Math.abs(end.y - start.y);
  // Pick the smallest ancestor that fully contains the drawn rect,
  // starting from the element at the rectangle's centre. That's the
  // natural "this thing" for claude (usually a wrapper div), and
  // always beats querySelectorAll('*') DOM-order which returned a
  // tiny element near the top-left that happened to be fully
  // enclosed (e.g. an inner span), so the visible frame looked
  // totally wrong compared to what the user drew.
  const cx = vx + vw / 2, cy = vy + vh / 2;
  let anchor: Element | null = document.elementFromPoint(cx, cy);
  while (anchor) {
    const r = anchor.getBoundingClientRect();
    if (r.left <= vx && r.top <= vy && r.right >= vx + vw && r.bottom >= vy + vh) break;
    anchor = anchor.parentElement;
  }
  if (!anchor) anchor = document.body;
  // Store the rectangle in document coords so scrolling after the
  // pick doesn't shift where the frame renders.
  const regionRect = {
    x: vx + window.scrollX,
    y: vy + window.scrollY,
    w: vw,
    h: vh,
  };
  await emitPointer(dispatcher, anchor, 'region', regionRect);
}
