import { initTerminal } from './terminal';
import { initIframe } from './iframe';
import { initBufferPanel } from './buffer-panel';

const iframe = document.getElementById('app-frame') as HTMLIFrameElement;
const urlInput = document.getElementById('url-input') as HTMLInputElement;
const reloadBtn = document.getElementById('btn-reload')!;
const devtoolsBtn = document.getElementById('btn-devtools')!;
const backBtn = document.getElementById('btn-back') ?? undefined;
const forwardBtn = document.getElementById('btn-forward') ?? undefined;
const divider = document.getElementById('divider')!;
const main = document.querySelector('.main') as HTMLElement;
const leftPane = document.querySelector('.pane-left') as HTMLElement;

const config = new URLSearchParams(window.location.search);
const targetUrl = config.get('target') ?? '/';

initIframe({ iframe, urlInput, reloadBtn, devtoolsBtn, backBtn, forwardBtn, targetUrl });
initTerminal({ container: document.getElementById('terminal')! });
initBufferPanel({
  panel: document.getElementById('buffer-panel')!,
  chipsEl: document.getElementById('buffer-chips')!,
  sendBtn: document.getElementById('btn-send-selections')!,
  clearBtn: document.getElementById('btn-clear-selections')!,
});

// Draggable divider
let dragging = false;
divider.addEventListener('mousedown', () => { dragging = true; document.body.style.cursor = 'col-resize'; });
document.addEventListener('mouseup', () => { dragging = false; document.body.style.cursor = ''; });
document.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const rect = main.getBoundingClientRect();
  const leftPercent = ((e.clientX - rect.left) / rect.width) * 100;
  const clamped = Math.max(25, Math.min(75, leftPercent));
  leftPane.style.flex = `${clamped} 0 0`;
  const rightPane = document.querySelector('.pane-right') as HTMLElement;
  rightPane.style.flex = `${100 - clamped} 0 0`;
});
