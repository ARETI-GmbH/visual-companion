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
  // the real upstream URL in the URL bar AND re-attach our Cmd+R / Cmd+L
  // keybindings to the iframe's document. Without the iframe-side listener,
  // focusing inside the app swallows the shell's keydown handler and Cmd+R
  // falls through to Chrome's default, which reloads the whole window and
  // takes out the claude session.
  iframe.addEventListener('load', () => {
    try {
      const iframeHref = iframe.contentWindow?.location.href;
      if (!iframeHref) return;
      // Don't trample the URL bar while the user is editing it —
      // every iframe redirect / HMR fires another load, and the
      // overwrite used to silently restore the pre-edit value,
      // making the URL field feel "uneditable".
      if (document.activeElement !== urlInput) {
        const frameUrl = new URL(iframeHref);
        urlInput.value = upstreamOrigin
          ? upstreamOrigin + frameUrl.pathname + frameUrl.search + frameUrl.hash
          : iframeHref;
      }

      const doc = iframe.contentDocument;
      if (doc) {
        doc.addEventListener('keydown', (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
            e.preventDefault();
            e.stopPropagation();
            reload(iframe, e.shiftKey);
          }
          if ((e.metaKey || e.ctrlKey) && e.key === 'l') {
            e.preventDefault();
            e.stopPropagation();
            urlInput.focus();
            urlInput.select();
          }
        }, { capture: true });
      }
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
    const resolved = resolveTarget(raw, upstreamOrigin);
    // Blur the input so the load handler above is free to refresh
    // the display — otherwise it'd skip updating because we're
    // still focused and the URL bar would stay showing raw.
    urlInput.blur();
    iframe.src = resolved;
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
  // Reload the iframe via its contentWindow — dev servers all send
  // no-cache headers, so a normal reload is already "hard". The older
  // __vc_nocache query-string trick stacked params on every Cmd+Shift+R
  // ("?__vc_nocache=…&__vc_nocache=…&__vc_nocache=…") and confused
  // client-side routers.
  try {
    iframe.contentWindow?.location.reload();
    return;
  } catch {
    // Cross-origin (shouldn't happen through the proxy), fall through
  }
  // Fallback if contentWindow.reload isn't accessible. Strip any
  // previously-stacked cache-buster params before re-assigning src.
  try {
    const u = new URL(iframe.src, window.location.origin);
    for (const key of Array.from(u.searchParams.keys())) {
      if (key === '__vc_nocache') u.searchParams.delete(key);
    }
    if (hard) u.searchParams.set('__vc_nocache', String(Date.now()));
    iframe.src = u.pathname + (u.search ? u.search : '') + u.hash;
  } catch {
    iframe.src = iframe.src;
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

/**
 * Convert whatever the user typed into an iframe src. Three cases:
 *
 * 1. "http://localhost:3000/foo?x=1"  (matches upstream)  → "/foo?x=1"
 *    Stays inside the proxy — companion keeps working.
 *
 * 2. "https://other.example/..." OR "other.example/..."   → raw URL
 *    External origin: load directly, bypassing the proxy. Companion
 *    features (Alt-pick, console/network capture) won't work on
 *    external sites; that's expected. X-Frame-Options on the other
 *    side may block the load entirely — out of our hands.
 *
 * 3. "/foo" or "foo"                                       → "/foo"
 *    Plain path on the current upstream.
 *
 * The middle case used to route through the catch-all and get
 * prepended with "/" — so "aris.example.com/foo" became the path
 * "/aris.example.com/foo" on the current upstream, which at best
 * 404s and at worst silently matches a SPA catchall route.
 */
function resolveTarget(raw: string, upstreamOrigin: string): string {
  let parsed: URL | null = null;
  try { parsed = new URL(raw); } catch {
    // No scheme — but is it domain-shaped? "a.b", "foo.com/bar", etc.
    // Heuristic: first segment before any "/" contains a dot and is
    // made of domain-legal chars. This avoids eating plain paths
    // like "/foo/bar" and single-segment routes like "settings".
    const head = raw.split(/[/?#]/, 1)[0];
    if (/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/.test(head)) {
      try { parsed = new URL('https://' + raw); } catch {}
    }
  }
  if (parsed) {
    if (upstreamOrigin && parsed.origin === upstreamOrigin) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
    // External — load directly, bypass proxy.
    return parsed.toString();
  }
  if (raw.startsWith('/')) return raw;
  return '/' + raw;
}
