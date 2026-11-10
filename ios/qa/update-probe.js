// Appended only to the update QA part's Debug soft-authenticator script.
// It observes the real page and asks its real visibility listener to recheck;
// it neither creates a worker nor shows the product's banner.
(() => {
  if (location.pathname !== '/') return;
  const events = [];
  let updateSeenBeforeDegraded = false;
  new MutationObserver(() => {
    if (document.querySelector('#cloud-update-banner') && !document.querySelector('#boot-degraded-banner')) updateSeenBeforeDegraded = true;
  }).observe(document.documentElement, { childList: true, subtree: true });
  const pageNumber = Number(sessionStorage.getItem('qa-update-page-number') || 0) + 1;
  sessionStorage.setItem('qa-update-page-number', String(pageNumber));
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
      pageNumber,
      degraded: !!window.MedTrackerCloud?.degraded,
      specifier: window.MedTrackerCloud?.degraded?.error?.specifier || '',
      degradedBanners: document.querySelectorAll('#boot-degraded-banner').length,
      updateSeenBeforeDegraded,
      emptyTitle: document.querySelector('#fooddb-list .wg-empty__title')?.textContent?.trim() || '',
      emptyBody: document.querySelector('#fooddb-list .wg-empty__body')?.textContent?.trim() || '',
      action: button.dataset.action || '',
      detail: button.dataset.detail || '',
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
    async function action(name, work) {
      try {
        button.dataset.action = name + ':running';
        await report();
        const result = await work();
        button.dataset.detail = JSON.stringify(result ?? {});
        button.dataset.action = name + ':ok';
      } catch (error) {
        button.dataset.detail = String(error);
        button.dataset.action = name + ':error';
      }
      await report();
    }
    let actionIndex = 0;
    function addAction(label, work) {
      const control = document.createElement('button');
      control.textContent = 'QA ' + label;
      control.style.cssText = `position:fixed;top:${20 + actionIndex++ * 20}px;right:0;z-index:2147483647;font-size:8px`;
      control.addEventListener('click', () => action(label, work));
      document.body.appendChild(control);
    }
    addAction('evict', async () => {
      const saved = await caches.open('qa-b2-good-responses');
      const entries = [];
      for (const name of await caches.keys()) {
        if (name === 'qa-b2-good-responses') continue;
        const cache = await caches.open(name);
        for (const key of await cache.keys()) {
          if (new URL(key.url).pathname !== '/js/apishim.js') continue;
          const response = await cache.match(key);
          if (!response?.ok) throw new Error('module is not a good response');
          const savedURL = new URL('/__qa_saved_module_' + entries.length, location.origin).href;
          await saved.put(savedURL, response.clone());
          entries.push({ name, url: key.url, savedURL });
          await cache.delete(key);
        }
      }
      if (entries.length !== 2) throw new Error('expected A and B module responses, got ' + entries.length);
      sessionStorage.setItem('qa-b2-saved', JSON.stringify(entries));
      return entries;
    });
    addAction('restore', async () => {
      const entries = JSON.parse(sessionStorage.getItem('qa-b2-saved') || '[]');
      if (entries.length !== 2) throw new Error('saved module metadata missing');
      const saved = await caches.open('qa-b2-good-responses');
      for (const entry of entries) {
        const response = await saved.match(entry.savedURL);
        if (!response?.ok) throw new Error('saved module response missing');
        await (await caches.open(entry.name)).put(entry.url, response);
      }
      await caches.delete('qa-b2-good-responses');
      return entries;
    });
    addAction('clear-cache', async () => { await window.MedTrackerDB.ApiCache.clear(); });
    addAction('reload', async () => { location.reload(); });
    setInterval(report, 500);
    report();
  }, { once: true });
})();
