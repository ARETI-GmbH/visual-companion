export class ScreenshotCache {
  private map = new Map<string, Buffer>();
  constructor(private readonly maxSize: number) {}

  set(id: string, data: Buffer): void {
    if (this.map.has(id)) this.map.delete(id);
    this.map.set(id, data);
    if (this.map.size > this.maxSize) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
  }

  get(id: string): Buffer | undefined {
    const val = this.map.get(id);
    if (val === undefined) return undefined;
    this.map.delete(id);
    this.map.set(id, val);
    return val;
  }

  size(): number {
    return this.map.size;
  }
}
