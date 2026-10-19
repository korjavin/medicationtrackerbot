// Document-start script on the account origins (Files.kt, bd med-nt9p.10),
// twin of Downloads.printShim in ios/App/App.swift. WebView does nothing with
// <a download> of a blob:/data: URL or with window.print(), so both go to the
// shell over window.wgFiles. No web code changes.
(() => {
  const h = window.wgFiles;
  if (!h || window.top !== window) return;
  const send = (m) => h.postMessage(JSON.stringify(m));

  // The Blob behind each blob: URL, so a download survives the page revoking
  // the URL right after click() (core/utils.js downloadBlobAsFile does).
  const blobs = new Map();
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  URL.createObjectURL = function (o) {
    const url = create.call(URL, o);
    if (o instanceof Blob) blobs.set(url, o);
    return url;
  };
  URL.revokeObjectURL = function (url) {
    blobs.delete(url);
    return revoke.call(URL, url);
  };

  addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
    if (!a || !/^(blob|data):/i.test(a.href)) return;
    e.preventDefault();
    const name = a.getAttribute('download') || 'download';
    const held = blobs.get(a.href);
    (held ? Promise.resolve(held) : fetch(a.href).then((r) => r.blob()))
      .then((b) => new Promise((ok, fail) => {
        const r = new FileReader();
        r.onload = () => ok(r.result);
        r.onerror = fail;
        r.readAsDataURL(b);
      }))
      .then((data) => send({ op: 'download', name, data }))
      .catch(() => {
        // Never silent (bd med-nvd4): the page already said "ready".
        console.error('[shell] download failed');
        if (typeof window.safeToast === 'function') window.safeToast('The file could not be handed to Android. Try again.', 'error');
      });
  }, true);

  // print-doc.js prints an offscreen same-origin iframe through
  // frame.contentWindow.print(): the contentWindow getter patches that frame's
  // print on the way out and sends its document. A cross-origin frame throws on
  // the assignment and keeps its own print.
  window.print = () => send({ op: 'print' });
  const d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
  if (!d || !d.get) return;
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    enumerable: d.enumerable,
    get() {
      const w = d.get.call(this);
      try {
        if (w && !w.__wgPrint) {
          w.print = () => send({ op: 'print', html: w.document.documentElement.outerHTML });
          w.__wgPrint = true;
        }
      } catch (_) {}
      return w;
    },
  });
})();
