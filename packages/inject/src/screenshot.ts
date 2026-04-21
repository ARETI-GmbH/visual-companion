import html2canvas from 'html2canvas';

export async function captureElementScreenshot(el: Element, paddingPx = 20): Promise<string | null> {
  try {
    const r = el.getBoundingClientRect();
    const canvas = await html2canvas(document.body, {
      x: Math.max(0, r.left - paddingPx),
      y: Math.max(0, r.top - paddingPx),
      width: r.width + paddingPx * 2,
      height: r.height + paddingPx * 2,
      backgroundColor: null,
      logging: false,
      scale: Math.min(window.devicePixelRatio, 2),
      useCORS: true,
    });
    return canvas.toDataURL('image/png');
  } catch (err) {
    console.debug('[visual-companion] screenshot failed:', err);
    return null;
  }
}
