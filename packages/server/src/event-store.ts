import type { CompanionEvent, EventType } from './types';

export interface EventStoreOptions {
  maxEvents: number;
  maxAgeMs: number;
}

export interface QueryOptions {
  sinceMs?: number;
  types?: EventType[];
  limit?: number;
}

export class EventStore {
  private events: CompanionEvent[] = [];
  constructor(private readonly opts: EventStoreOptions) {}

  append(event: CompanionEvent): void {
    this.events.push(event);
    this.evictIfNeeded();
  }

  querySince(sinceMs: number): CompanionEvent[] {
    return this.events.filter((e) => e.timestamp >= sinceMs);
  }

  query(opts: QueryOptions): CompanionEvent[] {
    let out = this.events;
    if (opts.sinceMs !== undefined) out = out.filter((e) => e.timestamp >= opts.sinceMs!);
    if (opts.types) out = out.filter((e) => opts.types!.includes(e.type));
    if (opts.limit !== undefined) out = out.slice(-opts.limit);
    return out;
  }

  getLatestPointer(): CompanionEvent | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].type === 'pointer') return this.events[i];
    }
    return null;
  }

  prune(): void {
    const cutoff = Date.now() - this.opts.maxAgeMs;
    this.events = this.events.filter((e) => e.timestamp >= cutoff);
  }

  size(): number {
    return this.events.length;
  }

  private evictIfNeeded(): void {
    if (this.events.length > this.opts.maxEvents) {
      this.events.splice(0, this.events.length - this.opts.maxEvents);
    }
  }
}
