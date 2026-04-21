export declare class ScreenshotCache {
    private readonly maxSize;
    private map;
    constructor(maxSize: number);
    set(id: string, data: Buffer): void;
    get(id: string): Buffer | undefined;
    size(): number;
}
