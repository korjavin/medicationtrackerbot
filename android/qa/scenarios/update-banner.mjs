// B2 account update: real stamped embedded A/B binaries, real worker/cache lifecycle.
import { readFileSync } from 'node:fs';
import { claimAccount, waitForVault } from './smoke.mjs';
export const retry = false; // one disposable invite; dispatch-only

export async function control(path, body) {
  if (!process.env.QA_BUNDLES) throw new Error('B2 fixture not configured');
  const base = 'http://127.0.0.1:8766';
  const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`fixture ${path}: ${res.status}`);
  return res.json();
}

export async function state(page) {
  return page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const cached = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith('medtracker-cloud-shell-')) continue;
      const cache = await caches.open(name);
      const doc = await cache.match('/');
      const html = doc ? await doc.text() : '';
      const keys = (await cache.keys()).map((q) => new URL(q.url).pathname + new URL(q.url).search);
      cached.push({ name, build: html.match(/name="medtracker-build-id" content="([^"]+)/)?.[1], keys });
    }
    return { build: document.querySelector('meta[name="medtracker-build-id"]')?.content,
      settings: document.querySelector('.wg-settings-version__value')?.textContent?.trim(),
      timeOrigin: performance.timeOrigin, controlled: !!navigator.serviceWorker.controller,
      controller: navigator.serviceWorker.controller?.scriptURL, controllerState: navigator.serviceWorker.controller?.state,
      waiting: reg?.waiting?.state, installing: reg?.installing?.state, active: reg?.active?.state,
      cached, banners: document.querySelectorAll('#cloud-update-banner').length };
  });
}

export async function waitForWaitingWorker(page) {
  // Poll resolved browser values in Node: an async waitForFunction predicate
  // returned before installation completed in Android run42160047611.
  const until = Date.now() + 90_000;
  do {
    if (await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state === 'installed')) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < until);
  throw new Error('real B worker did not reach waiting/installed');
}

export async function checkSaved(page, note) {
  await page.evaluate(() => window.switchTab('health'));
  await page.locator('.health-tab[data-tab="notes"]').click();
  await page.locator('#notes-list').getByText(note, { exact: true }).waitFor({ timeout: 15_000 });
  const data = JSON.parse(await page.evaluate(() => window.CloudVault.exportAll({ includeSecrets: false })));
  if (data.data.diary.notes.filter((n) => n.content === note).length !== 1) throw new Error('saved note changed or duplicated');
  return data.data.diary.notes;
}

export async function observeDocument(page, r) {
  r.documentEvents ||= [];
  page.on('console', (msg) => {
    if (msg.text().startsWith('B2_EVENT ')) r.documentEvents.push(JSON.parse(msg.text().slice(9)));
    if (msg.text().startsWith('B2_SW ')) (r.lifecycle ||= []).push(msg.text());
  });
  const observe = () => {
    window.__qaVis = [];
    const report = (event) => { const record = { type: event.type,
      trusted: event.isTrusted, state: document.visibilityState, focused: document.hasFocus(),
      target: event.target === window ? 'window' : 'document', at: Date.now(), timeOrigin: performance.timeOrigin };
      window.__qaVis.push(record); console.log('B2_EVENT ' + JSON.stringify(record)); };
    document.addEventListener('visibilitychange', report, true);
    window.addEventListener('focus', report);
    window.addEventListener('blur', report);
  };
  await page.addInitScript(observe);
  await page.evaluate(observe);
}

export async function foreground(ctx, page, r) {
  const snapshot = () => page.evaluate(() => ({ state: document.visibilityState,
    focused: document.hasFocus(), at: Date.now(), timeOrigin: performance.timeOrigin,
    banners: document.querySelectorAll('#cloud-update-banner').length }));
  await page.evaluate(() => { window.__qaVis = []; });
  const observation = { before: await snapshot(), homeStarted: Date.now() };
  await ctx.shell('input keyevent KEYCODE_HOME');
  await ctx.sleep(3000);
  observation.away = await snapshot();
  observation.awayEvents = await page.evaluate(() => window.__qaVis || []);
  observation.returnStarted = Date.now();
  await ctx.shell(`am start -W -n ${ctx.pkg}/com.example.medtracker.MainActivity --ez qaSoftAuthn true`);
  await page.waitForFunction(() => document.visibilityState === 'visible');
  await ctx.sleep(1000);
  observation.returned = await snapshot();
  observation.events = await page.evaluate(() => window.__qaVis || []);
  if (r) (r.foregrounds ||= []).push(observation);
  const events = observation.events.filter((e) => e.trusted && e.type === 'visibilitychange' &&
    e.timeOrigin === observation.before.timeOrigin);
  const hidden = events.findIndex((e) => e.state === 'hidden');
  if (!observation.awayEvents.some((e) => e.trusted && e.type === 'visibilitychange' && e.state === 'hidden') ||
      hidden < 0 || !events.slice(hidden + 1).some((e) => e.state === 'visible')) {
    throw new Error(`native Home/return did not deliver trusted hidden then visible: ${JSON.stringify(events)}`);
  }
}

export async function prepareAccount(ctx, r) {
  if (!process.env.QA_BUNDLES) throw new Error('QA_BUNDLES unset');
  r.bundles = JSON.parse(readFileSync(process.env.QA_BUNDLES, 'utf8'));
  if (r.bundles.A.stamp === r.bundles.B.stamp || r.bundles.A.binarySha256 === r.bundles.B.binarySha256) throw new Error('A/B generations identical');
  await ctx.shell(`pm clear ${ctx.pkg}`);
  await ctx.shell(`pm grant ${ctx.pkg} android.permission.POST_NOTIFICATIONS`);
  await ctx.shell(`appops set ${ctx.pkg} SCHEDULE_EXACT_ALARM allow`);
  const page = await ctx.step('claim disposable A account', () => ctx.openClaim({ softAuthn: true }));
  await claimAccount(ctx, page);
  r.note = 'QA B2 saved through the update';
  await ctx.step('save a real note and finish account sync', async () => {
    await page.evaluate(() => window.switchTab('health'));
    await page.locator('.health-tab[data-tab="notes"]').click();
    await page.fill('#notes-textarea', r.note);
    await page.click('#notes-save-btn');
    r.saved = await checkSaved(page, r.note);
    const synced = await page.evaluate(async () => (await import('/js/sync.js')).flushConfirmed(window.MedTrackerCloud.ctx));
    if (!synced) throw new Error('note not acknowledged');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.reload({ waitUntil: 'load' });
    await waitForVault(page);
    await checkSaved(page, r.note);
    r.initial = await state(page);
    if (r.initial.build !== r.bundles.A.stamp || !r.initial.controlled || r.initial.waiting ||
        !r.initial.cached.some((c) => c.name.endsWith(`v${r.bundles.A.stamp}`) && c.keys.includes('/js/apishim.js'))) throw new Error('A graph not controlled/complete');
  });
  await observeDocument(page, r);
  return page;
}

export default async function updateBanner(ctx) {
  const r = (ctx.results.updateBanner = { checks: [], lifecycle: [] });
  let page = await prepareAccount(ctx, r);
  await ctx.step('state A: matching real client/server stays quiet after foreground checks', async () => {
    await foreground(ctx, page, r);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await ctx.sleep(1000);
      r.checks.push(await state(page));
      if (r.checks.at(-1).banners) throw new Error('matching A showed update banner');
    }
    await ctx.stableShot('matching-A-no-banner');
  });
  await ctx.step('state B: real native cold open after server B shows one notice and installs waiting B', async () => {
    r.switch = await control('/switch-b', {});
    const version = await page.evaluate(async () => (await (await fetch('/api/version', { cache: 'no-store' })).json()).build_id);
    if (version !== r.bundles.B.stamp) throw new Error(`real server not B: ${version}`);
    r.beforeColdOpen = await state(page);
    r.coldOpenStarted = Date.now();
    // Archie17593: the primary trigger is a REAL native cold open, not an
    // injected visibility event. B has not been asked to install in A yet.
    await ctx.coldStart(`-n ${ctx.pkg}/com.example.medtracker.MainActivity --ez qaSoftAuthn true`);
    page = await ctx.attachPage();
    if (!page) throw new Error('no account WebView after native cold open');
    await waitForVault(page);
    await observeDocument(page, r);
    await page.evaluate(() => {
      navigator.serviceWorker.getRegistration().then((reg) => {
        const watch = (worker) => {
          console.log(`B2_SW ${worker?.state}`);
          worker?.addEventListener('statechange', () => console.log(`B2_SW ${worker.state}`));
        };
        // Cold-open install can predate CDP attach: retain its real current
        // state and follow an already-installing worker, not only updatefound.
        console.log(`B2_SW attach installing=${reg.installing?.state} waiting=${reg.waiting?.state} active=${reg.active?.state}`);
        watch(reg.installing);
        reg.addEventListener('updatefound', () => watch(reg.installing));
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => console.log(`B2_SW controller ${navigator.serviceWorker.controller?.state}`));
    });
    await page.locator('#cloud-update-banner').waitFor({ timeout: 60_000 });
    r.coldOpened = await state(page);
    if (r.coldOpened.timeOrigin === r.beforeColdOpen.timeOrigin || r.coldOpened.banners !== 1) throw new Error('native cold open did not show one real notice');
    await waitForWaitingWorker(page);
    await foreground(ctx, page, r); // additional observed native resume; primary notice already proved above
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await ctx.sleep(750);
      if (await page.locator('#cloud-update-banner').count() !== 1) throw new Error('update banner not exactly one');
    }
    r.waiting = await state(page);
    if (r.waiting.build !== r.bundles.A.stamp || r.waiting.waiting !== 'installed') throw new Error('A/B waiting state missing');
    await ctx.stableShot('A-with-B-waiting');
    await page.click('#cloud-update-dismiss');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await ctx.sleep(2000);
    if (await page.locator('#cloud-update-banner').count()) throw new Error('dismissed settled notice returned');
  });
  await ctx.step('state C: new document A with B already waiting shows one notice', async () => {
    await page.reload({ waitUntil: 'load' });
    await waitForVault(page);
    await page.locator('#cloud-update-banner').waitFor();
    r.stateC = await state(page);
    if (r.stateC.build !== r.bundles.A.stamp || r.stateC.banners !== 1 || r.stateC.waiting !== 'installed') throw new Error('state C notice lost');
    await ctx.stableShot('state-C-before-reload');
  });
  await ctx.step('Reload activates B and makes exactly one new document, preserving saved data', async () => {
    let loads = 0;
    const count = () => loads++;
    page.on('load', count);
    try {
      await ctx.tapElement(page, '#cloud-update-reload');
      await page.waitForFunction((stamp) => document.querySelector('meta[name="medtracker-build-id"]')?.content === stamp, r.bundles.B.stamp, { timeout: 60_000 });
      await waitForVault(page);
      await checkSaved(page, r.note);
      await ctx.sleep(3500); // past activateAndReload's 2s fallback: catch a second reload
      await page.evaluate(() => window.switchTab('settings'));
      await page.locator('.wg-settings-version__value').getByText(r.bundles.B.stamp, { exact: true }).waitFor();
      r.final = await state(page);
      r.reloadDocuments = loads;
      if (loads !== 1 || r.final.timeOrigin === r.stateC.timeOrigin || r.final.settings !== r.bundles.B.stamp ||
          !r.final.controlled || r.final.waiting || r.final.cached.some((c) => !c.name.endsWith(`v${r.bundles.B.stamp}`)) ||
          !r.final.cached.some((c) => c.keys.some((k) => k.includes(`?v=${r.bundles.B.stamp}`)))) throw new Error('B reload/cache/controller/version mismatch');
      await foreground(ctx, page, r);
      await ctx.sleep(1500);
      if (await page.locator('#cloud-update-banner').count()) throw new Error('matching B showed another notice');
      await ctx.stableShot('B-settings-new-version');
    } finally { page.off('load', count); }
  });
}
