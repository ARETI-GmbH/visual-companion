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
  // Set briefly after a region-drag so the synthetic click that the
  // browser fires right after mouseup doesn't ALSO trigger an element
  // pick (which would add the body/root element on top of the region,
  // making every drag produce two buffer entries — the "body is
  // selected after drag" bug users saw).
  let suppressNextClick = false;

  function setPicking(alt: boolean, shift: boolean): void {
    const shouldBeActive = alt && shift;
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
  // Keyboard events only reach the iframe while the iframe has focus.
  // If the user was typing in claude's terminal and then moves the
  // mouse over the iframe with Alt+Shift already held, keydown never
  // fired on us — so picking wouldn't activate until they clicked.
  // MouseEvents carry altKey/shiftKey too, so we also sync from
  // mousemove: hovering into the iframe with the modifiers held
  // flips us into picking mode immediately. Cheap (same state
  // transitions as keyboard path).
  document.addEventListener('keydown', (e) => setPicking(e.altKey, e.shiftKey));
  document.addEventListener('keyup', (e) => setPicking(e.altKey, e.shiftKey));
  document.addEventListener('mousemove', (e) => setPicking(e.altKey, e.shiftKey), true);
  document.addEventListener('mouseenter', (e) => setPicking(e.altKey, e.shiftKey));

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

  document.addEventListener('mouseup', (e) => {
    if (!pickingActive) { regionStart = null; return; }
    if (regionStart) {
      const dx = Math.abs(e.clientX - regionStart.x);
      const dy = Math.abs(e.clientY - regionStart.y);
      if (dx > 5 || dy > 5) {
        const start = regionStart;
        const end = { x: e.clientX, y: e.clientY };
        regionStart = null;
        overlay.hideRegionBox();
        // Critical ordering: set suppressNextClick BEFORE we kick
        // off emitRegion. emitRegion awaits screenshot capture +
        // source-map lookup (hundreds of ms); meanwhile the browser
        // is about to fire the post-mouseup `click` synchronously.
        // Previously the flag was set after await, so the click
        // handler saw suppressNextClick=false and the drag would
        // ALSO produce an element pick — that's the "body selected
        // on every drag" bug users kept hitting.
        suppressNextClick = true;
        setTimeout(() => { suppressNextClick = false; }, 500);
        e.preventDefault(); e.stopPropagation();
        // Picking IS user intent to see overlays. Local-hint: force
        // the idle state so the new frame shows immediately, even
        // if the server is still reporting busy (e.g. claude's
        // stream hasn't fallen silent yet). If the server later
        // still says busy, we'll follow; but the user sees their
        // fresh pick without the 1.5 s idle-debounce delay.
        overlay.setBusy(false);
        void emitRegion(dispatcher, start, end);
        return;
      }
    }
    regionStart = null;
  }, true);

  document.addEventListener('click', async (e) => {
    if (!pickingActive) return;
    e.preventDefault(); e.stopPropagation();
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    const el = e.target as Element;
    // Hide the live hover frame as soon as we commit a click —
    // otherwise hover + selected show at the same time and it looks
    // like we've selected two things. The actual selected frame
    // comes back through the buffer-update broadcast.
    overlay.hideHover();
    overlay.hideRegionBox();
    overlay.setBusy(false); // user interaction → show overlays now
    await emitPointer(dispatcher, el, 'element');
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
      kind,
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
      ...(regionRect ? { regionRect } : {}),
    },
  });
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
