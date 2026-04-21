# Visual Companion

**Unified Chrome-App-Window für Claude-Code-Entwicklung.** Deine Web-App läuft links durch einen transparenten Reverse-Proxy, eine Claude-Code-Session rechts. Alt+Click auf beliebige UI-Elemente → Claude bekommt sofort vollen DOM-Kontext, Computed Styles, Screenshot, Source-Map und Ancestor-Chain. Console-Logs, Network-Requests und Errors streamen live in einen 5-Minuten-Ring-Buffer den Claude on-demand abfragt.

## Install (via Claude Code)

In irgendeiner Claude-Code-Session:

```
/plugin marketplace add ARETI-GmbH/visual-companion
/plugin install visual-companion@visual-companion
/reload-plugins
```

Beim ersten Aufruf von `/visual-companion` installiert das Plugin automatisch seine Node-Dependencies (~1 Min einmalig).

## Usage

```
/visual-companion                            # Auto-detect aus package.json scripts.dev
/visual-companion http://localhost:3000      # Explizite URL
/visual-companion --dsp                      # Claude startet mit --dangerously-skip-permissions
/visual-companion -c                         # Letzte Claude-Session fortsetzen (alte Terminal-Session vorher schließen!)
/visual-companion --resume <session-id>      # Spezifische Session
/visual-companion http://localhost:3000 --dsp -c
/visual-companion-stop                       # Beendet alle Daemons + Chrome-Windows (z.B. nach Plugin-Update)
```

Oder `/vc` als Alias. Das Plugin:

1. **Detectet die Ziel-URL** (CLI-Arg → `.visual-companion.json` → `package.json` scripts.dev)
2. **Startet deinen Dev-Server automatisch**, falls die URL noch nicht erreichbar ist (`pnpm dev` / `npm run dev` / `yarn dev` / `bun run dev` — Package-Manager wird auto-erkannt)
3. **Öffnet Chrome im App-Mode** mit isoliertem Profil und split-view: Web-App links, Claude-Session rechts
4. **Self-shutdown nach 60s Idle** — keine Dangling-Prozesse

### Pro Projekt konfigurierbar via `.visual-companion.json`

```json
{
  "default_url": "http://localhost:3000",
  "start_command": "pnpm dev"
}
```

## Features

**Point-and-tell:**
- `Alt + Hover` — Element-Highlight mit CSS-Selector-Label
- `Alt + Click` — Element an Claude senden (DOM, Styles, Screenshot, Source-Map, Ancestors)
- `Alt + Shift + Click` — Multi-Select
- `Alt + Drag` — Region auswählen

**Live observability:**
- Console-Logs (alle Levels)
- Network-Requests (fetch + XHR)
- DOM-Mutations (batched)
- Navigation-Events (pushState/popstate)
- Uncaught errors + unhandled rejections

**MCP-Tools für Claude** (15 insgesamt):
- Query: `get_pointed_element`, `get_console_logs`, `get_network_requests`, `get_dom_snapshot`, `get_computed_styles`, `take_screenshot`, `get_source_location`, `get_recent_events`, `get_page_info`, `get_pointed_history`
- Action: `highlight_element`, `scroll_to`, `navigate_to`, `reload`, `evaluate_in_page` (mit Terminal-Confirmation)

**Technische Highlights:**
- Reverse Proxy strippt X-Frame-Options und CSP `frame-ancestors`, injiziert Companion-Script transparent
- WebSocket-Tunneling erhält HMR (Vite / Next.js / Webpack Dev-Server funktionieren normal)
- Isoliertes Chrome-Profil pro Fenster (kein Cookie-Leak aus dem Haupt-Browser)
- xterm.js + node-pty für vollwertiges Terminal im rechten Pane
- Chrome-App-Mode via `open --app=` — keine Electron-Distribution nötig

## Develop

Lokal am Plugin selbst entwickeln:

```bash
git clone https://github.com/ARETI-GmbH/visual-companion.git
cd visual-companion
npm install
npm run build
npm test        # 20 unit tests
npm run e2e     # 2 Playwright E2E
```

## Plattform

macOS only (Chrome App-Mode + AppleScript-Hooks). Linux/Windows-Support siehe `docs/DEFERRED-FIXES.md`.

## Dokumentation

- **Design-Spec:** `docs/superpowers/specs/2026-04-21-visual-companion-design.md`
- **Implementation-Plan:** `docs/superpowers/plans/2026-04-21-visual-companion.md`
- **Manual-Acceptance-Checklist:** `docs/MANUAL-ACCEPTANCE.md`
- **Deferred Fixes:** `docs/DEFERRED-FIXES.md` (bekannte Follow-ups vor Produktionseinsatz)

## License

UNLICENSED — internal ARETI GmbH tool.
