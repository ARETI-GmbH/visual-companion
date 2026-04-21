const LAYOUT_PROPS = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'width', 'height',
  'min-width', 'min-height', 'max-width', 'max-height', 'overflow',
  'flex', 'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-self',
  'gap', 'grid-template-columns', 'grid-template-rows', 'grid-area',
  'z-index',
];
const TYPOGRAPHY_PROPS = [
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
  'letter-spacing', 'text-align', 'text-decoration', 'text-transform', 'white-space',
];
const COLOR_PROPS = ['color', 'background-color', 'background', 'border-color', 'opacity'];
const SPACING_PROPS = [
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-width', 'border-radius',
];

export function filterComputedStyles(styles: CSSStyleDeclaration): {
  layout: Record<string, string>;
  typography: Record<string, string>;
  colors: Record<string, string>;
  spacing: Record<string, string>;
} {
  return {
    layout: pick(styles, LAYOUT_PROPS),
    typography: pick(styles, TYPOGRAPHY_PROPS),
    colors: pick(styles, COLOR_PROPS),
    spacing: pick(styles, SPACING_PROPS),
  };
}

function pick(styles: CSSStyleDeclaration, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = styles.getPropertyValue(k);
    if (v && v !== '' && v !== 'normal' && v !== 'auto' && v !== '0px') out[k] = v;
  }
  return out;
}
