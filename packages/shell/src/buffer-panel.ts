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
}

/**
 * Multi-select chip list above the terminal.
 *
 * Connects to the companion WS to receive buffer-update broadcasts
 * (server is the single source of truth). Renders one row per pick.
 * Actions map back to server events:
 *   - click chip body      → highlight the element in the iframe
 *   - double-click label   → rename (custom name shown in claude's prefix)
 *   - click ×              → remove-selection
 * Esc in the iframe clears everything (no clear button in the panel —
 * Esc is one keystroke and the chips already carry ×). "Send" was also
 * removed: the sticky prefix already piggybacks on the next Enter the
 * user hits in claude's prompt, so a dedicated button was redundant.
 */
export function initBufferPanel(opts: BufferPanelOptions): void {
  const { panel, chipsEl } = opts;

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

  function startRename(labelEl: HTMLElement, item: BufferItem): void {
    if (labelEl.classList.contains('editing')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = item.label;
    input.className = 'label editing';
    input.size = Math.max(item.label.length, 8);
    labelEl.replaceWith(input);
    input.focus();
    input.select();

    let committed = false;
    const commit = (save: boolean): void => {
      if (committed) return;
      committed = true;
      if (save) {
        const next = input.value.trim() || item.label;
        if (next !== item.label) {
          sendRaw({ type: 'rename-selection', payload: { id: item.id, label: next } });
        }
      }
      // The buffer-update broadcast from server will rerender; until
      // then, swap the input back for a plain span so the UI doesn't
      // look stuck on the old in-progress value.
      const span = document.createElement('span');
      span.className = 'label';
      span.textContent = save ? (input.value.trim() || item.label) : item.label;
      span.title = 'Doppelklick zum Umbenennen';
      input.replaceWith(span);
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', () => commit(true));
  }

  function render(items: BufferItem[]): void {
    panel.classList.toggle('is-empty', items.length === 0);
    chipsEl.innerHTML = '';
    for (const item of items) {
      const chip = document.createElement('div');
      chip.className = `buffer-chip kind-${item.kind}`;
      chip.title = `${item.selector} · ${item.pathname}${item.textPreview ? ' — "' + item.textPreview + '"' : ''}`;

      const dot = document.createElement('span'); dot.className = 'dot';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = item.label;
      label.title = 'Doppelklick zum Umbenennen';
      const sel = document.createElement('span'); sel.className = 'sel';
      sel.textContent = shortSelector(item.selector);
      const x = document.createElement('span'); x.className = 'x'; x.textContent = '×';
      x.title = 'Entfernen';

      chip.append(dot, label, sel, x);

      chip.addEventListener('click', (ev) => {
        if (ev.target === x) return;
        if (ev.target === label) return; // label reserved for dblclick rename
        if ((ev.target as HTMLElement).classList?.contains('editing')) return;
        // Pulse the element in the iframe so user can map chip → element.
        void fetch('/_companion/mcp/highlight_element', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ selector: item.selector, duration_ms: 900 }),
        });
      });
      label.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        startRename(label, item);
      });
      x.addEventListener('click', (ev) => {
        ev.stopPropagation();
        sendRaw({ type: 'remove-selection', payload: { id: item.id } });
      });

      chipsEl.appendChild(chip);
    }
  }

  connect();
}

function shortSelector(s: string): string {
  if (s.length <= 60) return s;
  return '…' + s.slice(-58);
}
