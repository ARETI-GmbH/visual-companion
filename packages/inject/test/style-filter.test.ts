import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { filterComputedStyles } from '../src/style-filter';

describe('filterComputedStyles', () => {
  it('groups styles into layout/typography/colors/spacing', () => {
    const dom = new JSDOM('<div style="display:flex;width:100px;font-size:14px;color:red;padding:4px"></div>');
    const el = dom.window.document.querySelector('div')!;
    const styles = dom.window.getComputedStyle(el);
    const filtered = filterComputedStyles(styles);
    expect(filtered.layout.display).toBe('flex');
    expect(filtered.typography['font-size']).toBe('14px');
    expect(filtered.colors.color).toBeDefined();
    expect(filtered.spacing.padding).toBeDefined();
  });
});
