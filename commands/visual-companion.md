---
description: Öffnet ein unified Chrome-App-Window mit Web-App + Claude-Session. Auto-startet Dev-Server wenn nötig.
argument-hint: "[url] [--dsp] [-c | --resume <id>]  (-c = letzte Claude-Session fortsetzen; --dsp = --dangerously-skip-permissions)"
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

Flags:
- `--dsp` oder `--dangerously-skip-permissions`: Claude im rechten Pane startet mit `--dangerously-skip-permissions`.
- `-c` oder `--continue`: Die neue Claude-Session im Chrome-Window setzt die letzte gespeicherte Konversation fort. **Wichtig:** Die äußere Terminal-Session nicht gleichzeitig weiter benutzen — zwei Claude-Prozesse, die in dieselbe Session schreiben, verursachen Race-Conditions.
- `-r <id>` oder `--resume <id>`: Eine spezifische Claude-Session per ID fortsetzen.

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
