// jsdom does not expose CSS on its windows. Polyfill it on globalThis with a
// getter so that tests which reassign `globalThis.CSS = d.window.CSS` (where
// `d.window.CSS` is undefined) do not wipe out CSS.escape.
function escape(value: string): string {
  // Minimal spec-compliant CSS.escape polyfill (MDN reference implementation).
  const s = String(value);
  const length = s.length;
  let index = -1;
  let codeUnit: number;
  let result = '';
  const firstCodeUnit = s.charCodeAt(0);
  while (++index < length) {
    codeUnit = s.charCodeAt(index);
    if (codeUnit === 0x0000) {
      result += '�';
      continue;
    }
    if (
      (codeUnit >= 0x0001 && codeUnit <= 0x001f) ||
      codeUnit === 0x007f ||
      (index === 0 && codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (index === 1 && codeUnit >= 0x0030 && codeUnit <= 0x0039 && firstCodeUnit === 0x002d)
    ) {
      result += '\\' + codeUnit.toString(16) + ' ';
      continue;
    }
    if (index === 0 && length === 1 && codeUnit === 0x002d) {
      result += '\\' + s.charAt(index);
      continue;
    }
    if (
      codeUnit >= 0x0080 ||
      codeUnit === 0x002d ||
      codeUnit === 0x005f ||
      (codeUnit >= 0x0030 && codeUnit <= 0x0039) ||
      (codeUnit >= 0x0041 && codeUnit <= 0x005a) ||
      (codeUnit >= 0x0061 && codeUnit <= 0x007a)
    ) {
      result += s.charAt(index);
      continue;
    }
    result += '\\' + s.charAt(index);
  }
  return result;
}

const cssStub: { escape: (v: string) => string } = { escape };

// Define CSS on globalThis with a setter that preserves .escape when callers
// assign a CSS object that is missing it (e.g. `(globalThis as any).CSS = jsdomWindow.CSS`).
let currentCSS: any = cssStub;
Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  get() {
    return currentCSS;
  },
  set(value: any) {
    if (value && typeof value.escape === 'function') {
      currentCSS = value;
    } else if (value && typeof value === 'object') {
      currentCSS = { ...value, escape };
    } else {
      currentCSS = cssStub;
    }
  },
});
