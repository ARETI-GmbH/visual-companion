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
export declare class EventStore {
    private readonly opts;
    private events;
    constructor(opts: EventStoreOptions);
    append(event: CompanionEvent): void;
    querySince(sinceMs: number): CompanionEvent[];
    query(opts: QueryOptions): CompanionEvent[];
    getLatestPointer(): CompanionEvent | null;
    prune(): void;
    size(): number;
    private evictIfNeeded;
}
