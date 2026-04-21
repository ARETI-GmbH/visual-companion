import { describe, expect, it } from 'vitest';
import { ScreenshotCache } from '../src/screenshot-cache';

describe('ScreenshotCache', () => {
  it('stores and retrieves by id', () => {
    const cache = new ScreenshotCache(10);
    cache.set('abc', Buffer.from('png-bytes'));
    expect(cache.get('abc')?.toString()).toBe('png-bytes');
  });

  it('evicts LRU when over capacity', () => {
    const cache = new ScreenshotCache(2);
    cache.set('a', Buffer.from('1'));
    cache.set('b', Buffer.from('2'));
    cache.set('c', Buffer.from('3'));
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')?.toString()).toBe('2');
    expect(cache.get('c')?.toString()).toBe('3');
  });

  it('refreshes recency on get', () => {
    const cache = new ScreenshotCache(2);
    cache.set('a', Buffer.from('1'));
    cache.set('b', Buffer.from('2'));
    cache.get('a'); // mark 'a' as recent
    cache.set('c', Buffer.from('3'));
    expect(cache.get('a')?.toString()).toBe('1');
    expect(cache.get('b')).toBeUndefined();
  });
});
