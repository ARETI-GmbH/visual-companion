#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DaemonClient } from './mcp-tools.js';

const port = parseInt(process.env.VISUAL_COMPANION_PORT ?? '0', 10);
const client = port > 0 ? new DaemonClient(port) : null;

const TOOLS = [
  { name: 'get_pointed_element', description: 'Get the element the user just Alt+clicked or region-selected in the companion pane, with full context (DOM, computed styles, screenshot, source-map, ancestors). Call this whenever the user refers to "this element", "das hier", "the thing I selected", or whenever you see a [📍 companion] notification line in the terminal whose details you have not loaded yet.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_pointed_history', description: 'Get the last N elements the user pointed at (same payload as get_pointed_element). Useful when the user says "the one before that", compares two selections, or refers to an earlier selection.', inputSchema: { type: 'object', properties: { count: { type: 'number' } }, required: ['count'] } },
  { name: 'get_console_logs', description: 'Get console logs', inputSchema: { type: 'object', properties: { since_ms: { type: 'number' }, level: { type: 'string' } } } },
  { name: 'get_network_requests', description: 'Get network requests', inputSchema: { type: 'object', properties: { since_ms: { type: 'number' }, filter: { type: 'object' } } } },
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

const server = new Server({ name: 'visual-companion-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (!client) {
    return { content: [{ type: 'text', text: 'No visual companion active. Run /visual-companion first.' }], isError: true };
  }
  try {
    const result = await client.call(`/_companion/mcp/${req.params.name}`, req.params.arguments ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
