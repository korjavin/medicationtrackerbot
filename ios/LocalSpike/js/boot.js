// Classic script (bd med-o7zq.1): records CSP violations from the very start of
// the document, and reports a module failure if main.js never runs.
window.__wgViolations = [];
document.addEventListener('securitypolicyviolation', function (e) {
  window.__wgViolations.push(e.violatedDirective + ' ' + (e.blockedURI || ''));
});
setTimeout(function () {
  if (window.__wgMainRan) return;
  var msg = '#3 FAIL ES module /js/main.js did not run within 5 s (MIME, CSP or module loading)';
  var status = document.getElementById('status');
  if (status) status.textContent = msg;
  var h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.wgSpike;
  if (h) h.postMessage({ op: 'report', text: msg + '\nviolations: ' + window.__wgViolations.join('; ') });
}, 5000);
