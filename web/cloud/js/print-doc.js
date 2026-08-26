// Save-or-print for standalone HTML documents the browser builds locally: the
// Emergency Kit (signup.js) and the doctor-visit brief
// (web/static/js/features/brief.js, med-5k6t.2). Both need exactly the same
// two moves — a Blob download that survives Safari's revoke race, and an
// offscreen iframe that prints the document itself instead of the surrounding
// app chrome — so they live here once.
//
// Nothing here touches the network: the document is a string already in
// memory, the download is a blob: URL (an opaque UUID that never lands in a
// request or a log), and printing renders it in-process. That is the whole
// privacy story for both callers.
//
// `doc` is a parameter rather than the global `document` because this module
// is imported statically by the cloud shell AND dynamic-imported from the
// web/static app (`import('/js/print-doc.js')`), and the unit tests evaluate
// it outside any browser realm — the same seam privacy.js uses.

// Returns false when the browser refuses the download (in-app browsers and a
// few privacy modes do), so the caller can fall back to print.
export function downloadDoc(doc, html, filename) {
  try {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const a = doc.createElement('a');
    a.href = url;
    a.download = filename;
    doc.body.appendChild(a);
    a.click();
    a.remove();
    // Deferred: revoking synchronously can cancel the download in Safari.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return true;
  } catch (e) {
    console.error('[print-doc] download failed');
    return false;
  }
}

// An offscreen iframe rather than window.print(): it prints the document
// itself, identically to the downloaded file, instead of the app chrome.
// `className` is the caller's offscreen-frame class — the two stylesheets
// (cloud.css `.kit-print-frame`, styles.css `.wg-brief-print-frame`) position
// it off-canvas rather than display:none, because a hidden iframe does not
// lay out and the print dialog needs a rendered document.
//
// `css` is the document's own stylesheet, adopted into the frame after load.
// It is not redundant with the <style> the document already carries: this
// origin serves `style-src 'self'` on every response (internal/cloudserver/
// router.go cspPolicy), and an iframe inherits the embedder's policy — srcdoc,
// sandbox and blob: alike, all three verified — so that inline <style> is
// parsed but refused, and the brief would print with no layout and invisible
// charts. A constructed stylesheet is script-driven, not a style-src subject,
// and applies. The inline <style> stays because it is what makes the
// *downloaded* file standalone on disk and what styles the print anywhere the
// policy does not apply; under CSP it costs one console violation per print.
export function printDoc(doc, html, className, css) {
  const frame = doc.createElement('iframe');
  frame.className = className;
  frame.setAttribute('aria-hidden', 'true');
  frame.srcdoc = html;
  frame.addEventListener('load', () => {
    const win = frame.contentWindow;
    try {
      // Constructed in the FRAME's realm — adoptedStyleSheets rejects a sheet
      // built by another document.
      //
      // ponytail: a browser with no constructed stylesheets falls back to the
      // inline <style>, which this origin's CSP refuses — so it prints
      // unstyled. That is Chrome < 73, Firefox < 101, Safari < 16.4, none of
      // which can unlock a vault here at all (cloud unlock needs WebAuthn PRF:
      // Safari 18+, Chrome 116+). Upgrade path if that ever stops holding:
      // serve the document CSS as a real file and <link> it — same-origin, so
      // style-src 'self' allows it — instead of adopting.
      const supported = !!win && typeof win.CSSStyleSheet === 'function'
        && typeof win.CSSStyleSheet.prototype.replaceSync === 'function'
        && 'adoptedStyleSheets' in frame.contentDocument;
      if (css && supported) {
        const sheet = new win.CSSStyleSheet();
        sheet.replaceSync(css);
        frame.contentDocument.adoptedStyleSheets = [sheet];
      }
    } catch (e) {
      console.error('[print-doc] stylesheet adoption failed');
    }
    try {
      win.focus();
      win.print();
    } catch (e) {
      console.error('[print-doc] print failed');
    }
  });
  doc.body.appendChild(frame);
}
