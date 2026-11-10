// Appended only to the update QA part's Debug soft-authenticator script.
// It observes the real page and asks its real visibility listener to recheck;
// it neither creates a worker nor shows the product's banner.
(() => {
  if (location.pathname !== '/') return;
  const events = [];
  document.addEventListener('visibilitychange', (event) => {
    events.push(`${document.visibilityState}:${event.isTrusted}`);
  });
  let button;
  async function report() {
    const reg = await navigator.serviceWorker.getRegistration();
    const state = {
      build: document.querySelector('meta[name="medtracker-build-id"]')?.content || '',
      controlled: !!navigator.serviceWorker.controller,
      waiting: reg?.waiting?.state || '',
      banners: document.querySelectorAll('#cloud-update-banner').length,
      visibility: document.visibilityState,
      events: events.join(','),
    };
    button.setAttribute('aria-label', 'QA update ' + JSON.stringify(state));
  }
  document.addEventListener('DOMContentLoaded', () => {
    button = document.createElement('button');
    button.textContent = 'QA update probe';
    button.style.cssText = 'position:fixed;top:0;right:0;z-index:2147483647;font-size:8px';
    button.addEventListener('click', () => {
      document.dispatchEvent(new Event('visibilitychange'));
      setTimeout(report, 1000);
    });
    document.body.appendChild(button);
    setInterval(report, 500);
    report();
  }, { once: true });
})();
