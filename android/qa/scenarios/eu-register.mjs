// EU register check on the real shell in local mode (bd med-3u28.2/.3): the measurement
// gate, Settings choice, cache persistence across a cold relaunch and editor/sheet screens.
// results.euRegister = {
//   phases: fetch+decode, JSON.parse, index build of the bundled asset (ms), measured apart;
//   first: the app path's first EU check (ms to ready, peak heap, long tasks, worst timer lag);
//   second: the cold relaunch (cache-first: no asset request);
//   heapMB: { before, afterFirst, retained } after a forced GC (CDP), the register held in memory }.
// Numbers only: the gate's verdict is a review call (worker / smaller projection is a follow-up bead).

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const ASSET = '/static/data/ema-article57-rev90-v1.json';

// In the page: the first EU check through the app's own route, with a 50 ms timer probe (its worst
// lateness is the input-responsiveness proxy), long tasks and the peak JS heap while it runs.
async function timedCheck(name) {
  const tasks = [];
  let po;
  try {
    po = new PerformanceObserver((l) => tasks.push(...l.getEntries().map((e) => e.duration)));
    po.observe({ type: 'longtask' });
  } catch { /* no longtask support: lag + heap still reported */ }
  let maxLag = 0;
  let peak = 0;
  let stop = false;
  const probe = () => {
    const t = performance.now();
    setTimeout(() => {
      maxLag = Math.max(maxLag, performance.now() - t - 50);
      if (performance.memory) peak = Math.max(peak, performance.memory.usedJSHeapSize);
      if (!stop) probe();
    }, 50);
  };
  probe();
  const t0 = performance.now();
  let res;
  let lastState = null;
  let polls = 0;
  for (;;) {
    const remaining = 60_000 - (performance.now() - t0);
    if (remaining <= 0) { res = { status: 'timeout', candidates: [] }; break; }
    let timer;
    try {
      // Same contract as the editor (meds-history.js): poll=1 only observes the loader.
      // Starting again on every poll can hide a failed load in an endless retry loop.
      res = await Promise.race([
        window.apiCall(`/api/medications/ema-check?name=${encodeURIComponent(name)}${polls ? '&poll=1' : ''}`),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 'timeout', candidates: [] }), remaining); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    polls++;
    if (res.status !== 'timeout') lastState = { status: res.status, progress: res.progress ?? null };
    if (res.status !== 'loading') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const ms = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 200));
  stop = true;
  if (po) po.disconnect();
  const round = (n) => Math.round(n);
  return {
    ms: round(ms), status: res.status, candidates: res.candidates.length, polls, lastState,
    maxTimerLagMs: round(maxLag), longTasks: tasks.length, longestTaskMs: round(Math.max(0, ...tasks)),
    totalBlockingMs: round(tasks.reduce((s, d) => s + Math.max(0, d - 50), 0)),
    peakHeapMB: performance.memory ? +(peak / 1048576).toFixed(1) : null,
  };
}

export default async function euRegister(ctx) {
  const { shell, pkg, sleep } = ctx;
  const r = (ctx.results.euRegister = {
    assetRequests: { first: 0, second: 0 }, assetResponses: [], finishedAssetRequests: [], failedAssetRequests: [],
    observedRequests: 0, nameEgress: [], rxNavRequests: [],
  });
  const started = Date.now();
  r.bundledAssetSha256 = createHash('sha256').update(await readFile(new URL(`../../../web${ASSET}`, import.meta.url))).digest('hex');
  let counting = 'setup';
  const isAsset = (url) => url.includes('/static/data/ema-');
  const watch = (p) => {
    // Label the separate phase probe, which deliberately precedes a reload, as instrumentation.
    // Keep the phase on the request: a late failure must not be assigned to a later check.
    const phases = new WeakMap();
    p.on('request', (q) => {
      // Observe every real request, not only the catalogue asset. The shim's /api/... calls
      // are in-process; a name in a real URL/body (including same-origin) is an egress bug.
      r.observedRequests++;
      const url = q.url();
      let payload = `${url}\n${q.postData() || ''}`;
      try { payload = decodeURIComponent(payload); } catch { /* raw payload is still checked */ }
      if (/candecor|voltaren|duogestan|candekor/i.test(payload)) r.nameEgress.push({ method: q.method(), url });
      if (/rxnav\.nlm\.nih\.gov/i.test(url)) r.rxNavRequests.push(url);
      if (isAsset(q.url())) {
        phases.set(q, counting);
        r.assetRequests[counting] = (r.assetRequests[counting] || 0) + 1;
      }
    });
    p.on('response', (res) => {
      const phase = phases.get(res.request());
      if (phase) r.assetResponses.push({ phase, url: res.url(), status: res.status(), atMs: Date.now() - started });
    });
    p.on('requestfailed', (q) => {
      const phase = phases.get(q);
      if (phase) r.failedAssetRequests.push({ phase, url: q.url(), error: q.failure()?.errorText, observedDuring: r.observationStage, atMs: Date.now() - started });
    });
    p.on('requestfinished', (q) => {
      const phase = phases.get(q);
      if (phase) r.finishedAssetRequests.push({ phase, url: q.url(), atMs: Date.now() - started });
    });
  };
  // local-app.mjs also records ERR_ABORTED as cancellation. Here the exception is narrower:
  // only a 200 app load with a validated ready catalogue AND an exact fresh cached copy of the
  // bundled bytes can classify that signal as cancellation. Preserve the raw event; infer no cause.
  const completedCancel = (q) => q.phase === 'first' && q.error === 'net::ERR_ABORTED'
    && new URL(q.url).pathname === ASSET && r.firstBodyComplete;
  const failedAppRequests = () => r.failedAssetRequests.filter((q) => q.phase !== 'instrumentation' && !completedCancel(q));

  await shell(`pm clear ${pkg}`);
  let page = await ctx.step('cold start in local mode (seeds the golden vault)', async () => {
    const p = await ctx.launchLocal('today');
    watch(p);
    return p;
  });

  let cdp = null;
  try {
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
  } catch (e) {
    r.cdpError = String(e?.message || e).split('\n')[0];
  }
  const heapMB = async () => {
    if (!cdp) return null;
    await cdp.send('HeapProfiler.collectGarbage');
    const { metrics } = await cdp.send('Performance.getMetrics');
    return +(metrics.find((m) => m.name === 'JSHeapUsedSize').value / 1048576).toFixed(1);
  };
  const freshPage = async () => {
    await page.goto(`${ctx.LOCAL_ORIGIN}/`, { waitUntil: 'load', timeout: 60_000 });
    await ctx.waitLocalReady(page);
    await sleep(3000); // boot work settles before measuring
  };
  const openChoice = async () => {
    // A plain relaunch can restore Settings, where its own navigation button is hidden.
    const features = page.locator('[data-settings-open="features"]:visible');
    const gear = page.locator('[data-nav-to="settings"]:visible').first();
    const entry = features.or(gear).first();
    await entry.waitFor({ state: 'visible', timeout: 30_000 });
    const alreadySettings = await entry.getAttribute('data-settings-open') === 'features';
    await entry.click();
    if (!alreadySettings) await features.click();
    const row = page.locator('#med-register-choose');
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await page.locator('.mt-confirm-modal__choices').waitFor({ timeout: 10_000 });
  };

  await ctx.step('local Settings: US needs an account; choose EU through the UI', async () => {
    r.origin = await page.evaluate(() => location.origin);
    if (r.origin !== ctx.LOCAL_ORIGIN) throw new Error(`unexpected origin: ${r.origin}`);
    r.us = await page.evaluate(() => window.apiCall('/api/medications/ema-check?name=Candecor'));
    if (r.us.status !== 'off') throw new Error(`default US check: ${r.us.status}`);
    await openChoice();
    const choices = page.locator('.mt-confirm-modal__choice');
    r.usCopy = await choices.filter({ hasText: 'US register' }).textContent();
    if (!r.usCopy.includes('Needs an account. Without one, no name check runs.')) throw new Error(`local US copy: ${r.usCopy}`);
    if (!(await page.locator('.mt-confirm-modal').textContent()).includes('Applies on this phone only.')) throw new Error('missing device-local choice hint');
    await ctx.stableShot('er2-local-choice');
    await choices.filter({ hasText: 'EU register' }).click();
    await page.waitForFunction(() => document.getElementById('med-register-value')?.textContent === 'EU register');
  });

  await ctx.step('phases: fetch+decode, JSON.parse, index build', async () => {
    counting = 'instrumentation';
    r.observationStage = 'phase-probe';
    r.phases = await page.evaluate(async (url) => {
      const t0 = performance.now();
      const text = await (await fetch(url, { cache: 'no-store' })).text();
      const t1 = performance.now();
      const data = JSON.parse(text);
      const t2 = performance.now();
      const { createEMACatalogue } = await import('/domain/ema-catalogue.js');
      const t3 = performance.now();
      const catalogue = createEMACatalogue(data);
      const t4 = performance.now();
      return {
        fetchDecodeMs: Math.round(t1 - t0), parseMs: Math.round(t2 - t1), indexMs: Math.round(t4 - t3),
        chars: text.length, rows: data.rows.length, candecor: catalogue.exact('Candecor').candidates.length,
      };
    }, ASSET);
    if (r.phases.candecor !== 2) throw new Error(`Candecor: ${r.phases.candecor} rows`);
    counting = 'first';
  });

  await ctx.step('first EU check on the emulator (bundled asset, parse, index, cache write)', async () => {
    r.cacheBeforeNames = await page.evaluate(async () => {
      for (const n of await caches.keys()) if (n.startsWith('medtracker-ema-')) await caches.delete(n);
      return (await caches.keys()).filter((n) => n.startsWith('medtracker-ema-'));
    });
    if (r.cacheBeforeNames.length) throw new Error('could not clear the previous register cache');
    await freshPage();
    r.observationStage = 'before-first-heap-gc';
    const before = await heapMB();
    r.observationStage = 'first-app-check';
    counting = 'first';
    r.first = await page.evaluate(timedCheck, 'Candecor');
    r.firstReadyAtMs = Date.now() - started;
    r.observationStage = 'after-first-heap-gc';
    const after = await heapMB();
    r.heapMB = { before, afterFirst: after, retained: before !== null ? +(after - before).toFixed(1) : null };
    r.cache = await page.evaluate(async (asset) => {
      const names = (await caches.keys()).filter((n) => n.startsWith('medtracker-ema-'));
      for (const name of names) {
        const response = await (await caches.open(name)).match(asset);
        if (!response) continue;
        const bytes = await response.arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        const sha256 = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
        return { names, hasAsset: true, bytes: bytes.byteLength, sha256 };
      }
      return { names, hasAsset: false };
    }, ASSET);
    if (r.first.status !== 'ready' || r.first.candidates !== 2) throw new Error(`first check: ${JSON.stringify(r.first)}`);
    if (!r.cache.hasAsset) throw new Error(`register not stored on appassets: ${JSON.stringify(r.cache)}`);
    const successfulResponse = r.assetResponses.some((res) => res.phase === 'first' && new URL(res.url).origin === ctx.LOCAL_ORIGIN && res.status === 200);
    r.firstBodyComplete = successfulResponse && r.first.status === 'ready' && r.first.candidates === 2 && r.cache.sha256 === r.bundledAssetSha256;
    if (r.assetRequests.first !== 1 || !r.firstBodyComplete) throw new Error('first check did not consume the complete bundled register');
    r.completedAssetCancels = r.failedAssetRequests.filter(completedCancel);
    if (failedAppRequests().length) throw new Error(`failed register requests: ${JSON.stringify(failedAppRequests())}`);
  });

  await ctx.step('force-stop and relaunch: EU choice persists and cache avoids an asset request', async () => {
    counting = 'second';
    r.observationStage = 'cold-relaunch';
    page = await ctx.launchLocal(undefined, { extra: false });
    watch(page);
    // As in local-smoke, replay the persisted boot under the listener: attachment occurs after
    // the native cold boot. Both boots keep app data, and no preference or cache is injected.
    await page.reload({ waitUntil: 'load', timeout: 60_000 });
    await ctx.waitLocalReady(page);
    r.relaunchOrigin = await page.evaluate(() => location.origin);
    if (r.relaunchOrigin !== ctx.LOCAL_ORIGIN) throw new Error(`relaunch origin: ${r.relaunchOrigin}`);
    await openChoice();
    r.persistedChoice = await page.locator('.mt-confirm-modal__choice[aria-pressed="true"]').textContent();
    if (!r.persistedChoice.startsWith('EU register')) throw new Error(`relaunch choice: ${r.persistedChoice}`);
    await ctx.stableShot('relaunch-eu-choice');
    await page.locator('.mt-confirm-modal__cancel').click();
    counting = 'second';
    r.second = await page.evaluate(timedCheck, 'Candecor');
    if (r.second.status !== 'ready') throw new Error(`second check: ${JSON.stringify(r.second)}`);
    if (r.assetRequests.second) throw new Error(`${r.assetRequests.second} asset request(s) on the cached load`);
    if (failedAppRequests().length) throw new Error(`failed register requests: ${JSON.stringify(failedAppRequests())}`);
    await page.locator('.wg-page[aria-label="Features"] .wg-pagebar .wg-back').click();
  });

  // The ER frames on the device, for the design check.
  const editor = async (name, shot) => {
    await page.evaluate((n) => {
      window.switchTab('meds');
      window.showAddModal();
      const input = document.getElementById('med-name');
      input.value = n;
      input.dispatchEvent(new Event('change'));
    }, name);
    await page.locator('#med-eu-slot:not(.hidden)').waitFor({ timeout: 30_000 });
    await ctx.stableShot(shot);
  };
  const chipIs = async (want) => {
    await page.waitForFunction((text) => document.getElementById('med-eu-chip')?.textContent.trim() === text,
      want, { timeout: 30_000 });
  };
  const sheet = async (shot, check) => {
    await page.locator('#med-eu-chip').click();
    await page.locator('#med-eu-sheet').waitFor({ timeout: 10_000 });
    if (check) await check();
    await ctx.stableShot(shot);
    await page.locator('#med-eu-sheet .wg-sheethead .wg-btn').click();
  };
  await ctx.step('ER3/ER7 one entry: chip, route, countries and dated EMA source', async () => {
    await editor('Candecor', 'er3-chip');
    await chipIs('EU · Candesartan Cilexetil');
    await sheet('er7-sheet', async () => {
      const cards = page.locator('#med-eu-sheet .wg-sheet__body > .wg-card');
      if (await cards.count() !== 1) throw new Error('Candecor needs one substance card');
      const text = await cards.textContent();
      for (const value of ['Candesartan Cilexetil', 'Oral Use', 'Germany, Slovenia']) {
        if (!text.includes(value)) throw new Error(`Candecor sheet missing ${value}: ${text}`);
      }
      const source = await page.locator('#med-eu-sheet .wg-shell__fine').textContent();
      if (!source.includes('European Medicines Agency (EMA), Article 57 product data, Rev.90, data of 09.10.2026.')) {
        throw new Error(`missing dated EMA source: ${source}`);
      }
    });
  });
  await ctx.step('ER5/ER8 several entries: three substance cards', async () => {
    await editor('Voltaren', 'er5-several');
    await chipIs('EU · 3 entries');
    await sheet('er8-sheet', async () => {
      const titles = await page.locator('#med-eu-sheet .wg-sheet__body > .wg-card .wg-card__title').allTextContents();
      const want = ['Diclofenac Diethylamine', 'Diclofenac Potassium', 'Diclofenac Sodium'];
      if (JSON.stringify(titles.sort()) !== JSON.stringify(want)) throw new Error(`Voltaren substances: ${JSON.stringify(titles)}`);
    });
  });
  await ctx.step('ER9 separate products', async () => { await editor('Duogestan', 'er9-chip'); await sheet('er9-sheet'); });
  await ctx.step('ER6 no exact match', async () => { await editor('Candekor', 'er6-nomatch'); });
  await ctx.step('ER1/ER2 Settings row and the choice', async () => {
    await page.evaluate(() => window.closeModal());
    await page.locator('[data-nav-to="settings"]:visible').first().click();
    await page.evaluate(() => window.SettingsView.openSettingsPage('features'));
    const row = page.locator('#med-register-choose');
    await row.scrollIntoViewIfNeeded();
    r.settingsValue = (await page.locator('#med-register-value').textContent()).trim();
    await ctx.stableShot('er1-settings');
    await row.click();
    await page.locator('.mt-confirm-modal__choices').waitFor({ timeout: 10_000 });
    await ctx.stableShot('er2-choice');
    await page.locator('.mt-confirm-modal__cancel').click();
    if (r.settingsValue !== 'EU register') throw new Error(`row value: ${r.settingsValue}`);
  });
  r.completedAssetCancels = r.failedAssetRequests.filter(completedCancel);
  r.failedAppRequests = failedAppRequests();
  if (r.failedAppRequests.length) throw new Error(`failed register requests: ${JSON.stringify(r.failedAppRequests)}`);
  if (r.assetRequests.second) throw new Error(`${r.assetRequests.second} asset request(s) after relaunch`);
  if (!r.observedRequests) throw new Error('no network requests observed by the egress guard');
  if (r.nameEgress.length || r.rxNavRequests.length) throw new Error(`EU name/RxNav egress: ${JSON.stringify({ names: r.nameEgress, rxNav: r.rxNavRequests })}`);
  ctx.log('euRegister', JSON.stringify(r, null, 2));
}
