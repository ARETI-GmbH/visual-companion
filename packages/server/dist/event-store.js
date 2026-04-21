export class EventStore {
    opts;
    events = [];
    constructor(opts) {
        this.opts = opts;
    }
    append(event) {
        this.events.push(event);
        this.evictIfNeeded();
    }
    querySince(sinceMs) {
        return this.events.filter((e) => e.timestamp >= sinceMs);
    }
    query(opts) {
        let out = this.events;
        if (opts.sinceMs !== undefined)
            out = out.filter((e) => e.timestamp >= opts.sinceMs);
        if (opts.types)
            out = out.filter((e) => opts.types.includes(e.type));
        if (opts.limit !== undefined)
            out = out.slice(-opts.limit);
        return out;
    }
    getLatestPointer() {
        for (let i = this.events.length - 1; i >= 0; i--) {
            if (this.events[i].type === 'pointer')
                return this.events[i];
        }
        return null;
    }
    prune() {
        const cutoff = Date.now() - this.opts.maxAgeMs;
        this.events = this.events.filter((e) => e.timestamp >= cutoff);
    }
    size() {
        return this.events.length;
    }
    evictIfNeeded() {
        if (this.events.length > this.opts.maxEvents) {
            this.events.splice(0, this.events.length - this.opts.maxEvents);
        }
    }
}
//# sourceMappingURL=event-store.js.map