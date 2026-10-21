// Document-start script on the account origins (MainActivity.kt), twin of
// Shell.pageJS in ios/App/Shell.swift (the stack sampling below is pending there, med-ta2n.17): asks for persistent storage and reports
// the background colour at the page's top and bottom edge for the native
// bands behind the status and navigation bars. Reads styles only — it sets
// none (the page CSP is style-src 'self').
(() => {
  const h = window.wgNative;
  if (!h || window.top !== window) return;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const clear = (c) => !c || c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c);
  // The first painted background in the stack at (x, y), not the topmost element's ancestors: a
  // transparent tap-catching backdrop (the web's F1 sheet over W1) has <body> as its parent, whose
  // colour is not what shows (bd med-ta2n.12: a white status band over W1). Translucent layers (a
  // dimming scrim) are blended over the first opaque one, as they paint.
  const bg = (x, y) => {
    const layers = [];
    for (const el of document.elementsFromPoint(x, y)) {
      const c = getComputedStyle(el).backgroundColor;
      if (clear(c)) continue;
      const [r, g, b, a = 1] = c.match(/[\d.]+/g).map(Number);
      layers.push([r, g, b, a]);
      if (a >= 1) break;
    }
    if (!layers.length) return '';
    const out = layers.reduceRight(([r0, g0, b0], [r, g, b, a]) => [r * a + r0 * (1 - a), g * a + g0 * (1 - a), b * a + b0 * (1 - a)], [0, 0, 0]);
    return `rgb(${out.map(Math.round).join(', ')})`;
  };
  let last = '', timer = 0;
  const sample = () => {
    timer = 0;
    const x = innerWidth / 2;
    const m = { top: bg(x, 0), bottom: bg(x, innerHeight - 1) };
    const s = m.top + '|' + m.bottom;
    if (s !== last) { last = s; h.postMessage(JSON.stringify({ op: 'chrome', args: m })); }
  };
  const soon = () => { if (!timer) timer = setTimeout(sample, 150); };
  const start = () => {
    new MutationObserver(soon).observe(document.documentElement,
      { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'open'] });
    soon();
  };
  addEventListener('load', soon);
  addEventListener('resize', soon);
  if (document.documentElement) start(); else addEventListener('DOMContentLoaded', start, { once: true });
})();
