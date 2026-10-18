// Document-start script on the account origins (MainActivity.kt), twin of
// Shell.pageJS in ios/App/Shell.swift: asks for persistent storage and reports
// the background colour at the page's top and bottom edge for the native
// bands behind the status and navigation bars. Reads styles only — it sets
// none (the page CSP is style-src 'self').
(() => {
  const h = window.wgNative;
  if (!h || window.top !== window) return;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const clear = (c) => !c || c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c);
  const bg = (el) => {
    for (; el; el = el.parentElement) {
      const c = getComputedStyle(el).backgroundColor;
      if (!clear(c)) return c;
    }
    return '';
  };
  let last = '', timer = 0;
  const sample = () => {
    timer = 0;
    const x = innerWidth / 2;
    const m = { top: bg(document.elementFromPoint(x, 0)), bottom: bg(document.elementFromPoint(x, innerHeight - 1)) };
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
