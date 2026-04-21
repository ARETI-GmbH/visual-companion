export class ScreenshotCache {
    maxSize;
    map = new Map();
    constructor(maxSize) {
        this.maxSize = maxSize;
    }
    set(id, data) {
        if (this.map.has(id))
            this.map.delete(id);
        this.map.set(id, data);
        if (this.map.size > this.maxSize) {
            const firstKey = this.map.keys().next().value;
            if (firstKey !== undefined)
                this.map.delete(firstKey);
        }
    }
    get(id) {
        const val = this.map.get(id);
        if (val === undefined)
            return undefined;
        this.map.delete(id);
        this.map.set(id, val);
        return val;
    }
    size() {
        return this.map.size;
    }
}
//# sourceMappingURL=screenshot-cache.js.map