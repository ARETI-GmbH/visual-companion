# Visual Companion

**Split-Pane-Fenster für Claude-Code-Entwicklung:** deine Web-App läuft links
durch einen transparenten Reverse-Proxy, eine Claude-Code-Session rechts.
`Alt+Shift+Click` auf ein UI-Element (oder Drag für eine Region) legt es in
einen Multi-Select-Buffer — Claude bekommt DOM, Computed Styles, Screenshot,
Source-Map und Ancestors per MCP, während Console-Logs, Network-Requests und
Errors live in einen Ring-Buffer streamen, den Claude on-demand abfragt.

## Install

In einer beliebigen Claude-Code-Session:

```
/plugin marketplace add ARETI-GmbH/visual-companion
/plugin install visual-companion@visual-companion
/reload-plugins
```

Beim ersten Aufruf von `/visual-companion` installiert das Plugin automatisch
seine Node-Dependencies (~1 Min einmalig).

## Usage

```
/visual-companion                            # aktuelle Claude-Session übernehmen
/visual-companion http://localhost:3000      # explizite URL
/visual-companion --new                      # frische Session, altes Terminal bleibt
/visual-companion --resume <session-id>      # spezifische Session
/visual-companion --dsp                      # mit --dangerously-skip-permissions
/visual-companion-stop                       # alle Daemons + Chrome-Windows beenden
```

Alias: `/vc`. Ablauf:

1. **URL detecten** (CLI-Arg → `.visual-companion.json` → `package.json` scripts.dev)
2. **Dev-Server autostarten**, falls Port noch nicht lauscht
   (`pnpm dev` / `npm run dev` / `yarn dev` / `bun run dev` — Paket-Manager
   wird auto-erkannt)
3. **Chrome im App-Mode** öffnen mit isoliertem Profil, split-view:
   Web-App links, Claude-Session rechts
4. **Self-shutdown nach 60s Idle** — keine Dangling-Prozesse

### Pro-Projekt-Config `.visual-companion.json`

```json
{
  "default_url": "http://localhost:3000",
  "start_command": "pnpm dev"
}
```

## Elemente markieren

**Hotkey `Alt+Shift`** (nicht nur `Alt` — Mac-Alt braucht man für
Sonderzeichen wie `@` auf deutscher Tastatur).

- `Alt+Shift + Hover` — Live-Highlight mit CSS-Selektor-Label
- `Alt+Shift + Click` — Element in den Buffer legen (orange)
- `Alt+Shift + Drag` — Region auswählen (blau, bleibt genau beim gezogenen
  Rechteck; Claude bekommt zusätzlich den kleinsten umschließenden DOM-Knoten
  als Kontext)
- `Esc` — ganzen Buffer leeren

Picks akkumulieren — alles, was du Alt+Shift-selektierst, stapelt sich als
**Chip-Liste** oben im rechten Pane (über dem Claude-Terminal):

- Farbpunkt zeigt Typ (orange=Element, blau=Region)
- Auto-Labels `#1`, `#2`, `#3` … — **Doppelklick** aufs Label zum Umbenennen
  (z.B. `TopBar`, `CTA`, `Sidebar`). Der neue Name geht sofort in den
  Prompt-Prefix, den Claude sieht — du kannst also "schau dir TopBar und
  CTA an" schreiben, Claude mappt auf die Snapshots zurück
- Einfach-Klick auf Chip → Element pulst kurz in der App
- `×` entfernt einen einzelnen Chip

Jeder Pick hängt an seiner URL. **Navigation innerhalb der App versteckt
die Rahmen, kommst du zurück, tauchen sie wieder auf.** Der Kontext für
Claude bleibt über Navigation und über Folge-Nachrichten hinweg erhalten,
bis du explizit Esc drückst oder neue Picks machst.

**Während Claude gerade arbeitet** verschwinden die Rahmen automatisch
(sonst würden sie während HMR-Reloads flackern). Sobald Claudes Output
stillsteht, kommen sie mit neu aufgelösten Selektoren zurück — passt also
auch auf Code-Änderungen, die Claude gerade committet hat.

## Was Claude mitkriegt

Jede Markierung fügt still einen Prefix in deine nächste Prompt-Zeile ein:

```
[markiert: TopBar=.header·/leads · "LEADS 11" ; #2=#ctaBtn·/leads — bitte zuerst MCP get_pointed_elements aufrufen]
```

Du tippst ganz normal weiter — der Prefix ist nur für Claude sichtbar. Wenn
du Enter drückst, committet er mit deiner Frage als eine einzige Nachricht.

Claude sieht den Hinweis in seinen MCP-Instructions (per Plugin fest hinterlegt)
und zieht dann automatisch die vollen Daten:

**Query-Tools:**
- `get_pointed_element` — letzter Pick, volle Payload
- `get_pointed_elements` — komplette Buffer-Liste mit Labels (für Mehrfach-Picks)
- `get_pointed_history` — frühere Picks (auch nach Esc noch abrufbar)
- `get_console_logs` — Console-Stream (level-Filter optional)
- `get_network_requests` — Fetch + XHR-Log
- `get_dom_snapshot`, `get_computed_styles`, `get_source_location`,
  `take_screenshot`, `get_page_info`, `get_recent_events`

**Action-Tools:**
- `highlight_element`, `scroll_to`, `navigate_to`, `reload`,
  `evaluate_in_page`

Claude wird zusätzlich proaktiv angewiesen, bei "schau in die Konsole /
there's an error / das klappt nicht" automatisch `get_console_logs` zu
rufen — statt dich nach Copy-Paste zu fragen.

## Technische Highlights

- **Transparenter Reverse Proxy**: alle Pfade (`/_next/static/...`,
  `/@vite/client`, etc.) gehen direkt durch, X-Frame-Options und CSP
  `frame-ancestors` werden gestrippt, Companion-Script wird vor `</head>`
  injected
- **HMR funktioniert**: WebSocket-Upgrades werden sauber an Upstream
  getunnelt (fastify-websocket und Proxy teilen sich den `upgrade`-Event
  ohne Race) — Vite, Next.js, Webpack Dev-Server, Svelte-Kit laufen alle
  wie direkt
- **Dual-Stack-Connect** (RFC 8305 Happy Eyeballs): Dev-Server auf
  `127.0.0.1`, `::1` oder beiden — egal, der erste der antwortet gewinnt
- **Isoliertes Chrome-Profil** pro Fenster — keine Cookies/Logins aus
  deinem Haupt-Browser
- **xterm.js + node-pty** für vollwertiges Terminal im rechten Pane
- **Chrome-App-Mode** via `open --app=` — keine Electron-Distribution nötig
- **PTY-Persistenz**: Session überlebt Iframe-Reload, Plugin-Update und
  Cmd+R — Claude läuft weiter, die xterm-Ansicht wird aus dem Replay-Buffer
  wiederhergestellt

## Develop

```bash
git clone https://github.com/ARETI-GmbH/visual-companion.git
cd visual-companion
npm install
npm run build
npm test        # Vitest unit tests
npm run e2e     # Playwright E2E
```

Nach Code-Änderungen am Plugin selbst: `/visual-companion-stop`,
dann `/visual-companion` um den neuen Daemon zu laden.

## Plattform

macOS only (Chrome App-Mode + AppleScript-Hooks für Terminal-Close).
Linux/Windows-Support siehe `docs/DEFERRED-FIXES.md`.

## Dokumentation

- **Design-Spec:** `docs/superpowers/specs/2026-04-21-visual-companion-design.md`
- **Implementation-Plan:** `docs/superpowers/plans/2026-04-21-visual-companion.md`
- **Manual-Acceptance-Checklist:** `docs/MANUAL-ACCEPTANCE.md`
- **Deferred Fixes:** `docs/DEFERRED-FIXES.md`

## License

UNLICENSED — internal ARETI GmbH tool.
