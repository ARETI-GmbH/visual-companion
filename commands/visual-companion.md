---
description: Öffnet ein unified Chrome-App-Window mit Web-App + Claude-Session. Übernimmt standardmäßig die aktuelle Konversation und schließt die alte Terminal-Session.
argument-hint: "[url] [--new] [--dsp]  (Standard: aktuelle Session weiterführen; --new für frische Session)"
allowed-tools: [Bash]
---

# /visual-companion

Startet das Visual Companion: ein Chrome-App-Window mit deiner Web-App im linken Pane und einer frischen Claude-Code-Session im rechten Pane. Alt+Click auf beliebige UI-Elemente sendet sofort DOM + Styles + Screenshot + Source-Map an die Claude-Session.

User-Argument: `$ARGUMENTS`

## Ablauf

Führe **genau einen** Bash-Aufruf aus — das Launch-Script kümmert sich um alles:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/launch.js" $ARGUMENTS
```

Das Script:
1. Detectet die Ziel-URL (aus Argument, aus `.visual-companion.json`, oder aus `package.json` scripts.dev)
2. Installiert beim Erstlauf automatisch `node_modules` (einmalig ~1 Min)
3. Prüft ob die Ziel-URL erreichbar ist; wenn nicht, startet den Dev-Server automatisch (`npm run dev` o.ä.) und wartet bis der Port hochkommt
4. Startet den Companion-Daemon (lokaler Port)
5. Öffnet Chrome im App-Mode mit isoliertem Profil

Standardverhalten:
- Die neue Claude-Session im Chrome-Window übernimmt die aktuelle Konversation (`claude --continue`).
- Die äußere Terminal-Claude-Session wird nach dem Launch automatisch per SIGTERM geschlossen, damit du nicht zwei konkurrierende Sessions mit derselben History hast.

Flags:
- `--new` oder `--fresh`: Frische Claude-Session im Chrome-Window starten und die alte Terminal-Session **offen lassen** (z.B. wenn du parallel arbeiten willst).
- `-r <id>` oder `--resume <id>`: Eine spezifische Claude-Session per ID fortsetzen (anstelle von `--continue`).
- `--dsp` oder `--dangerously-skip-permissions`: Claude im rechten Pane startet mit `--dangerously-skip-permissions`.

## Fehlerbehandlung

Falls das Script mit Exit-Code ≠ 0 endet, lies die `stderr`-Meldung und gib dem User eine klare Diagnose:

- **„no URL provided and auto-detection failed"** → Der User soll entweder eine URL explizit mitgeben (`/visual-companion http://localhost:3000`), eine `.visual-companion.json` mit `{"default_url": "..."}` anlegen, oder die `scripts.dev` in der `package.json` um einen expliziten Port ergänzen.
- **„missing build artifact"** → Bitte den User, im Plugin-Verzeichnis (`${CLAUDE_PLUGIN_ROOT}`) einmal `npm run build` auszuführen. Normalerweise passiert das automatisch, aber wenn z.B. `dist/` fehlt, ist vermutlich der initial-build fehlgeschlagen.
- **„dev server started but port still not reachable after 30s"** → Dev-Server ist langsam oder hängt. Der User soll den Dev-Server manuell starten und die URL direkt mitgeben.
- **„Chrome not found"** (falls irgendwann ein solcher Fehler erscheint) → Google Chrome installieren.

## Wichtig

- Verwende keine Skills, kein Brainstorming, kein TaskCreate
- Eine Command = eine Bash-Execution
- Nach erfolgreicher Ausgabe wie `visual-companion: opening … on port …` ist alles gut — das Fenster läuft autonom, der Server shutdownet sich 60s nach letzter Client-Disconnection selbst
