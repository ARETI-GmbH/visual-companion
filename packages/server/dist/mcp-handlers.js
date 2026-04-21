export function registerMcpHandlers(app, opts) {
    const { store, gateway, pty, buffer } = opts;
    // --- QUERY TOOLS (data lives in event store) ---
    app.post('/_companion/mcp/get_pointed_element', async () => {
        // Prefer the buffer: if the user has multiple selections active,
        // "the element" colloquially means the MOST RECENT one they
        // picked, which is the last item in the buffer. Falling back to
        // the event store covers the case where the user has cleared
        // (buffer empty) but still wants historical context.
        const latest = buffer.list().at(-1);
        if (latest)
            return latest.payload;
        const evt = store.getLatestPointer();
        return evt ? evt.payload : null;
    });
    app.post('/_companion/mcp/get_pointed_elements', async () => {
        // Full multi-select buffer. Each entry has {id, label, kind,
        // url, pathname, selector, textPreview, payload, addedAt} —
        // the label ("#1", "#2", …) is what the user referenced in
        // their prompt prefix, so claude can map label → payload.
        return buffer.list();
    });
    app.post('/_companion/mcp/get_pointed_history', async (req) => {
        const { count = 10 } = req.body ?? {};
        const pointers = store.query({ types: ['pointer'] }).slice(-count);
        return pointers.map((e) => e.payload);
    });
    app.post('/_companion/mcp/get_console_logs', async (req) => {
        const { since_ms, level } = req.body ?? {};
        let logs = store.query({ types: ['console'], sinceMs: since_ms });
        if (level)
            logs = logs.filter((e) => e.payload.level === level);
        return logs;
    });
    app.post('/_companion/mcp/get_network_requests', async (req) => {
        const { since_ms, filter } = req.body ?? {};
        let reqs = store.query({ types: ['network'], sinceMs: since_ms });
        if (filter) {
            reqs = reqs.filter((e) => {
                const p = e.payload;
                if (filter.method && p.method !== filter.method)
                    return false;
                if (filter.url_contains && !p.url.includes(filter.url_contains))
                    return false;
                if (filter.status_range) {
                    const [lo, hi] = filter.status_range;
                    if (p.status < lo || p.status > hi)
                        return false;
                }
                return true;
            });
        }
        return reqs;
    });
    app.post('/_companion/mcp/get_recent_events', async (req) => {
        const { since_ms, types } = req.body;
        return store.query({ sinceMs: since_ms, types: types });
    });
    // --- QUERY TOOLS (proxied to browser via WS response-roundtrip) ---
    app.post('/_companion/mcp/get_dom_snapshot', async (req) => {
        const { selector } = req.body ?? {};
        return proxyToBrowser(gateway, { kind: 'dom_snapshot', selector });
    });
    app.post('/_companion/mcp/get_computed_styles', async (req) => {
        const { selector } = req.body;
        return proxyToBrowser(gateway, { kind: 'computed_styles', selector });
    });
    app.post('/_companion/mcp/get_source_location', async (req) => {
        const { selector } = req.body;
        return proxyToBrowser(gateway, { kind: 'source_location', selector });
    });
    app.post('/_companion/mcp/take_screenshot', async (req) => {
        const body = req.body ?? {};
        return proxyToBrowser(gateway, { kind: 'screenshot', ...body });
    });
    app.post('/_companion/mcp/get_page_info', async () => {
        return proxyToBrowser(gateway, { kind: 'page_info' });
    });
    // --- ACTION TOOLS ---
    app.post('/_companion/mcp/highlight_element', async (req) => {
        const { selector, duration_ms = 800 } = req.body;
        gateway.broadcast({ type: 'highlight', selector, durationMs: duration_ms });
        return { ok: true };
    });
    app.post('/_companion/mcp/scroll_to', async (req) => {
        const { selector } = req.body;
        gateway.broadcast({ type: 'scroll_to', selector });
        return { ok: true };
    });
    app.post('/_companion/mcp/navigate_to', async (req) => {
        const { url } = req.body;
        gateway.broadcast({ type: 'navigate', url });
        return { ok: true };
    });
    app.post('/_companion/mcp/reload', async () => {
        gateway.broadcast({ type: 'reload' });
        return { ok: true };
    });
    app.post('/_companion/mcp/evaluate_in_page', async (req) => {
        const { expression } = req.body;
        // Don't interrupt claude's Ink TUI with a terminal-level [y/N]
        // prompt — the two render streams fight for cursor positions
        // and leave the terminal visibly corrupted (wrapping, ghost
        // characters, scrolled prompts). Log the expression to stderr
        // for audit and proceed. The user can `/visual-companion-stop`
        // if anything looks wrong.
        process.stderr.write(`[vc] evaluate_in_page: ${expression.slice(0, 400).replace(/\n/g, ' ')}\n`);
        void pty; // intentionally unused — kept in McpHandlersOptions for future
        return proxyToBrowser(gateway, { kind: 'evaluate', expression });
    });
}
async function proxyToBrowser(gateway, payload, timeoutMs = 5000) {
    return new Promise((resolve) => {
        const requestId = Math.random().toString(36).slice(2);
        const timeout = setTimeout(() => resolve({ error: 'timeout' }), timeoutMs);
        gateway.once(`response:${requestId}`, (data) => {
            clearTimeout(timeout);
            resolve(data);
        });
        gateway.broadcast({ type: 'evaluate', requestId, ...payload });
    });
}
// confirmInTerminal removed: see evaluate_in_page handler for rationale.
//# sourceMappingURL=mcp-handlers.js.map