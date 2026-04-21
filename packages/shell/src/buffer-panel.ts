interface BufferItem {
  id: string;
  label: string;
  kind: 'element' | 'region';
  url: string;
  pathname: string;
  selector: string;
  textPreview: string;
}

export interface BufferPanelOptions {
  panel: HTMLElement;
  chipsEl: HTMLElement;
  sendBtn: HTMLElement;
  clearBtn: HTMLElement;
}

/**
 * Multi-select chip panel above the terminal.
 *
 * Connects to the companion WS to receive buffer-update broadcasts
 * (single source of truth lives on the daemon). Renders one chip per
 * buffered selection. Chip actions map back to server events:
 *   - click chip        → highlight in iframe (pulse the element)
 *   - x on chip         → remove-selection
 *   - "Send" button     → send-selections (programmatic Enter in claude)
 *   - "Clear" button    → clear-selection (same effect as Esc in iframe)
 *
 * Panel hides itself when the buffer is empty (is-empty class).
 */
export function initBufferPanel(opts: BufferPanelOptions): void {
  const { panel, chipsEl, sendBtn, clearBtn } = opts;

  // Small reconnect loop so shell survives a daemon restart.
  let ws: WebSocket | null = null;
  let reconnectMs = 1000;
  function connect(): void {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${window.location.host}/_companion/ws`);
    ws = socket;
    socket.addEventListener('open', () => { reconnectMs = 1000; });
    socket.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === 'buffer-update') render(msg.items ?? []);
      } catch { /* ignore malformed */ }
    });
    socket.addEventListener('close', () => {
      ws = null;
      setTimeout(connect, reconnectMs);
      reconnectMs = Math.min(reconnectMs * 2, 15_000);
    });
    socket.addEventListener('error', () => socket.close());
  }
  function sendRaw(payload: any): void {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ timestamp: Date.now(), ...payload }));
    }
  }

  function render(items: BufferItem[]): void {
    panel.classList.toggle('is-empty', items.length === 0);
    chipsEl.innerHTML = '';
    for (const item of items) {
      const chip = document.createElement('div');
      chip.className = `buffer-chip kind-${item.kind}`;
      chip.title = `${item.selector} · ${item.pathname}${item.textPreview ? ' — "' + item.textPreview + '"' : ''}`;

      const dot = document.createElement('span'); dot.className = 'dot';
      const label = document.createElement('span'); label.className = 'label'; label.textContent = item.label;
      const sel = document.createElement('span'); sel.className = 'sel';
      sel.textContent = shortSelector(item.selector);
      const x = document.createElement('span'); x.className = 'x'; x.textContent = '×';
      x.title = 'Remove';

      chip.append(dot, label, sel, x);

      chip.addEventListener('click', (ev) => {
        if (ev.target === x) return;
        // Scroll the element into view and pulse it — confirms to
        // the user which chip maps to which element on the page,
        // especially useful with many picks. Uses the same HTTP
        // endpoint the MCP server calls for highlight_element.
        void fetch('/_companion/mcp/highlight_element', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ selector: item.selector, duration_ms: 900 }),
        });
      });
      x.addEventListener('click', (ev) => {
        ev.stopPropagation();
        sendRaw({ type: 'remove-selection', payload: { id: item.id } });
      });

      chipsEl.appendChild(chip);
    }
  }

  sendBtn.addEventListener('click', () => {
    sendRaw({ type: 'send-selections' });
  });
  clearBtn.addEventListener('click', () => {
    sendRaw({ type: 'clear-selection' });
  });

  connect();
}

function shortSelector(s: string): string {
  if (s.length <= 48) return s;
  return '…' + s.slice(-46);
}
