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
export function printDoc(doc, html, className) {
  const frame = doc.createElement('iframe');
  frame.className = className;
  frame.setAttribute('aria-hidden', 'true');
  frame.srcdoc = html;
  frame.addEventListener('load', () => {
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch (e) {
      console.error('[print-doc] print failed');
    }
  });
  doc.body.appendChild(frame);
}
