import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';

export function initTerminal(opts: { container: HTMLElement }): void {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: 'SF Mono, Menlo, Consolas, monospace',
    fontSize: 13,
    scrollback: 10_000,
    theme: {
      background: '#0f172a',
      foreground: '#e2e8f0',
      cursor: '#fbbf24',
      selectionBackground: '#334155',
    },
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon());
  term.open(opts.container);
  fitAddon.fit();
  term.focus();
  opts.container.addEventListener('click', () => term.focus());

  // Refit whenever the container's size changes — not just on window
  // resize. The right pane's height shifts every time the selection-
  // buffer chip panel appears or grows, and when the user drags the
  // divider. Without this, xterm kept its old row count and the
  // input line slid below the visible area mid-reply.
  const ro = new ResizeObserver(() => {
    try { fitAddon.fit(); } catch { /* xterm not yet laid out */ }
  });
  ro.observe(opts.container);

  const ws = new WebSocket(`ws://${window.location.host}/_companion/pty`);
  ws.addEventListener('open', () => {
    term.write('\x1b[90mConnecting to claude...\x1b[0m\r\n');
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  });
  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === 'data') term.write(msg.data);
      if (msg.type === 'exit') term.write(`\r\n\x1b[90mSession ended (code ${msg.exitCode}). Press Enter to restart.\x1b[0m\r\n`);
    } catch {}
  });
  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'data', data }));
  });
  term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  });
  window.addEventListener('resize', () => fitAddon.fit());
}
