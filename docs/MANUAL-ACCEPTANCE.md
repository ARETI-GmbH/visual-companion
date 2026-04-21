# Visual Companion — Manual Acceptance Checklist

Run before tagging a release.

## Setup
- [ ] `npm install`
- [ ] `npm run build`
- [ ] `chmod +x bin/launch.js`
- [ ] Install plugin locally into `~/.claude/plugins/` (symlink or copy)

## Single-File HTML (ARES)
- [ ] In terminal: `cd ~/Desktop && python3 -m http.server 8000 &`
- [ ] In terminal: `claude` then `/visual-companion http://localhost:8000/ARES/ARES.html`
- [ ] Chrome App window opens
- [ ] ARES app loads in left pane
- [ ] Claude prompt appears in right pane
- [ ] Alt hover → elements highlighted with selector labels
- [ ] Alt+Click on a button → in terminal, ask „was habe ich gerade geklickt" → Claude responds with element details

## Next.js
- [ ] Start any Next.js project: `cd <proj> && pnpm dev`
- [ ] `/visual-companion` (auto-detect from package.json)
- [ ] Next.js app renders, HMR works
- [ ] console.log in app → visible to Claude via `get_console_logs`

## Reload Behavior
- [ ] Cmd+R in window → iframe reloads (not window)
- [ ] Titlebar URL input accepts new path, navigates iframe

## Shutdown
- [ ] Close the Chrome App window
- [ ] Companion server exits within 60s
- [ ] `/tmp/visual-companion-*` profile dir cleaned up

## Multi-Window
- [ ] Open second window: `/visual-companion http://localhost:3001`
- [ ] Both windows work independently with own claude sessions and MCP servers

## evaluate_in_page Confirmation
- [ ] Ask Claude to run a JS expression in the page
- [ ] Terminal shows confirmation prompt
- [ ] Type `n` → expression not executed
- [ ] Type `y` → executes, result returned to Claude
