export interface SelectionBadgeOptions {
  container: HTMLElement;
}

interface SelectionUpdate {
  type: 'selection-update';
  selector: string;
  url: string;
  pathname: string;
  width: number;
  height: number;
  text: string;
}

/**
 * Listens on /_companion/ws for pointer broadcasts from the daemon and
 * renders them into the in-shell badge (NOT into xterm, which would shift
 * claude's TUI prompt out of place). The badge is the user-visible proof
 * that Alt+Click worked; claude itself picks up the details via MCP.
 */
export function initSelectionBadge(opts: SelectionBadgeOptions): void {
  const { container } = opts;
  let ws: WebSocket | null = null;
  let reconnectMs = 1000;

  function render(u: SelectionUpdate): void {
    container.innerHTML = `
      <div class="row">
        <span class="pin">📍</span>
        <span class="selector">${escape(u.selector)}</span>
        <button class="close" title="dismiss">×</button>
      </div>
      <div class="meta">${u.width}×${u.height}px · ${escape(u.pathname || '/')}</div>
      ${u.text ? `<div class="text">"${escape(u.text)}"</div>` : ''}
    `;
    container.style.display = '';
    const closeBtn = container.querySelector('.close') as HTMLButtonElement | null;
    closeBtn?.addEventListener('click', () => {
      container.style.display = 'none';
    });
  }

  function connect(): void {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${scheme}://${window.location.host}/_companion/ws`);
    ws.addEventListener('open', () => { reconnectMs = 1000; });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === 'selection-update') render(msg as SelectionUpdate);
      } catch {
        // ignore malformed
      }
    });
    ws.addEventListener('close', () => {
      setTimeout(connect, reconnectMs);
      reconnectMs = Math.min(reconnectMs * 2, 30_000);
    });
    ws.addEventListener('error', () => ws?.close());
  }
  connect();
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c),
  );
}
