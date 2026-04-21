---
description: Beendet alle laufenden Visual-Companion-Daemons und Chrome-App-Windows. Nützlich nach Plugin-Updates.
allowed-tools: [Bash]
---

# /visual-companion-stop

Räumt alle laufenden Visual-Companion-Prozesse ab:
- Beendet jeden Companion-Daemon per SIGTERM (der Daemon killt seinen Dev-Server-Child selbst und löscht sein Chrome-Profile-Dir)
- Beendet jedes Chrome-App-Window mit `--user-data-dir=/tmp/visual-companion-*`
- Nach 2s Grace-Period werden Stragglers per SIGKILL beendet

**Lässt MCP-stdio-Prozesse (`mcp-entry.js`) in Ruhe** — die gehören der Claude-Session.

## Ablauf

Führe **genau einen** Bash-Aufruf aus:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/stop.js"
```

## Typischer Workflow

1. `/visual-companion-stop`   ← nach Plugin-Update, um stale Daemons zu killen
2. Plugin-Update abschließen (`/plugins` → Update)
3. `/visual-companion`   ← spawnt einen frischen Daemon aus dem neuen Cache
