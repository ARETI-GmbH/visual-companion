#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DaemonClient } from './mcp-tools.js';
const port = parseInt(process.env.VISUAL_COMPANION_PORT ?? '0', 10);
const client = port > 0 ? new DaemonClient(port) : null;
const TOOLS = [
    { name: 'get_pointed_element', description: 'Get the MOST RECENT element the user Alt+Shift-clicked / region-selected, with full context (DOM, computed styles, screenshot, source-map, ancestors). Use when the prefix has a SINGLE [markiert: …] entry or the user refers to "this element", "das hier", "the thing I selected".', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_pointed_elements', description: 'Get the FULL multi-select buffer — every element currently in the chip panel, in pick order. Returns an array of {id, label, kind, url, pathname, selector, textPreview, payload}. The label ("#1", "#2", …) matches the labels the user sees in the shell panel and references in their prompt ("schau dir #1 und #3 an"). Use whenever the prefix contains multiple [markiert: #1=…, #2=…] entries or the user refers to numbered boxes.', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_pointed_history', description: 'Get the last N pointer events from the event store — includes selections that have since been removed from the buffer. Use when the user says "the one before that" or refers to an earlier pick that\'s no longer in the current buffer.', inputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } },
    { name: 'get_console_logs', description: 'Live console stream (log/info/warn/error/debug) captured from the iframe. Call this whenever the user mentions a bug, error, warning, broken behavior, unexpected output, or says "schau in die Konsole / check the console / was steht in der Konsole". Pass since_ms (typically 60000 for the last minute) to keep payloads small. Pass level="error" to filter for just errors.', inputSchema: { type: 'object', properties: { since_ms: { type: 'number' }, level: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug'] } } } },
    { name: 'get_network_requests', description: 'Live network-request stream (fetch + XHR) from the iframe. Use when the user mentions a failed request, slow API call, wrong response, or says "check network / Netzwerk". Pass since_ms to limit the window.', inputSchema: { type: 'object', properties: { since_ms: { type: 'number' }, filter: { type: 'object' } } } },
    { name: 'get_dom_snapshot', description: 'Get DOM snapshot', inputSchema: { type: 'object', properties: { selector: { type: 'string' } } } },
    { name: 'get_computed_styles', description: 'Get computed styles for selector', inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } },
    { name: 'get_source_location', description: 'Get source-map location for selector', inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } },
    { name: 'take_screenshot', description: 'Capture screenshot', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, full_page: { type: 'boolean' } } } },
    { name: 'get_recent_events', description: 'Get merged event stream', inputSchema: { type: 'object', properties: { since_ms: { type: 'number' }, types: { type: 'array', items: { type: 'string' } } }, required: ['since_ms'] } },
    { name: 'get_page_info', description: 'Current URL, title, viewport, user_agent, localStorage keys', inputSchema: { type: 'object', properties: {} } },
    { name: 'highlight_element', description: 'Pulse-highlight an element in the browser', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, duration_ms: { type: 'number' } }, required: ['selector'] } },
    { name: 'scroll_to', description: 'Scroll element into view', inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } },
    { name: 'navigate_to', description: 'Navigate iframe to URL', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    { name: 'reload', description: 'Reload iframe', inputSchema: { type: 'object', properties: {} } },
    { name: 'evaluate_in_page', description: 'Run JS in iframe (requires user confirmation in terminal)', inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
];
const VC_INSTRUCTIONS = `
Visual Companion is a split-pane development environment: a Chrome window
with the user's web app on the left and this Claude session on the right.
The user can Alt+Click (or Alt+drag for regions) on any element in the
left pane to "select" it for debugging.

## What happens when the user selects an element

The user alt+shift-clicks elements (or alt+shift-drags regions) in the
left pane. Every pick ACCUMULATES into a multi-select buffer shown as
numbered chips above the terminal. Each pick has two server-side
effects:

1. The daemon auto-injects a context marker into the user's next prompt:
     [markiert: #1=<sel>·<path> · "<text>" ; #2=<sel>·<path> · "<text>"]
   With one pick the marker uses a single entry; with multiple picks
   it lists all of them by their label (#1, #2, …). The user does NOT
   have to say "this element" or paste a selector — the prefix is
   already inline in the message they send.

2. The element's full details (DOM, computed styles, screenshot, source-
   map location, ancestors) are buffered in the daemon and available
   through MCP tools.

## Single vs multi selection

- If the prefix has ONE [markiert: …] entry: call \`get_pointed_element\`.
- If the prefix has MULTIPLE labels (#1, #2, …) OR the user refers to
  them by number ("schau dir #1 und #3 an", "was ist der Unterschied
  zwischen Box 1 und Box 2", "vergleich die Boxen"): call
  \`get_pointed_elements\` to get all of them at once. The response
  array's \`label\` field maps each payload to the user's reference.

## Your obligation on every user turn

Whenever the user's message contains a "[markiert: ...]" prefix (or they
refer to "hier", "das hier", "this element", "the box", "das markierte",
"this thing", "diese Box" etc.), you MUST call \`get_pointed_element\`
before answering. The selector in the prefix is a hint; the tool call
gives you the actual styles, screenshot, and source file location — that
is what the user installed Visual Companion to get.

Do NOT answer "which element?" or "I don't see a selection" — the
selection is in the prefix you just received, and \`get_pointed_element\`
will confirm it.

## When the user mentions errors or console output

If the user says anything like "there's an error", "das klappt nicht",
"schau in die Konsole", "check the console", "warum geht das nicht",
"die Seite zeigt ein Fehler", "it's broken" — call \`get_console_logs\`
FIRST (with since_ms: 60000) BEFORE asking the user to paste the error.
The captured stream has every console.log/warn/error and every thrown
exception from the last few minutes. This is the whole point of the
companion: the user should never have to copy-paste console output.

If the issue looks network-related (API call, fetch, loading state,
404/500 complaints) also call \`get_network_requests\` the same way.

## Common tools (full list via ListTools)

- get_pointed_element    — last Alt-clicked element, full context
- get_pointed_history    — last N selections
- get_computed_styles    — styles for any CSS selector
- get_source_location    — source-map file:line for a selector
- take_screenshot        — element or full page
- get_console_logs       — live console from the pane
- get_network_requests   — live network from the pane
- highlight_element      — pulse a selector in the browser (great for
                           confirming you're looking at the right thing)
- navigate_to / reload   — move the iframe

## Editing the app

The user's project is this session's cwd. When the user asks to change
something they selected, you already know (from get_pointed_element's
sourceLocation) which file to edit — edit it directly; Turbopack/HMR
will hot-reload the pane.
`.trim();
const server = new Server({ name: 'visual-companion-mcp', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: VC_INSTRUCTIONS });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (!client) {
        return { content: [{ type: 'text', text: 'No visual companion active. Run /visual-companion first.' }], isError: true };
    }
    try {
        const result = await client.call(`/_companion/mcp/${req.params.name}`, req.params.arguments ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
});
const transport = new StdioServerTransport();
await server.connect(transport);
//# sourceMappingURL=mcp-entry.js.map