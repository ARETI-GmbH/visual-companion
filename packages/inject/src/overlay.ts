export interface BufferItem {
  id: string;
  label: string;
  kind: 'element' | 'region';
  url: string;
  pathname: string;
  selector: string;
  textPreview: string;
}

export interface Overlay {
  showHover(el: Element, selector: string): void;
  hideHover(): void;
  pulseHighlight(selector: string, durationMs: number): void;
  showRegionBox(startX: number, startY: number, endX: number, endY: number): void;
  hideRegionBox(): void;
  /**
   * Reconcile the visible selection frames with the server-authoritative
   * buffer. Called on every `buffer-update` WS message AND after SPA
   * navigation. For each item whose URL matches the current iframe URL,
   * we resolve the selector and show a labelled frame; items on other
   * pages are kept in state but hidden — they'll auto-re-show when the
   * user navigates back.
   */
  setSelections(items: BufferItem[]): void;
  /** Re-run selector lookups against the current document. Call this
   *  after navigation or DOM-ready so frames re-attach on the new page. */
  refresh(): void;
}

export function createOverlay(): Overlay {
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    .hover { position:fixed; outline:2px solid #f59e0b; background:rgba(245,158,11,0.08); pointer-events:none; transition:all 0.08s }
    .hover .label { position:absolute; top:-18px; left:0; background:#f59e0b; color:#fff; font:600 10px/1.2 -apple-system,system-ui; padding:2px 6px; border-radius:3px; white-space:nowrap }
    .pulse { position:fixed; outline:3px solid #f59e0b; box-shadow:0 0 0 6px rgba(245,158,11,0.3); pointer-events:none; animation: pulse 0.26s ease-in-out 3 }
    @keyframes pulse { 0%,100% { box-shadow: 0 0 0 6px rgba(245,158,11,0.3) } 50% { box-shadow: 0 0 0 14px rgba(245,158,11,0.05) } }
    .region { position:fixed; border:2px dashed #3b82f6; background:rgba(59,130,246,0.08); pointer-events:none }
    .sel-frame { position:fixed; pointer-events:none; box-sizing:border-box }
    .sel-frame.sel-element { outline:2px solid #f59e0b; outline-offset:1px; background:rgba(245,158,11,0.10); box-shadow:0 0 0 1px rgba(245,158,11,0.35) }
    .sel-frame.sel-region { border:2px dashed #3b82f6; background:rgba(59,130,246,0.10) }
    .sel-frame .label { position:absolute; top:-18px; left:0; font:600 10px/1.2 -apple-system,system-ui; padding:2px 6px; border-radius:3px; white-space:nowrap }
    .sel-frame.sel-element .label { background:#f59e0b; color:#fff }
    .sel-frame.sel-region .label { background:#3b82f6; color:#fff }
  `;
  shadow.appendChild(styleEl);
  const hover = el('div', 'hover'); hover.style.display = 'none';
  const hoverLabel = el('span', 'label');
  hover.appendChild(hoverLabel);
  const pulse = el('div', 'pulse'); pulse.style.display = 'none';
  const region = el('div', 'region'); region.style.display = 'none';
  shadow.append(hover, pulse, region);

  interface FrameState {
    item: BufferItem;
    frameEl: HTMLElement;
    labelEl: HTMLElement;
    element: Element | null;
  }
  const frames = new Map<string, FrameState>();

  // rAF-throttled reposition: the scroll/resize listeners schedule at
  // most one layout-measure per frame, which kept the iframe's native
  // animations smooth even with N frames attached.
  let scheduled = false;
  function scheduleReposition(): void {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      reposition();
    });
  }
  function reposition(): void {
    for (const state of frames.values()) {
      if (!state.element || !state.element.isConnected) {
        state.frameEl.style.display = 'none';
        continue;
      }
      const r = state.element.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        state.frameEl.style.display = 'none';
        continue;
      }
      Object.assign(state.frameEl.style, {
        display: 'block',
        top: r.top + 'px',
        left: r.left + 'px',
        width: r.width + 'px',
        height: r.height + 'px',
      });
    }
  }
  window.addEventListener('scroll', scheduleReposition, { capture: true, passive: true });
  window.addEventListener('resize', scheduleReposition, { passive: true });

  function pageKeyOf(urlStr: string): string {
    try {
      const u = new URL(urlStr, window.location.href);
      return u.origin + u.pathname + u.search;
    } catch {
      return urlStr;
    }
  }
  function currentPageKey(): string {
    return window.location.origin + window.location.pathname + window.location.search;
  }

  function resolveElement(item: BufferItem): Element | null {
    if (pageKeyOf(item.url) !== currentPageKey()) return null;
    try {
      return document.querySelector(item.selector);
    } catch {
      return null; // invalid selector after page-structure change
    }
  }

  return {
    showHover(element, selector) {
      const r = element.getBoundingClientRect();
      Object.assign(hover.style, {
        display: 'block', top: r.top + 'px', left: r.left + 'px',
        width: r.width + 'px', height: r.height + 'px',
      });
      hoverLabel.textContent = selector;
    },
    hideHover() { hover.style.display = 'none'; },
    pulseHighlight(selector, durationMs) {
      let node: Element | null = null;
      try { node = document.querySelector(selector); } catch {}
      if (!node) return;
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const r = node.getBoundingClientRect();
      Object.assign(pulse.style, {
        display: 'block', top: r.top + 'px', left: r.left + 'px',
        width: r.width + 'px', height: r.height + 'px',
      });
      setTimeout(() => { pulse.style.display = 'none'; }, durationMs);
    },
    showRegionBox(sx, sy, ex, ey) {
      const x = Math.min(sx, ex), y = Math.min(sy, ey);
      const w = Math.abs(ex - sx), h = Math.abs(ey - sy);
      Object.assign(region.style, { display: 'block', top: y + 'px', left: x + 'px', width: w + 'px', height: h + 'px' });
    },
    hideRegionBox() { region.style.display = 'none'; },
    setSelections(items) {
      // Drop frames for removed items.
      const keep = new Set(items.map((i) => i.id));
      for (const [id, state] of frames) {
        if (!keep.has(id)) {
          state.frameEl.remove();
          frames.delete(id);
        }
      }
      // Add or update frames for current items.
      for (const item of items) {
        let state = frames.get(item.id);
        if (!state) {
          const frameEl = el('div', 'sel-frame');
          frameEl.classList.add(item.kind === 'region' ? 'sel-region' : 'sel-element');
          const labelEl = el('span', 'label');
          labelEl.textContent = item.label;
          frameEl.appendChild(labelEl);
          shadow.appendChild(frameEl);
          state = { item, frameEl, labelEl, element: null };
          frames.set(item.id, state);
        } else {
          state.item = item;
          state.labelEl.textContent = item.label;
        }
        state.element = resolveElement(item);
      }
      scheduleReposition();
    },
    refresh() {
      for (const state of frames.values()) {
        state.element = resolveElement(state.item);
      }
      scheduleReposition();
    },
  };
}

function el(tag: string, cls: string): HTMLElement {
  const x = document.createElement(tag);
  x.className = cls;
  return x;
}
