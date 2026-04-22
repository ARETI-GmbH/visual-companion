/**
 * Multi-select buffer. Every Cmd-pick the user makes in the iframe
 * accumulates here. The buffer is the source of truth for:
 *   - the sticky `[markiert: ...]` prefix injected into claude's prompt
 *   - the `get_pointed_elements` MCP tool
 *   - the chips rendered in the shell panel above the terminal
 *   - restoring overlays after an iframe navigation (per-selection URL
 *     + selector lets us re-show frames on the correct page)
 *
 * IDs are monotonically increasing within a daemon lifetime — never
 * reused even after remove/clear. That makes them safe primary keys
 * for every downstream (WS messages, DOM overlay tracking, MCP).
 */
export class SelectionBuffer {
    items = [];
    counter = 0;
    add(selection) {
        this.counter += 1;
        const entry = {
            ...selection,
            id: `sel-${this.counter}`,
            label: `#${this.counter}`,
            addedAt: Date.now(),
        };
        this.items.push(entry);
        return entry;
    }
    remove(id) {
        const before = this.items.length;
        this.items = this.items.filter((i) => i.id !== id);
        return this.items.length !== before;
    }
    clear() {
        this.items = [];
        // Counter deliberately NOT reset — freshly-picked elements after
        // a clear continue numbering to avoid confusing claude with
        // "#1" that maps to a different selection than the earlier "#1".
    }
    rename(id, label) {
        const item = this.items.find((i) => i.id === id);
        if (!item)
            return false;
        item.label = label;
        return true;
    }
    /** Patch the MOST-RECENT buffer entry matching `cssSelector` with a
     *  screenshot dataURL. Used by the async enrichment path — inject
     *  emits the pointer event immediately with screenshotDataUrl:null
     *  so the chip appears instantly, then sends a pointer-enrich event
     *  once html2canvas finishes. We match by selector (most recent
     *  takes priority) so rapid successive picks on the same element
     *  patch the latest one. */
    enrichWithScreenshot(cssSelector, screenshotDataUrl) {
        for (let i = this.items.length - 1; i >= 0; i--) {
            const item = this.items[i];
            if (item.selector === cssSelector && !item.payload.screenshotDataUrl) {
                item.payload.screenshotDataUrl = screenshotDataUrl;
                return true;
            }
        }
        return false;
    }
    list() {
        return this.items.slice();
    }
    summaries() {
        return this.items.map((i) => ({
            id: i.id,
            label: i.label,
            kind: i.kind,
            url: i.url,
            pathname: i.pathname,
            selector: i.selector,
            textPreview: i.textPreview,
            ...(i.regionRect ? { regionRect: i.regionRect } : {}),
        }));
    }
    size() {
        return this.items.length;
    }
    /**
     * Format the sticky prefix claude sees before every prompt. Single
     * and multi-element prefixes use different MCP-tool hints because
     * `get_pointed_element` (singular) returns only the latest and
     * would hide the other picks; `get_pointed_elements` (plural)
     * returns the whole buffer.
     */
    buildPrefix() {
        if (this.items.length === 0)
            return null;
        const parts = this.items.map((i) => {
            const text = i.textPreview ? ` · "${i.textPreview}"` : '';
            return `${i.label}=${i.selector}·${i.pathname}${text}`;
        });
        const tool = this.items.length === 1 ? 'get_pointed_element' : 'get_pointed_elements';
        return `[markiert: ${parts.join(' ; ')} — bitte zuerst MCP ${tool} aufrufen] `;
    }
}
//# sourceMappingURL=selection-buffer.js.map