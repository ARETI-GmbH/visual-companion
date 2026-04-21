export function registerMcpHandlers(app, opts) {
    const { store, gateway, pty } = opts;
    // --- QUERY TOOLS (data lives in event store) ---
    app.post('/_companion/mcp/get_pointed_element', async () => {
        const evt = store.getLatestPointer();
        return evt ? evt.payload : null;
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
        const confirmed = await confirmInTerminal(pty, expression);
        if (!confirmed)
            return { cancelled: true };
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
async function confirmInTerminal(pty, expression) {
    return new Promise((resolve) => {
        const prompt = `\r\n\x1b[33m[visual-companion]\x1b[0m Claude wants to evaluate:\r\n\x1b[90m${expression.slice(0, 400)}\x1b[0m\r\nAllow? [y/N] `;
        pty.writeToTerminal(prompt);
        let buffer = '';
        const timeout = setTimeout(() => {
            unsubscribe();
            pty.writeToTerminal('\r\n[timeout — denied]\r\n');
            resolve(false);
        }, 30_000);
        const unsubscribe = pty.onTerminalInput((data) => {
            for (const char of data) {
                if (char === '\r' || char === '\n') {
                    const answer = buffer.trim().toLowerCase();
                    clearTimeout(timeout);
                    unsubscribe();
                    pty.writeToTerminal('\r\n');
                    resolve(answer === 'y' || answer === 'yes');
                    return;
                }
                if (char === '\x7f' || char === '\b') {
                    buffer = buffer.slice(0, -1);
                }
                else if (char >= ' ' && char <= '~') {
                    buffer += char;
                }
            }
        });
    });
}
//# sourceMappingURL=mcp-handlers.js.map