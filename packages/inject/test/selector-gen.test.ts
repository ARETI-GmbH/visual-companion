import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { uniqueSelector } from '../src/selector-gen';

function dom(html: string): Document {
  const d = new JSDOM(html);
  // selector-gen uses document from globalThis, so attach
  (globalThis as any).document = d.window.document;
  (globalThis as any).CSS = d.window.CSS;
  return d.window.document;
}

describe('uniqueSelector', () => {
  it('returns #id when id is unique', () => {
    const d = dom('<div id="hero"></div>');
    expect(uniqueSelector(d.querySelector('#hero')!)).toBe('#hero');
  });

  it('returns tag + class path when no id', () => {
    const d = dom('<div class="a"><span class="b c">x</span></div>');
    const el = d.querySelector('span')!;
    const sel = uniqueSelector(el);
    expect(d.querySelectorAll(sel)).toHaveLength(1);
  });

  it('uses nth-of-type when siblings share selector', () => {
    const d = dom('<ul><li class="x"></li><li class="x"></li><li class="x"></li></ul>');
    const el = d.querySelectorAll('li')[1];
    const sel = uniqueSelector(el);
    expect(d.querySelectorAll(sel)).toHaveLength(1);
  });

  it('ignores auto-generated framework classes (css modules, emotion)', () => {
    const d = dom('<button class="Button_button__xK3pQ button-primary">x</button>');
    const sel = uniqueSelector(d.querySelector('button')!);
    expect(sel).not.toContain('Button_button__xK3pQ');
    expect(sel).toContain('button-primary');
  });
});
