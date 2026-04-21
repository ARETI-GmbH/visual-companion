import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventStore } from '../src/event-store';
import type { CompanionEvent } from '../src/types';

function consoleEvent(ts: number, msg: string): CompanionEvent {
  return {
    id: `e-${ts}`,
    timestamp: ts,
    type: 'console',
    url: 'http://localhost:3000',
    payload: { level: 'log', args: [msg] },
  };
}

describe('EventStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('appends and queries events since a timestamp', () => {
    const store = new EventStore({ maxEvents: 100, maxAgeMs: 5 * 60_000 });
    store.append(consoleEvent(1000, 'a'));
    store.append(consoleEvent(2000, 'b'));
    store.append(consoleEvent(3000, 'c'));
    expect(store.querySince(2000)).toHaveLength(2);
  });

  it('filters by type', () => {
    const store = new EventStore({ maxEvents: 100, maxAgeMs: 5 * 60_000 });
    store.append(consoleEvent(1000, 'a'));
    store.append({
      id: 'p-1',
      timestamp: 1500,
      type: 'pointer',
      url: 'http://localhost:3000',
      payload: {} as any,
    });
    expect(store.query({ types: ['console'] })).toHaveLength(1);
    expect(store.query({ types: ['pointer'] })).toHaveLength(1);
  });

  it('evicts by maxEvents', () => {
    const store = new EventStore({ maxEvents: 3, maxAgeMs: Infinity });
    store.append(consoleEvent(1, 'a'));
    store.append(consoleEvent(2, 'b'));
    store.append(consoleEvent(3, 'c'));
    store.append(consoleEvent(4, 'd'));
    const all = store.query({});
    expect(all).toHaveLength(3);
    expect(all.map((e) => (e.payload as any).args[0])).toEqual(['b', 'c', 'd']);
  });

  it('evicts by maxAgeMs', () => {
    const nowMs = Date.now();
    const store = new EventStore({ maxEvents: 100, maxAgeMs: 1000 });
    store.append(consoleEvent(nowMs - 2000, 'old'));
    store.append(consoleEvent(nowMs - 500, 'recent'));
    store.prune();
    const all = store.query({});
    expect(all).toHaveLength(1);
    expect((all[0].payload as any).args[0]).toBe('recent');
  });

  it('getPointedElement returns latest pointer event', () => {
    const store = new EventStore({ maxEvents: 100, maxAgeMs: 5 * 60_000 });
    store.append(consoleEvent(1000, 'a'));
    store.append({
      id: 'p-1',
      timestamp: 2000,
      type: 'pointer',
      url: 'x',
      payload: { tagName: 'div' } as any,
    });
    store.append({
      id: 'p-2',
      timestamp: 3000,
      type: 'pointer',
      url: 'y',
      payload: { tagName: 'button' } as any,
    });
    const last = store.getLatestPointer();
    expect(last?.id).toBe('p-2');
  });
});
