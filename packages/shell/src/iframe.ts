export interface IframeOptions {
  iframe: HTMLIFrameElement;
  urlInput: HTMLInputElement;
  reloadBtn: HTMLElement;
  devtoolsBtn: HTMLElement;
  targetUrl: string;
}

/**
 * Wires the iframe + titlebar controls. The URL bar shows the upstream
 * URL the user actually cares about (e.g. "http://localhost:3000/de"),
 * not the proxy path ("/app/de"). Edits go through the proxy transparently.
 */
export function initIframe(opts: IframeOptions): void {
  const { iframe, urlInput, reloadBtn, devtoolsBtn, targetUrl } = opts;

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
      const proxyPrefix = '/app';
      const pathWithoutPrefix = frameUrl.pathname.startsWith(proxyPrefix)
        ? frameUrl.pathname.slice(proxyPrefix.length) || '/'
        : frameUrl.pathname;
      urlInput.value = upstreamOrigin
        ? upstreamOrigin + pathWithoutPrefix + frameUrl.search + frameUrl.hash
        : iframeHref;
    } catch {
      // Cross-origin iframe (shouldn't happen through proxy) — leave URL bar alone
    }
  });

  reloadBtn.addEventListener('click', () => reload(iframe));
  devtoolsBtn.addEventListener('click', () => {
    alert('Right-click the iframe area → Inspect Element for DevTools.');
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
 * Convert whatever the user typed into an iframe src that goes through /app/.
 *
 *   "http://localhost:3000/foo?x=1"  (matches upstream)  → "/app/foo?x=1"
 *   "/foo"                                                → "/app/foo"
 *   "foo"                                                 → "/app/foo"
 *   "https://other.example/..." (non-upstream)            → "/app/" (fallback; cross-origin)
 */
function resolveToProxyPath(raw: string, upstreamOrigin: string): string {
  // Absolute URL?
  try {
    const parsed = new URL(raw);
    if (upstreamOrigin && parsed.origin === upstreamOrigin) {
      return '/app' + parsed.pathname + parsed.search + parsed.hash;
    }
    // Cross-origin — just navigate iframe to /app/ root (user can't break out of the proxy)
    return '/app/';
  } catch {
    // Not an absolute URL — treat as path
    if (raw.startsWith('/app/') || raw === '/app') return raw;
    if (raw.startsWith('/')) return '/app' + raw;
    return '/app/' + raw;
  }
}
