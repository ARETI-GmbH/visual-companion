---
description: Beendet nur die Visual-Companion-Session des aktuellen Projekts. Mit --all auch alle anderen.
argument-hint: "[--all]  (ohne Argument: nur aktuelles Projekt; --all: alle Sessions)"
allowed-tools: [Bash]
---

# /visual-companion-stop

Räumt die Visual-Companion-Session des aktuellen Projekts ab — der Daemon wird per SIGTERM gestoppt, das zugehörige Chrome-App-Window geschlossen, der Dev-Server als Teil der Daemon-Shutdown-Logik beendet.

**Standard: Isoliert pro Projekt.** Andere laufende Companion-Sessions (aus anderen Claude-Fenstern, anderen Projekten) bleiben unberührt. Das macht paralleles Arbeiten in mehreren Projekten sicher.

Mit `--all` werden alle laufenden Companion-Sessions auf dem Rechner gestoppt — z.B. nach einem Plugin-Update, wenn alle Instanzen frisch neu starten sollen.

## Ablauf

Führe **genau einen** Bash-Aufruf aus — das Arg `$ARGUMENTS` gibt `--all` durch, wenn gesetzt:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/stop.js" $ARGUMENTS
```

## Beispiele

```
/visual-companion-stop          # nur die Session dieses Projekts stoppen
/visual-companion-stop --all    # alle Companion-Sessions auf dem Rechner stoppen
```
