# Visual Companion — Design Specification

**Date:** 2026-04-21
**Owner:** Philippe Sünram
**Distribution target:** ARETI GmbH Claude-Code-Plugin-Marketplace (`@areti-gmbh/visual-companion`)

---

## 1. Overview

Visual Companion ist ein Claude-Code-Plugin, das ein unified Development-Fenster öffnet: links läuft die Web-App des Nutzers in einem kontrollierten Browser-Pane, rechts läuft eine frische Claude-Code-Session in einem echten Terminal. Der Nutzer kann per Alt-Modifier auf beliebige UI-Elemente in seiner App zeigen; Claude empfängt DOM-Kontext, Styles, Screenshot-Crops, Source-Map-Lookups und Ancestor-Chain in Echtzeit. Console-Logs, Network-Requests und DOM-Mutations fließen kontinuierlich in einen lokalen Event-Buffer, den Claude bei jedem Turn abfragen kann.

Ziel: Screenshot-basierte Referenzierung von UI-Elementen ersetzen durch direktes Zeigen im Live-System, bei voller lokaler Rechte-Integration.

---

## 2. Goals & Non-Goals

### Goals

- Unified window: Web-App und Claude-Code-Session im selben Fenster, optisch und topologisch eng gekoppelt
- Zero-install user experience: ein Slash-Command, Fenster öffnet sich, fertig
- Full Level-C Observability: Pointer + Console + Network + DOM-Snapshots + Source-Maps
- Keyboard-First Interaction: kein Mode-Switching, kein Toolbar-Overhead
- Bidirektional: Claude kann Elemente im Browser highlighten und scrollen
- Kompatibel mit allen Web-Apps des Nutzers (ARES Single-File, Next.js, Vite, deployed Previews)
- Distribution via ARETI Plugin-Marketplace

### Non-Goals

- **Kein persistenter Event-Store.** Events leben nur im In-Memory-Ring-Buffer während das Fenster offen ist.
- **Kein Cookie-Sharing** mit dem Haupt-Browser. Jedes Fenster nutzt ein ephemeres Chrome-Profil.
- **Kein Marketplace-Install** einer Browser-Extension. Die Companion-Funktionalität wird via Reverse-Proxy injiziert.
- **Kein Session-Handoff** aus der Ursprungs-Terminal-Session. Die neue Fenster-Session ist frisch.
- **Keine Windows/Linux-Unterstützung in Release 1.** macOS-first (Chrome-App-Mode + AppleScript-Fallbacks).

---

## 3. User Journey

```
1. Nutzer in beliebigem Terminal:
     $ claude
     > /visual-companion http://localhost:3000

2. Plugin führt aus:
     - spawnt companion-server (Node.js, bindet freien Port, z.B. 7777)
     - wartet auf proxy-ready
     - launcht Chrome im App-Mode mit eigenem Profil:
       open -na "Google Chrome" --args \
         --app=http://localhost:7777/window \
         --user-data-dir=/tmp/visual-companion-<pid>

3. Fenster öffnet sich:
     - Titlebar zeigt URL, Reload, DevTools, Settings
     - Linker Pane: iframe lädt via Proxy die User-App
     - Rechter Pane: xterm.js, Companion-Server spawnt `claude` in user cwd
     - Status-Bar unten: Proxy-Status, Event-Counter, MCP-Status

4. Nutzer arbeitet im neuen Fenster:
     - Alt halten → Fadenkreuz + Element-Highlights im linken Pane
     - Alt+Click → Element gepusht an Server, Event landet im Buffer
     - Im Terminal tippt Nutzer Frage an Claude
     - Claude ruft MCP-Tools (get_pointed_element, get_console_logs, ...)
     - Claude antwortet, kann highlight_element() zurückrufen → sichtbar im iframe

5. Fenster-Close:
     - Companion-Server shutdown
     - Chrome-Profile-Ordner gelöscht (ephemer)
     - Event-Buffer verworfen (kein Persistenz)
```

---

## 4. Architecture

### 4.1 Layer Overview

```
┌────────────────────────────────────────────────────────────────┐
│  Layer 1 — Chrome App Window (Companion Shell)                 │
│  HTML/JS: split-view · iframe (user app) · xterm.js (terminal) │
└────────────────────────┬─────────────────────────────────────────┘
                         │ HTTP/WS (localhost)
                         ▼
┌────────────────────────────────────────────────────────────────┐
│  Layer 2 — Companion Server (Node.js Daemon, localhost:7777)   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────┐ │
│  │ Reverse  │ │ WS       │ │ Event    │ │ PTY      │ │ MCP  │ │
│  │ Proxy    │ │ Gateway  │ │ Store    │ │ Bridge   │ │ Srv  │ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────┘ │
└────────────────────────┬─────────────────────────────────────────┘
                         │ stdio (MCP)
                         ▼
┌────────────────────────────────────────────────────────────────┐
│  Layer 3 — Claude Code (im Terminal-Pane)                       │
│  Frische Session, MCP-Server auto-registered via plugin manifest│
└────────────────────────────────────────────────────────────────┘

       ╔════════════════════════════════════════╗
       ║ Injected Companion Script (im iframe)  ║
       ║ MutationObserver · console/fetch/XHR   ║
       ║ patches · Alt-key-listener · overlay   ║
       ║ renderer · WebSocket-client            ║
       ╚════════════════════════════════════════╝
          (injiziert vom Reverse Proxy in jede
           HTML-Response vor Auslieferung ans iframe)
```

### 4.2 Component Responsibilities

| Komponente | Sprache | Laufzeit | Verantwortung |
|---|---|---|---|
| Companion Shell | HTML/TS (bundled) | Chrome App Window | Split-view UI, Titlebar-Controls, xterm.js-Terminal, iframe-Host |
| Companion Server | Node.js/TypeScript | Process (daemon) | Proxy, WS, Event-Store, PTY, MCP |
| Injected Script | Vanilla TS (bundled, minified) | in iframe (user context) | Event-Capture, Overlay-Rendering, Alt-Key-Handling |
| MCP Server | Node.js | stdio-child von claude (separater Prozess) | Tool-Surface für Claude, connected zur Daemon via HTTP/WS auf localhost |

---

## 5. Companion Shell

### 5.1 Layout

- **Titlebar** (28px, dark): macOS traffic lights (nativ), Titel "Visual Companion", URL-Input (centered), Action-Buttons rechts (Reload, DevTools für iframe, Settings)
- **Main Area** (flex): Split horizontal, default 58/42 Verteilung, draggable Divider (6px)
  - **Left Pane:** iframe mit `src="/app/"` (wird vom Proxy aufgelöst)
    - Overlay bottom-left: Status-Pill `⌥ halten zum Zeigen` (hover zeigt Cheatsheet)
    - Overlay bottom-right: Proxy-Status-Badge (`● Proxy verbunden` / `● Proxy getrennt`)
  - **Right Pane:** xterm.js Terminal (monospace, 10pt default, scrollback 10k)
- **Statusbar** (20px): Proxy-Info (Source → Target), Event-Counter, WS-Status, MCP-Status

### 5.2 Chrome & Controls

- **Cmd+R:** Reload iframe (nicht das gesamte Fenster)
- **Cmd+Shift+R:** Hard-Reload iframe (clear cache)
- **Cmd+L:** Focus URL-Input (navigate iframe)
- **Cmd+Option+I:** Öffnet DevTools für das iframe (separates Chrome-DevTools-Fenster)
- **Cmd+Option+T:** Focus Terminal-Pane
- **Cmd+Option+B:** Focus Browser-Pane
- **Cmd+0/1/2:** Reset-Split / Left-Only / Right-Only
- **Cmd+,:** Settings (Theme, Shortcuts, Default-Port-Range)

### 5.3 Launch Mechanism

Der Slash-Command `/visual-companion [url]` führt aus:

```bash
# 1. Plugin-Entry-Script (Node.js)
node $PLUGIN_DIR/bin/launch.js --url="$url" --cwd="$CWD"

# 2. Entry-Script:
#    a) startet companion-server als detached child
#    b) wartet auf STDOUT-Signal "READY port=XXXX"
#    c) launcht Chrome:
open -na "Google Chrome" --args \
  --app="http://localhost:$port/window" \
  --user-data-dir="/tmp/visual-companion-$server_pid" \
  --no-first-run \
  --no-default-browser-check \
  --new-window

# 3. Entry-Script exited, detached server läuft weiter
```

Der companion-server cleanupt sich selbst, wenn der Chrome-Prozess stirbt (Parent-Monitor via `ps` polling alle 2s).

---

## 6. Companion Server

### 6.1 Reverse Proxy

Route: `/app/*` → target URL (vom Slash-Command übergeben).

Pro-Request-Transformationen:

**Response Headers (strip):**
- `X-Frame-Options`
- `Content-Security-Policy` — nur `frame-ancestors`-Direktive entfernen, Rest behalten
- `Content-Security-Policy-Report-Only` — gleich
- `X-Content-Type-Options` — behalten (hilft nicht gegen framing)

**Response Body (HTML only, Content-Type `text/html`):**
- Inject `<script src="/_companion/inject.js" data-companion-port="7777"></script>` als letztes Child von `<head>` (Fallback: Anfang von `<body>`)
- Kein Rewrite von Absolute-URLs notwendig, da der Proxy alle Pfade weiterreicht

**WebSockets:**
- Transparent proxied: `/app/ws-*` → target WebSocket-Endpoint
- Upgrade-Header werden korrekt weitergereicht

**Cookies:**
- Weitergereicht ohne Rewrite. Domain wird relativ (`localhost`) behandelt, was für Dev-Apps funktioniert.
- Für OAuth-Flows mit externen Redirects: TODO für Release 2 (siehe § 15).

**Service Workers:**
- Bei HTML-Injection auch ein kleines Script hinzufügen, das bestehende SWs `unregister()`t bei Page-Load. Verhindert, dass ein SW aus vorigen Sessions interferiert.

### 6.2 WebSocket Gateway

Endpoint: `ws://localhost:7777/_companion/ws`

- Browser-Seite (injected script) öffnet beim Load.
- Nachrichten bidirektional JSON.
- Event-Typen browser → server:
  - `pointer` (element-data + metadata)
  - `console` (level, args, timestamp)
  - `network` (method, url, status, duration, request/response size)
  - `mutation` (summary, nicht full DOM — sonst zu noisy)
  - `navigation` (new URL, referrer)
  - `error` (uncaught exceptions)
- Message-Typen server → browser:
  - `highlight` (selector, duration_ms)
  - `scroll_to` (selector)
  - `navigate` (url)
  - `reload`
  - `evaluate` (JS-string, requires confirmation)

### 6.3 Event Store

- Ring-Buffer, in-memory, Kapazität: letzte 5 Minuten ODER 5000 Events (whichever first).
- Screenshots in-memory (gzip'd PNG-Bytes), max 100 gleichzeitig (LRU-evict).
- **Keine SQLite, keine Disk-Persistenz** (pro User-Entscheidung).
- Bei Window-Close: alles weg.

Events haben Shape:

```ts
interface Event {
  id: string;           // uuid
  timestamp: number;    // ms since epoch
  type: 'pointer' | 'console' | 'network' | 'mutation' | 'navigation' | 'error';
  payload: object;      // type-specific
  url: string;          // current iframe URL at time of event
}
```

### 6.4 PTY Bridge

- Beim Window-Connect spawnt der Server einen PTY via `node-pty`:
  ```ts
  spawn('claude', [], {
    cwd: process.env.LAUNCH_CWD,
    env: { ...process.env, VISUAL_COMPANION_PORT: '7777' },
  });
  ```
- xterm.js im Shell verbindet via WebSocket (`/_companion/pty`).
- Stdin/Stdout/Resize-Events werden weitergereicht.
- Bei PTY-Exit: Terminal-Pane zeigt „Session ended. Press Enter to restart." → `Enter` spawnt neu.

### 6.5 MCP Server

- Registriert sich im Plugin-Manifest (`claude-plugin.json`) als MCP-Server mit Transport `stdio`.
- Beim Spawn der claude-Session im PTY wird der MCP-Server als Child-Prozess von claude gestartet.
- **Separater Prozess vom Daemon.** Kommunikation via HTTP/WS zur Daemon auf `localhost:$VISUAL_COMPANION_PORT`.
- **Discovery via Env-Variable:** Die PTY-Bridge injiziert `VISUAL_COMPANION_PORT=7777` in die claude-Umgebung (§ 6.4). Der MCP-Server liest diese Variable beim Start.
- **Graceful degradation:** Wird claude ausserhalb eines Companion-Fensters gestartet (keine Env-Variable), returnen alle Tools einen klaren Error: `"No visual companion active. Run /visual-companion first."`
- **Tool-Handler-Flow:** MCP-Tool-Call → HTTP-Request an Daemon (`POST /_companion/mcp/<tool>`) → Daemon bedient aus Event-Store oder pusht Server→Browser-Nachricht via WebSocket → Response zurück.

---

## 7. Injected Companion Script

Wird vom Proxy als `/_companion/inject.js` ausgeliefert und via `<script>`-Tag in jede HTML-Response eingefügt.

### 7.1 Event Capture

- **Console:** Monkey-Patch `console.log/info/warn/error/debug`. Original-Fn wird erhalten. Args werden serialisiert (JSON-safe, DOM-Nodes → CSS-Selector, Cycles → placeholder).
- **Network:** Monkey-Patch `fetch`, `XMLHttpRequest.prototype.send`. Captured: method, URL, status, duration, content-length. Kein Body (zu gross, zu privat).
- **Errors:** `window.addEventListener('error')`, `window.addEventListener('unhandledrejection')`.
- **Mutations:** `MutationObserver` auf `document.body`, `subtree:true`, aber nur Summary (count of adds/removes/attr-changes pro 500ms-Window), nicht individuelle Mutations.
- **Navigation:** `window.addEventListener('popstate')`, Monkey-Patch `history.pushState/replaceState`.

### 7.2 Overlay UI

Shadow-DOM-basiert, attached an `document.documentElement`. Verhindert CSS-Leakage zur User-App.

- **Hover-Overlay:** wenn Alt gehalten + hover: absolute-positioniertes `<div>` mit 2px solid outline (color: `#f59e0b`), Background-Tint (4% opacity), Label oben-links mit CSS-Selector
- **Selection-Flash:** bei Alt+Click: kurze 200ms-Expansion-Animation → dann Remove
- **Highlight-from-Claude:** wenn Server `highlight`-Nachricht schickt: Element pulst 3x (800ms total), Glow-Shadow orange, scrollt ins Viewport falls offscreen
- **Region-Box:** bei Alt+Drag: gestrichelte Box, follows Maus, bei Release: Screenshot + enthaltene Elemente gesendet

### 7.3 Interaction Model

```
Kein Modifier:     App verhält sich normal, Companion ist unsichtbar
Alt:               Fadenkreuz-Cursor, Hover-Highlight aktiv
Alt+Click:         Element selektiert, Event gepusht
Alt+Shift+Click:   Multi-Select (mehrere Elemente akkumulieren)
Alt+Drag:          Region-Box aufziehen
Escape:            Falls Multi-Select aktiv → reset, sonst no-op
```

Der Script respektiert `e.defaultPrevented` → wenn die App schon Alt-Events verwendet (selten, aber möglich), wird es sie nicht kapern.

---

## 8. MCP Tool Surface

### 8.1 Query Tools

| Tool | Input | Output |
|---|---|---|
| `get_pointed_element` | `()` | Letztes Pointer-Event: element + metadata (s. § 9) |
| `get_pointed_history` | `(count: number)` | Letzte N Pointer-Events |
| `get_console_logs` | `(since_ms?: number, level?: 'log'\|'info'\|'warn'\|'error'\|'debug')` | Array von Log-Entries |
| `get_network_requests` | `(since_ms?: number, filter?: { method?, url_contains?, status_range? })` | Array von Request-Entries |
| `get_dom_snapshot` | `(selector?: string)` | outerHTML (truncated at 50k chars) |
| `get_computed_styles` | `(selector: string)` | Object mit gefilterten CSS-Werten |
| `get_source_location` | `(selector: string)` | `{ file, line }` via Source-Map (falls verfügbar) oder `null` |
| `take_screenshot` | `(selector?: string, full_page?: boolean)` | Base64-PNG |
| `get_recent_events` | `(since_ms: number, types?: EventType[])` | Merged Event-Stream, sortiert by timestamp |
| `get_page_info` | `()` | `{ url, title, viewport: {w, h}, user_agent, localStorage_keys }` |

### 8.2 Action Tools

| Tool | Input | Behavior |
|---|---|---|
| `highlight_element` | `(selector: string, duration_ms?: number)` | Pulsiert Element im Browser (default 800ms, 3 pulses), scrollt ins Viewport |
| `scroll_to` | `(selector: string)` | `scrollIntoView({ behavior: 'smooth', block: 'center' })` |
| `navigate_to` | `(url: string)` | Setzt iframe.src |
| `reload` | `()` | iframe reload |
| `evaluate_in_page` | `(expression: string)` | **Requires user confirmation in terminal** — pusht Code-Snippet ans Terminal, wartet auf `y`/`n`, bei `y` ausgeführt via `eval()` in iframe-Context, Return-Value zurück |

---

## 9. Captured Data per Pointer Event

Wenn Nutzer Alt+Click macht, captured der injected script:

```ts
interface PointerEvent {
  id: string;
  timestamp: number;
  url: string;                    // current iframe URL

  // 1. DOM-Kontext
  tagName: string;                // "div"
  id: string | null;              // "#hero"
  classes: string[];              // ["hero-block", "hero-block--large"]
  dataAttributes: Record<string, string>;
  outerHTML: string;              // truncated at 5000 chars
  cssSelector: string;            // unique CSS path
  boundingBox: { x, y, width, height };
  textContent: string;            // truncated at 500 chars

  // 2. Computed Styles (gefiltert)
  computedStyles: {
    layout: Record<string, string>;    // display, position, flex*, grid*, width, height, margin, padding
    typography: Record<string, string>; // font-family, font-size, font-weight, line-height, color
    colors: Record<string, string>;     // background, border-color
    spacing: Record<string, string>;    // margin, padding
  };

  // 3. Screenshot-Crop
  screenshotDataUrl: string;      // PNG, element rect + 20px padding

  // 4. Source-Map-Lookup (best effort, null if unavailable)
  sourceLocation: { file: string; line: number; column: number } | null;

  // 6. Ancestor Chain
  ancestors: Array<{
    tagName: string;
    id: string | null;
    classes: string[];
    cssSelector: string;
  }>;                             // bis inkl. body
}
```

(Nummer 5, "Attached Event Listeners", explizit nicht erfasst in Release 1.)

---

## 10. Session Lifecycle

- **Start:** `/visual-companion [url]` → Server + Chrome + Frische Claude-Session
- **URL auto-detection:** wenn `url` fehlt:
  1. Read `<cwd>/.visual-companion.json` → `default_url` wenn vorhanden
  2. Parse `<cwd>/package.json`, suche `scripts.dev`, extrahiere Port → `http://localhost:<port>`
  3. Fallback: fehler, bitte URL mitgeben
- **Mehrere Fenster:** erlaubt und explizit supported. Jedes Fenster hat eigenen Port, eigenes Chrome-Profil, eigene Claude-Session, eigenen MCP-Server-Prozess.
- **Shutdown:** Wenn das Chrome-Window geschlossen wird, detected der companion-server das (parent-watch), kills den PTY-claude, löscht das `/tmp/visual-companion-<pid>`-Profile, exited.
- **Crash-Recovery:** Kein Recovery. Wenn der Server crasht, muss der User das Fenster schliessen und den Command neu ausführen.

---

## 11. Security Considerations

### 11.1 Isolated Browser-Profile

Jedes Fenster nutzt ein neues `--user-data-dir=/tmp/visual-companion-<pid>`. Keine Cookies/LocalStorage/IndexedDB aus dem Haupt-Browser. Keine Extensions. Wird bei Shutdown gelöscht.

### 11.2 `evaluate_in_page` Confirmation

Vor jeder JS-Ausführung im User-iframe:
1. Server posted Expression in den Terminal (via PTY)
2. Claude-Code zeigt Nutzer: „Claude möchte JS im iframe ausführen: `<code>`. Bestätigen? [y/N]"
3. Nur bei `y` wird ausgeführt

Kein Auto-Allow, keine Whitelist.

### 11.3 Localhost-Binding

Alle Server-Ports binden an `127.0.0.1`, niemals an `0.0.0.0`. Keine externe Erreichbarkeit.

### 11.4 Proxy-Scope

Der Proxy akzeptiert nur URLs, die beim Launch übergeben wurden. Kein offener Proxy, keine arbiträren URLs.

---

## 12. Error Handling

| Szenario | Verhalten |
|---|---|
| Target-App nicht erreichbar (z.B. `localhost:3000` down) | Proxy returned 502, Shell zeigt Error-Overlay im linken Pane mit Retry-Button |
| WebSocket-Disconnect (Netz-Hiccup) | Auto-Reconnect mit exponential backoff (1s, 2s, 4s, max 30s) |
| Claude-Session im PTY crasht | Terminal zeigt „Session ended. Press Enter to restart." |
| Chrome-Profile kann nicht geschrieben werden (z.B. /tmp voll) | Launch-Script fehlgeschlagen mit klarer Message |
| Port 7777 belegt | Server versucht 7778, 7779, ..., bis 7800 (100 Versuche), danach fatal |
| Injection scheitert (kein `<head>` in Response) | Fallback: Injection am Anfang von `<body>`. Falls auch das fehlt: Log + weiter |
| `evaluate_in_page` throws | Error-Value zurück an Claude, nicht unterdrückt |

---

## 13. Testing Strategy

### 13.1 Unit-Tests (Vitest)

- Proxy: Header-Strip-Logic, Injection-Logic, Cookie-Forward
- Event-Store: Ring-Buffer-Eviction, Query-Filtering
- Injected Script: Selector-Generator (unique-Path-Algorithm), Style-Filter

### 13.2 Integration-Tests

- End-to-end mit einer Test-Fixture-HTML-App: Proxy serves → iframe loads → Alt+Click → Event im Buffer
- MCP-Tools: Spawn MCP-Server, send tool-calls via stdio, assert responses

### 13.3 Manual Acceptance (vor Release 1)

- **ARES** (`~/Desktop/ARES/ARES.html`): Öffnet, Proxy funktioniert, Companion-Script injiziert, Alt+Click erfasst Elemente
- **Next.js-Dev**: beliebiges Next-Projekt, `pnpm dev`, Companion verbindet, HMR (Hot Module Reload) funktioniert durch den Proxy
- **Vercel-Preview-URL**: deployed App, Companion verbindet, Auth-Flow zu testen

### 13.4 Coverage-Target

- 80% für Companion-Server (exkl. MCP-Bindings)
- 70% für Injected Script (DOM-heavy, schwerer zu testen)
- Testing-Framework: Vitest + jsdom für Script-Tests, Playwright für End-to-End

---

## 14. Distribution

### 14.1 Plugin-Struktur

```
@areti-gmbh/visual-companion/
├── claude-plugin.json          # Plugin-Manifest
├── package.json
├── bin/
│   └── launch.js               # Entry-Script für /visual-companion
├── server/                     # Companion-Server (TypeScript)
│   ├── proxy.ts
│   ├── websocket.ts
│   ├── event-store.ts
│   ├── pty-bridge.ts
│   ├── mcp.ts
│   └── index.ts
├── shell/                      # Companion-Shell (bundled HTML+JS)
│   ├── dist/
│   │   ├── window.html
│   │   ├── window.js
│   │   └── window.css
│   └── src/                    # Pre-bundle-Sourcen
├── inject/                     # Injected Script
│   ├── dist/inject.min.js
│   └── src/
└── README.md
```

### 14.2 Installation

```bash
# Beim User:
claude plugin install @areti-gmbh/visual-companion
```

Plugin-Manifest registriert:
- Slash-Command: `/visual-companion` (+ Alias `/vc`)
- MCP-Server: `visual-companion-mcp` (Transport stdio)

### 14.3 Dependencies

- Laufzeit: Node.js 20+ (bereits vorhanden via Claude-Code)
- Chrome: muss installiert sein (Check beim Launch, klarer Error wenn nicht)

---

## 15. Out of Scope / Future Work

### Release 2 Candidates

- **Dev-Server-Auto-Injection:** Vite-Plugin + Next.js-Plugin + Webpack-Plugin, die den Companion-Script ohne Proxy einbinden. Eliminiert Proxy für Framework-Apps.
- **Electron-Wrapper:** Für Dock-Integration, Menü-Bar, native Shortcuts, Offline-Support, Auto-Update.
- **OAuth-Flow-Support:** Cookie-Rewriting für externe Redirects (Auth0, Google-OAuth).
- **Event-Listeners-Capture:** Monkey-Patch `addEventListener` im injected script, um attached handlers pro Element zu erfassen (siehe Option 5 aus Brainstorm).
- **Windows/Linux-Support:** AppleScript-unabhängige Fenster-Positionierung.
- **Session-Persistenz:** Opt-in (via Config-Flag), für Post-Mortem-Debugging.
- **Cookie-Import:** Opt-in, einmaliger Sync aus Haupt-Browser beim Launch.

### Explicitly Not Planned

- **Browser-Extension-Variante:** Fundamentaler Design-Konflikt, kein Upgrade-Pfad gewünscht.
- **Production-Debugging-Mode:** Das Tool ist für Development, nicht für Prod-Monitoring.

---

## 16. Open Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Chrome-App-Mode deprecated | Low | High | Electron-Upgrade-Pfad ist dokumentiert (§ 15) |
| Proxy bricht spezifische Framework-App (z.B. bestimmte HMR-Patterns in Vite) | Medium | Medium | Acceptance-Tests mit Next/Vite vor Release; Bypass-Config pro Projekt möglich |
| Source-Map-Lookup zu fragil für diverse Bundler | Medium | Low | Feature degradiert graceful (null returnt) wenn nicht verfügbar |
| Screenshot-Capture in iframe via `html2canvas` langsam/inaccurate | High | Medium | Fallback: native `ViewTransitionAPI` oder Chrome-DevTools-Protocol wenn verfügbar; MVP akzeptiert 200-500ms-Latenz |
| node-pty Binary-Incompatibility mit claude-Plugin-Distribution | Medium | High | Pre-build Binaries für macOS-arm64 + macOS-x64 im Plugin bundlen |
| User öffnet mehrere Fenster gleichzeitig → Port-Konflikte | Low | Low | Bereits gehandelt: 100 Port-Retries ab Default |
| iframe-Sandbox blockiert bestimmte APIs der User-App | Medium | Medium | iframe ohne Sandbox-Attribut geladen, volle API-Fläche verfügbar |

---

## Appendix A — Plugin-Manifest-Skelett

```json
{
  "name": "@areti-gmbh/visual-companion",
  "version": "0.1.0",
  "description": "Unified Chrome-App Window mit Live-Pointer für Web-App-Entwicklung",
  "author": "ARETI GmbH",
  "commands": [
    {
      "name": "visual-companion",
      "aliases": ["vc"],
      "description": "Öffnet unified window mit Browser + Claude für eine URL",
      "usage": "/visual-companion [url]",
      "handler": "bin/launch.js"
    }
  ],
  "mcpServers": {
    "visual-companion-mcp": {
      "command": "node",
      "args": ["server/index.js", "--mcp-mode"],
      "transport": "stdio"
    }
  }
}
```

---

**End of Spec.**
