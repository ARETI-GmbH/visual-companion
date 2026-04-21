# @areti-gmbh/visual-companion

Unified Chrome-App-Window for Claude-Code development. Pair a live reverse-proxied view of your web-app with a Claude-Code session in a single window, and point at UI elements without screenshots.

## Install

```bash
claude plugin install @areti-gmbh/visual-companion
```

## Usage

```bash
# In any terminal with Claude Code running
> /visual-companion http://localhost:3000
# or just /vc if the dev port is auto-detectable
```

## How It Works

- A Node daemon starts a reverse proxy + WebSocket gateway + MCP server
- Chrome launches in app-mode with an isolated profile, loading a split-view window
- Left pane: iframe serving your app through the proxy (X-Frame-Options stripped, companion script injected)
- Right pane: xterm.js terminal running a fresh `claude` session
- Alt+Click any element → Claude receives DOM + styles + screenshot + source-map + ancestors
- Console logs, network requests, errors all stream to a 5-minute ring buffer Claude can query

See `docs/superpowers/specs/2026-04-21-visual-companion-design.md` for the full spec and `docs/DEFERRED-FIXES.md` for known follow-ups.

## Develop

```bash
npm install
npm run build
npm test
npm run e2e
```

## License

UNLICENSED — internal ARETI GmbH tool.
