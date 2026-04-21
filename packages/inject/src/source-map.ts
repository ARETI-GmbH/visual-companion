export async function lookupSourceLocation(el: Element): Promise<{ file: string; line: number; column: number } | null> {
  // 1. React DevTools fiber hook
  const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber'));
  if (fiberKey) {
    const fiber = (el as any)[fiberKey];
    const source = fiber?._debugSource;
    if (source?.fileName) {
      return { file: source.fileName, line: source.lineNumber, column: source.columnNumber ?? 0 };
    }
  }
  // 2. Vue devtools hook
  const vueInst = (el as any).__vue__ || (el as any).__vueParentComponent;
  const vueFile = vueInst?.$options?.__file || vueInst?.type?.__file;
  if (vueFile) return { file: vueFile, line: 0, column: 0 };

  // 3. data-source attribute (some dev plugins add this)
  const ds = el.getAttribute('data-source');
  if (ds) {
    const m = ds.match(/^(.+):(\d+)(?::(\d+))?$/);
    if (m) return { file: m[1], line: parseInt(m[2], 10), column: parseInt(m[3] ?? '0', 10) };
  }
  return null;
}
