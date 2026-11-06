// B2: reject the REAL post-unlock required module once; keep the real SW enabled.
// Good Responses are saved/evicted/restored per exact generation/key, never replaced by stubs.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { prepareAccount, control, state, checkSaved, foreground } from './update-banner.mjs';
import { waitForVault } from './smoke.mjs';
export const retry = false;

export default async function degradedBoot(ctx) {
  const r = (ctx.results.degradedBoot = { failures: [], console: [] });
  const page = await prepareAccount(ctx, r);
  if (!process.env.QA_RECEIPTS) throw new Error('QA_RECEIPTS unset');
  const receipts = () => readFileSync(process.env.QA_RECEIPTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const cdp = await page.context().newCDPSession(page);
  let savedResponses;
  await ctx.step('prepare real state C: A controlled, B completely installed and waiting', async () => {
    await control('/switch-b', {});
    await foreground(ctx, page);
    await page.locator('#cloud-update-banner').waitFor({ timeout: 60_000 });
    await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting, null, { timeout: 90_000 });
    r.beforeFault = await state(page);
    if (r.beforeFault.build !== r.bundles.A.stamp || r.beforeFault.waiting !== 'installed') throw new Error('real A/B state C missing');
    await ctx.stableShot('real-update-before-fault');
  });
  await ctx.step('preserve good apishim Responses and evict EVERY matching cache copy', async () => {
    savedResponses = await page.evaluate(async () => {
      const saved = [];
      const preserved = await caches.open('qa-b2-good-responses');
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const key of await cache.keys()) {
          if (new URL(key.url).pathname !== '/js/apishim.js') continue;
          const res = await cache.match(key);
          if (!res?.ok) throw new Error('cached module not good');
          // Different cache KEY: global caches.match(apishim) cannot bypass the fault.
          // Retain an actual Response clone, including browser response metadata/headers.
          const savedURL = new URL(`/__qa_saved_module_${saved.length}`, location.origin).href;
          await preserved.put(savedURL, res.clone());
          saved.push({ name, url: key.url, savedURL, status: res.status, headers: [...res.headers], body: await res.text() });
          await cache.delete(key);
        }
      }
      for (const name of await caches.keys()) {
        if ((await (await caches.open(name)).keys()).some((key) => new URL(key.url).pathname === '/js/apishim.js')) throw new Error('eviction incomplete');
      }
      return saved;
    });
    r.responses = savedResponses.map(({ body, ...meta }) => ({ ...meta, bytes: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex') }));
    if (savedResponses.length !== 2 || !r.responses.some((s) => s.name.endsWith(`v${r.bundles.A.stamp}`)) ||
        !r.responses.some((s) => s.name.endsWith(`v${r.bundles.B.stamp}`))) throw new Error('missing complete same-generation A/B responses');
    // HTTP cache disabled, SW still fully enabled. A NEW document clears its module map.
    await cdp.send('Network.enable');
    await cdp.send('Network.clearBrowserCache');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    r.receiptsBefore = receipts().length;
    await control('/arm', { host: new URL(page.url()).host });
  });
  page.on('console', (msg) => { if (/post-unlock boot failed|apishim|update banner failed/.test(msg.text())) r.console.push({ type: msg.type(), text: msg.text() }); });
  page.on('response', (res) => { if (new URL(res.url()).pathname === '/js/apishim.js') r.failures.push({ url: res.url(), status: res.status(), fromSW: res.fromServiceWorker() }); });
  await ctx.step('new document: real update notice is replaced by one degraded banner after actual 503', async () => {
    const reload = page.reload({ waitUntil: 'load' });
    // Do not wait for load: post-unlock import is deliberately held by the QA front.
    try {
      await page.waitForFunction((old) => performance.timeOrigin !== old, r.beforeFault.timeOrigin, { timeout: 4000 });
      await page.locator('#cloud-update-banner').waitFor({ timeout: 4000 });
      r.updateInFaultDocument = await page.evaluate(() => ({ timeOrigin: performance.timeOrigin, banners: document.querySelectorAll('#cloud-update-banner').length }));
    } finally { r.release = await control('/release', {}); }
    await reload;
    await page.locator('#boot-degraded-banner').waitFor({ timeout: 30_000 });
    r.fault = await page.evaluate(() => ({ timeOrigin: performance.timeOrigin,
      specifier: window.MedTrackerCloud?.degraded?.error?.specifier,
      message: window.MedTrackerCloud?.degraded?.error?.message,
      banners: document.querySelectorAll('#boot-degraded-banner').length,
      updates: document.querySelectorAll('#cloud-update-banner').length,
      text: document.querySelector('#boot-degraded-banner')?.textContent,
      reloadButtons: [...document.querySelectorAll('#boot-degraded-banner button')].map((b) => b.textContent) }));
    r.faultReceipts = receipts().slice(r.receiptsBefore).filter((q) => q.path === '/js/apishim.js');
    r.control = await control('/status');
    if (r.fault.timeOrigin !== r.updateInFaultDocument.timeOrigin || r.updateInFaultDocument.banners !== 1 ||
        r.fault.specifier !== '/js/apishim.js' || r.fault.banners !== 1 || r.fault.updates !== 0 ||
        !r.fault.text.includes('Some saved data did not load. Reload to fix.') || r.fault.reloadButtons.join() !== 'Reload' ||
        r.control.consumed !== 1 || r.control.armed || r.faultReceipts.length !== 1 || !r.failures.some((q) => q.status === 503)) throw new Error(`fault not faithfully consumed: ${JSON.stringify(r.fault)}`);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await ctx.sleep(3000);
    if (await page.locator('#cloud-update-banner').count()) throw new Error('update notice returned over degraded banner');
    if (await page.evaluate(() => performance.timeOrigin) !== r.fault.timeOrigin) throw new Error('automatic reload after degradation');
    await ctx.stableShot('degraded-replaced-update');
  });
  await ctx.step('restore original good Responses to their exact generation/cache keys', async () => {
    r.restored = await page.evaluate(async (saved) => {
      const out = [];
      const preserved = await caches.open('qa-b2-good-responses');
      for (const s of saved) {
        const cache = await caches.open(s.name);
        const good = await preserved.match(s.savedURL);
        if (!good?.ok) throw new Error('preserved good Response missing');
        await cache.put(s.url, good);
        const actual = await cache.match(s.url);
        if ((await actual.text()) !== s.body) throw new Error('restored module differs');
        out.push({ name: s.name, url: s.url });
      }
      await caches.delete('qa-b2-good-responses');
      return out;
    }, savedResponses);
  });
  const savedRadios = r.radiosBefore = {
    airplane: (await ctx.shell('settings get global airplane_mode_on')).trim(),
    wifi: (await ctx.shell('settings get global wifi_on')).trim(),
    data: (await ctx.shell('settings get global mobile_data')).trim(),
  };
  try {
    await ctx.step('actual radios off: failed read offers Reload; title gap med-31gk recorded', async () => {
      await ctx.shell('cmd connectivity airplane-mode enable');
      await ctx.shell('svc wifi disable');
      await ctx.shell('svc data disable');
      await page.waitForFunction(() => !navigator.onLine, null, { timeout: 30_000 });
      r.radiosOff = { airplane: (await ctx.shell('settings get global airplane_mode_on')).trim(),
        wifi: (await ctx.shell('settings get global wifi_on')).trim(), data: (await ctx.shell('settings get global mobile_data')).trim() };
      if (r.radiosOff.airplane !== '1' || r.radiosOff.wifi !== '0' || r.radiosOff.data !== '0') throw new Error('radios still enabled');
      await page.evaluate(async () => {
        await window.MedTrackerDB.ApiCache.clear();
        window.switchTab('food');
      });
      await page.locator('.food-tab[data-tab="fooddb"]').click();
      await page.locator('#fooddb-list').getByText('Some saved data did not load. Reload to fix.', { exact: true }).waitFor({ timeout: 30_000 });
      r.emptyState = await page.locator('#fooddb-list').innerText();
      // R4 / Archie17508: this known product defect is OUTSIDE the tests-only go.
      r.manualGap = { bead: 'med-31gk', title: 'No cached data yet', observed: r.emptyState.includes('No cached data yet') };
      await ctx.stableShot('offline-error-reload-title-gap');
    });
    await ctx.step('real Reload: exactly one offline B document, good module/cache/controller and saved data', async () => {
      let loads = 0;
      const count = () => loads++;
      page.on('load', count);
      const before = receipts().length;
      try {
        await ctx.tapElement(page, '#boot-degraded-banner button');
        await page.waitForFunction((stamp) => document.querySelector('meta[name="medtracker-build-id"]')?.content === stamp, r.bundles.B.stamp, { timeout: 60_000 });
        await waitForVault(page);
        r.savedAfter = await checkSaved(page, r.note);
        await ctx.sleep(3500);
        r.recovered = await state(page);
        r.reloadDocuments = loads;
        r.receiptsOffline = receipts().slice(before).filter((q) => q.host === new URL(page.url()).host);
        if (loads !== 1 || r.recovered.timeOrigin === r.fault.timeOrigin || !r.recovered.controlled || r.recovered.waiting ||
            r.receiptsOffline.length || await page.evaluate(() => navigator.onLine || !!window.MedTrackerCloud?.degraded) ||
            await page.locator('#boot-degraded-banner, #cloud-update-banner').count() ||
            !r.recovered.cached.some((c) => c.name.endsWith(`v${r.bundles.B.stamp}`) && c.keys.includes('/js/apishim.js'))) throw new Error('offline recovery/reload proof failed');
        await ctx.stableShot('offline-B-recovered-saved-note');
      } finally { page.off('load', count); }
    });
  } finally {
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});
    await ctx.shell(`cmd connectivity airplane-mode ${savedRadios.airplane === '1' ? 'enable' : 'disable'}`);
    await ctx.shell(`svc wifi ${savedRadios.wifi === '0' ? 'disable' : 'enable'}`);
    await ctx.shell(`svc data ${savedRadios.data === '0' ? 'disable' : 'enable'}`);
    r.radiosRestored = { airplane: (await ctx.shell('settings get global airplane_mode_on')).trim(),
      wifi: (await ctx.shell('settings get global wifi_on')).trim(), data: (await ctx.shell('settings get global mobile_data')).trim() };
    if (JSON.stringify(savedRadios) !== JSON.stringify(r.radiosRestored)) throw new Error('radio cleanup mismatch');
  }
}
