export interface IframeOptions {
  iframe: HTMLIFrameElement;
  urlInput: HTMLInputElement;
  reloadBtn: HTMLElement;
  devtoolsBtn: HTMLElement;
  targetUrl: string;
}

export function initIframe(opts: IframeOptions): void {
  const { iframe, urlInput, reloadBtn, devtoolsBtn, targetUrl } = opts;

  urlInput.value = decodeURIComponent(new URLSearchParams(window.location.search).get('target') ?? 'http://localhost:3000');
  iframe.src = targetUrl;

  reloadBtn.addEventListener('click', () => reload(iframe));
  devtoolsBtn.addEventListener('click', () => {
    alert('Right-click the iframe area → Inspect Element for DevTools.');
  });

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const url = urlInput.value.trim();
      if (url.startsWith('/')) iframe.src = url;
      else iframe.src = '/app/';
    }
  });

  // Global keybindings
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
      e.preventDefault();
      reload(iframe, e.shiftKey);
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
      e.preventDefault();
      urlInput.focus();
      urlInput.select();
    }
  });
}

function reload(iframe: HTMLIFrameElement, hard = false): void {
  if (hard) {
    iframe.src = iframe.src + (iframe.src.includes('?') ? '&' : '?') + '__vc_nocache=' + Date.now();
  } else {
    iframe.src = iframe.src;
  }
}
