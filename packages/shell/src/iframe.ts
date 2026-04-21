export interface IframeOptions {
  iframe: HTMLIFrameElement;
  urlInput: HTMLInputElement;
  reloadBtn: HTMLElement;
  devtoolsBtn: HTMLElement;
  backBtn?: HTMLElement;
  forwardBtn?: HTMLElement;
  targetUrl: string;
}

/**
 * Wires the iframe + titlebar controls. The iframe src is the proxy
 * origin at whatever path the user wants; the URL bar shows the
 * equivalent upstream URL (e.g. "http://localhost:3000/de") because
 * that's the URL the user actually debugs against.
 */
export function initIframe(opts: IframeOptions): void {
  const { iframe, urlInput, reloadBtn, devtoolsBtn, backBtn, forwardBtn, targetUrl } = opts;

  const qs = new URLSearchParams(window.location.search);
  const upstreamOrigin = stripTrailingSlash(qs.get('upstream') || '');

  iframe.src = targetUrl;
  urlInput.value = upstreamOrigin || targetUrl;

  // When the iframe navigates (redirect, link click, form submit), reflect
  // the real upstream URL in the URL bar.
  iframe.addEventListener('load', () => {
    try {
      const iframeHref = iframe.contentWindow?.location.href;
      if (!iframeHref) return;
      const frameUrl = new URL(iframeHref);
      urlInput.value = upstreamOrigin
        ? upstreamOrigin + frameUrl.pathname + frameUrl.search + frameUrl.hash
        : iframeHref;
    } catch {
      // Cross-origin iframe (shouldn't happen through proxy) — leave URL bar alone
    }
  });

  reloadBtn.addEventListener('click', () => reload(iframe));
  devtoolsBtn.addEventListener('click', () => {
    alert('Right-click the iframe area → Inspect Element for DevTools.');
  });
  // Because the iframe lives on the proxy origin (same as this shell),
  // we can drive its history directly. No navigation state tracking
  // needed — if there's nothing to go to, .back() / .forward() no-op.
  backBtn?.addEventListener('click', () => {
    try { iframe.contentWindow?.history.back(); } catch {}
  });
  forwardBtn?.addEventListener('click', () => {
    try { iframe.contentWindow?.history.forward(); } catch {}
  });

  urlInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const raw = urlInput.value.trim();
    if (!raw) return;
    iframe.src = resolveToProxyPath(raw, upstreamOrigin);
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

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * Convert whatever the user typed into an iframe src on the proxy origin.
 *
 *   "http://localhost:3000/foo?x=1"  (matches upstream)  → "/foo?x=1"
 *   "/foo"                                                → "/foo"
 *   "foo"                                                 → "/foo"
 *   "https://other.example/..." (non-upstream)            → "/" (fallback; cross-origin)
 */
function resolveToProxyPath(raw: string, upstreamOrigin: string): string {
  try {
    const parsed = new URL(raw);
    if (upstreamOrigin && parsed.origin === upstreamOrigin) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
    return '/';
  } catch {
    if (raw.startsWith('/')) return raw;
    return '/' + raw;
  }
}
