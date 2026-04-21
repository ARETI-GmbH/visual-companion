export interface Overlay {
  showHover(el: Element, selector: string): void;
  hideHover(): void;
  pulseHighlight(selector: string, durationMs: number): void;
  showRegionBox(startX: number, startY: number, endX: number, endY: number): void;
  hideRegionBox(): void;
}

export function createOverlay(): Overlay {
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .hover { position:fixed; outline:2px solid #f59e0b; background:rgba(245,158,11,0.08); pointer-events:none; transition:all 0.08s }
      .hover .label { position:absolute; top:-18px; left:0; background:#f59e0b; color:#fff; font:600 10px/1.2 -apple-system,system-ui; padding:2px 6px; border-radius:3px; white-space:nowrap }
      .pulse { position:fixed; outline:3px solid #f59e0b; box-shadow:0 0 0 6px rgba(245,158,11,0.3); pointer-events:none; animation: pulse 0.26s ease-in-out 3 }
      @keyframes pulse { 0%,100% { box-shadow: 0 0 0 6px rgba(245,158,11,0.3) } 50% { box-shadow: 0 0 0 14px rgba(245,158,11,0.05) } }
      .region { position:fixed; border:2px dashed #3b82f6; background:rgba(59,130,246,0.08); pointer-events:none }
    </style>
    <div class="hover" style="display:none"><span class="label"></span></div>
    <div class="pulse" style="display:none"></div>
    <div class="region" style="display:none"></div>
  `;
  const hover = shadow.querySelector('.hover') as HTMLElement;
  const hoverLabel = shadow.querySelector('.hover .label') as HTMLElement;
  const pulse = shadow.querySelector('.pulse') as HTMLElement;
  const region = shadow.querySelector('.region') as HTMLElement;

  return {
    showHover(el, selector) {
      const r = el.getBoundingClientRect();
      Object.assign(hover.style, {
        display: 'block', top: r.top + 'px', left: r.left + 'px',
        width: r.width + 'px', height: r.height + 'px',
      });
      hoverLabel.textContent = selector;
    },
    hideHover() { hover.style.display = 'none'; },
    pulseHighlight(selector, durationMs) {
      const el = document.querySelector(selector);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const r = el.getBoundingClientRect();
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
  };
}
