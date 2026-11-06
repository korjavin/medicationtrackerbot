// EU register on the real shell (bd med-3u28.2/.3, med-sz4k.4.4.3): local Settings,
// real bundled-response progress/Save, cached offline saved match, US route, then an
// encrypted peer op and native account pull. Standalone: this consumes the invite.
// results.euRegister = {
//   phases: fetch+decode, JSON.parse, index build of the bundled asset (ms), measured apart;
//   first: the app path's first EU check (ms to ready, peak heap, long tasks, worst timer lag);
//   second: the cold relaunch (cache-first: no asset request);
//   heapMB: { before, afterFirst, retained } after a forced GC (CDP), the register held in memory;
//   progress*, savedWhileLoading, offline*, usCalls, peerWrite, beforePull,
//   accountObservation and accountPulledEU record the additional flows }.
// Numbers only: the gate's verdict is a review call (worker / smaller projection is a follow-up bead).

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { claimAccount } from './smoke.mjs';

// The account half spends the runner's one invite; dispatch this scenario alone.
export const retry = false;

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
      if (/rxnav\.nlm\.nih\.gov|\/api\/rxnav\//i.test(url)) r.rxNavRequests.push(url);
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
  const completedCancel = (q) => q.error === 'net::ERR_ABORTED' && new URL(q.url).pathname === ASSET
    && ((q.phase === 'first' && r.firstBodyComplete) || (q.phase === 'progress' && r.progressBodyComplete)
      || (q.phase === 'account' && new URL(q.url).origin === new URL(ctx.claimUrl).origin && r.accountBodyComplete));
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
  // Playwright's waitForFunction does not poll an async predicate: a Promise is truthy.
  // Poll real cache/IDB reads from Node until they resolve to true, with a bounded timeout.
  const waitForAsync = async (label, check, timeout = 60_000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await check()) return;
      await sleep(250);
    }
    throw new Error(`${label} timed out`);
  };
  const hasCachedAsset = () => page.evaluate(async (asset) => {
    for (const n of await caches.keys()) if (n.startsWith('medtracker-ema-') && await (await caches.open(n)).match(asset)) return true;
    return false;
  }, ASSET);
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

  await ctx.step('cold register: progress is visible and Save works while bytes are loading', async () => {
    await page.evaluate(async () => {
      for (const n of await caches.keys()) if (n.startsWith('medtracker-ema-')) await caches.delete(n);
    });
    await freshPage();
    counting = 'progress';
    r.observationStage = 'progress-app-check';
    // Hold the real bundled response after its first bytes: the real loader, progress and
    // Save handler still run. This makes their overlap observable on fast emulators.
    await page.evaluate(() => {
      const original = window.fetch;
      let release;
      window.__qaReleaseEma = () => release?.();
      const gate = new Promise((resolve) => { release = resolve; });
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (!String(args[0]).includes('/static/data/ema-article57-')) return response;
        const reader = response.body.getReader();
        let first = true;
        const stream = new ReadableStream({ async pull(controller) {
          if (!first) await gate;
          const part = await reader.read();
          if (part.done) controller.close(); else controller.enqueue(part.value);
          first = false;
        }, cancel() { return reader.cancel(); } });
        return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
      };
      window.__qaRestoreFetch = () => { window.fetch = original; };
    });
    try {
      await page.evaluate(() => { window.switchTab('meds'); window.showAddModal(); });
      await page.locator('#med-name').fill('QA loading medication');
      await page.locator('#med-dosage').fill('5mg');
      await page.locator('#med-name').dispatchEvent('change');
      await page.locator('#med-eu-slot .wg-meter').waitFor({ timeout: 30_000 });
      r.progressText = await page.locator('#med-eu-slot').textContent();
      await ctx.stableShot('register-progress', { cap: 4 });
      r.progressAfterShot = await page.locator('#med-eu-slot').textContent();
      if (!r.progressAfterShot.includes('Loading the EU register')) throw new Error('register stopped loading before Save');
      await page.locator('[data-schedule-type="as_needed"]').click();
      await page.locator('#med-modal-save-btn').click();
      await page.locator('#med-modal').waitFor({ state: 'hidden', timeout: 15_000 });
      r.savedWhileLoading = (await page.evaluate(() => window.apiCall('/api/medications'))).some((m) => m.name === 'QA loading medication');
      if (!r.savedWhileLoading || r.assetRequests.progress !== 1) throw new Error('Save or single real asset load failed during progress');
    } finally {
      await page.evaluate(() => { window.__qaReleaseEma(); window.__qaRestoreFetch(); });
    }
    await waitForAsync('progress cache', hasCachedAsset);
    r.progressCache = await page.evaluate(async (asset) => {
      for (const n of await caches.keys()) {
        if (!n.startsWith('medtracker-ema-')) continue;
        const response = await (await caches.open(n)).match(asset);
        if (!response) continue;
        const hash = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
        return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
      }
      return null;
    }, ASSET);
    r.progressReady = await page.evaluate(timedCheck, 'Candecor');
    r.progressBodyComplete = r.progressCache === r.bundledAssetSha256 && r.progressReady.status === 'ready' && r.progressReady.candidates === 2
      && r.assetResponses.some((res) => res.phase === 'progress' && new URL(res.url).origin === ctx.LOCAL_ORIGIN && res.status === 200);
    if (!r.progressBodyComplete) throw new Error('progress load did not complete with the exact bundled register');
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
    await page.locator('#med-dosage').fill('8mg');
    await page.locator('[data-schedule-type="as_needed"]').click();
    await page.locator('#med-modal-save-btn').click();
    await page.locator('#med-modal').waitFor({ state: 'hidden', timeout: 15_000 });
    const med = (await page.evaluate(() => window.apiCall('/api/medications'))).find((m) => m.name === 'Candecor');
    if (!med) throw new Error('Candecor was not saved');
    r.candecorId = med.id;
  });
  await ctx.step('cached register offline: cold reopen keeps the chip and saved match', async () => {
    const wifi = (await shell('settings get global wifi_on')).trim();
    const data = (await shell('settings get global mobile_data')).trim();
    try {
      await shell('svc wifi disable');
      await shell('svc data disable');
      page = await ctx.launchLocal(undefined, { extra: false });
      watch(page);
      await page.waitForFunction(() => !navigator.onLine, null, { timeout: 30_000 });
      r.offlineRadios = { wifi: (await shell('settings get global wifi_on')).trim(), data: (await shell('settings get global mobile_data')).trim() };
      if (r.offlineRadios.wifi !== '0' || r.offlineRadios.data !== '0') throw new Error('radios not disabled');
      await page.evaluate(() => window.switchTab('meds'));
      await page.locator('.med-tab[data-tab="schedule"]').click();
      const row = page.locator(`[data-med-id="${r.candecorId}"]`).first();
      await row.waitFor({ timeout: 20_000 });
      r.offlineRow = await row.textContent();
      if (!r.offlineRow.includes('EU Candesartan Cilexetil')) throw new Error(`offline row lost saved EU match: ${r.offlineRow}`);
      await row.click();
      await chipIs('EU · Candesartan Cilexetil');
      await page.locator('#med-eu-saved').waitFor({ timeout: 30_000 });
      r.offlineSaved = await page.locator('#med-eu-saved').textContent();
      if (!/Saved EU entry · Rev\.\d+, data of \d{2}\.\d{2}\.\d{4}/.test(r.offlineSaved)) throw new Error(`saved entry missing date: ${r.offlineSaved}`);
      await ctx.stableShot('offline-saved-eu');
      await page.evaluate(() => window.closeModal());
    } finally {
      await shell(`svc wifi ${wifi === '0' ? 'disable' : 'enable'}`);
      await shell(`svc data ${data === '0' ? 'disable' : 'enable'}`);
    }
    await page.waitForFunction(() => navigator.onLine, null, { timeout: 30_000 });
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
  await ctx.step('switch back to US: Rx path runs without fetching EU register', async () => {
    await page.locator('#med-register-choose').click();
    await page.locator('.mt-confirm-modal__choice').filter({ hasText: 'US register' }).click();
    await page.waitForFunction(() => document.getElementById('med-register-value')?.textContent.trim() === 'US register');
    await page.locator('.wg-page[aria-label="Features"] .wg-pagebar .wg-back').click();
    counting = 'us';
    await page.evaluate(() => {
      const original = window.offlineAwareApiCall || window.apiCallDirect;
      window.__qaRegisterCalls = [];
      window.offlineAwareApiCall = (...args) => { window.__qaRegisterCalls.push(String(args[0])); return original(...args); };
    });
    await page.evaluate(() => { window.switchTab('meds'); window.showAddModal(); });
    await page.locator('#med-name').fill('US test');
    await page.locator('#med-name').dispatchEvent('change');
    await page.waitForFunction(() => window.__qaRegisterCalls.some((u) => u.startsWith('/api/medications/rx-check?')), null, { timeout: 30_000 });
    await ctx.shot('us-register');
    r.usCalls = await page.evaluate(() => window.__qaRegisterCalls);
    if (r.assetRequests.us) throw new Error('US switch fetched the EU asset');
    await page.evaluate(() => window.closeModal());
  });
  counting = 'account';
  r.observationStage = 'account-eu-check';
  page = await ctx.step('account: claim the disposable invite', () => ctx.openClaim({ softAuthn: true }));
  await claimAccount(ctx, page);
  watch(page);
  await ctx.step('account: simulated peer writes EU setting to cloud; native pull applies it without reload', async () => {
    await page.evaluate(() => window.switchTab('settings'));
    await page.waitForFunction(() => window.SettingsView.openSettingsPage('features'), null, { timeout: 15_000 });
    // Write an explicit US record even on a new account (selecting the default is a no-op).
    await page.locator('#med-register-choose').click();
    await page.locator('.mt-confirm-modal__choice').filter({ hasText: 'EU register' }).click();
    await page.waitForFunction(() => document.getElementById('med-register-value')?.textContent.trim() === 'EU register');
    await page.locator('#med-register-choose').click();
    await page.locator('.mt-confirm-modal__choice').filter({ hasText: 'US register' }).click();
    await page.waitForFunction(() => document.getElementById('med-register-value')?.textContent.trim() === 'US register');
    await page.locator('.wg-page[aria-label="Features"] .wg-pagebar .wg-back').click();
    await page.evaluate(async () => {
      const s = await import('/js/sync.js');
      if (!await s.flushConfirmed(window.MedTrackerCloud.ctx)) throw new Error('initial settings did not sync');
    });
    // Mirror the encrypted sync op contract in cloud/js/sync.js (flushPendingUnlocked)
    // and docs/cloud-crypto.md; the server assigns the next sequence to this peer op.
    r.peerWrite = await page.evaluate(async () => {
      const sync = await import('/js/sync.js');
      const crypto = await import('/js/crypto.js');
      const ctx = window.MedTrackerCloud.ctx;
      const port = sync.recordsPort(ctx);
      const current = (await port.list('settings')).find((x) => x.recordId === 'settings');
      if (!current || current.med_register !== 'us') throw new Error('US setting not established');
      const { seq, pending } = await port.horizonBasis();
      if (pending || !Number.isInteger(seq)) throw new Error('peer fixture requires a synced cursor');
      const rawFetch = window.fetch.bind(window);
      // Suppress this device's automatic SSE-driven pull until after the peer write;
      // a failure response leaves no blocked request that could race the gesture.
      window.__qaBlockPeerPull = true;
      window.__qaNativePullsBlocked = 0;
      window.__qaNativePullsAllowed = 0;
      window.__qaSameDocument = 'account-peer-before-pull';
      window.fetch = (...args) => {
        if (String(args[0]).startsWith('/api/sync/ops?')) {
          if (window.__qaBlockPeerPull) {
            window.__qaNativePullsBlocked++;
            return Promise.resolve(new Response('', { status: 503 }));
          }
          window.__qaNativePullsAllowed++;
        }
        return rawFetch(...args);
      };
      const { recordType, ...body } = current;
      const next = { ...body, med_register: 'eu', clientTs: Math.max(Date.now(), body.clientTs + 1) };
      const enc = await crypto.encryptRecord({ kData: ctx.kData, accountId: ctx.accountId,
        recordType: 'settings', recordId: 'settings', seq: seq + 1,
        plaintext: new TextEncoder().encode(JSON.stringify(next)) });
      const response = await rawFetch('/api/sync/ops', { method: 'POST', headers: sync.WRITE_HEADERS,
        body: JSON.stringify({ ops: [{ record_type_tag: 'settings:settings', nonce: crypto.toBase64(enc.nonce), ct: crypto.toBase64(enc.ct) }] }) });
      if (!response.ok) throw new Error(`peer op HTTP ${response.status}`);
      const result = await response.json();
      if (result.assigned?.[0] !== seq + 1) throw new Error('peer sequence raced another writer');
      return { predictedSeq: seq + 1, assigned: result.assigned[0] };
    });
    await sleep(2000);
    r.beforePull = await page.evaluate(async () => (await (await import('/js/sync.js')).recordsPort(window.MedTrackerCloud.ctx).list('settings')).find((x) => x.recordId === 'settings')?.med_register);
    if (r.beforePull !== 'us') throw new Error('peer setting applied before the native pull');
    await page.evaluate(() => window.switchTab('today'));
    await page.locator('#today-view').waitFor({ state: 'visible', timeout: 15_000 });
    await sleep(1500); // switching sections may restore its prior scroll after switchTab returns
    await page.evaluate(() => { window.scrollTo(0, 0); window.__qaPullSeen = false; window.__qaTouch = {}; for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) document.addEventListener(t, () => { window.__qaTouch[t] = (window.__qaTouch[t] || 0) + 1; }, { passive: true, capture: true }); new MutationObserver(() => { if (document.querySelector('.wg-ptr--busy')) window.__qaPullSeen = true; }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] }); });
    await page.waitForFunction(() => window.scrollY === 0, null, { timeout: 10_000 });
    const { bounds } = await ctx.device.info({ clazz: 'android.webkit.WebView' });
    const x = Math.round(bounds.x + bounds.width / 2);
    const y = Math.round(bounds.y + bounds.height * 0.3);
    await shell(`input motionevent DOWN ${x} ${y}`);
    for (let i = 1; i <= 10; i++) await shell(`input motionevent MOVE ${x} ${y + i * 50}`);
    await page.evaluate(() => { window.__qaBlockPeerPull = false; });
    if (await page.evaluate(() => window.__qaNativePullsAllowed) !== 0) throw new Error('peer pull raced the release gesture');
    await shell(`input motionevent UP ${x} ${y + 500}`);
    await page.waitForFunction(() => window.__qaPullSeen, null, { timeout: 20_000 }).catch(async () => { throw new Error(`native pull not seen: ${JSON.stringify(await page.evaluate(() => ({ scrollY, touch: window.__qaTouch, pill: document.querySelector('.wg-ptr')?.textContent, blocked: window.__qaNativePullsBlocked, allowed: window.__qaNativePullsAllowed })))}`); });
    await waitForAsync('pulled EU setting', () => page.evaluate(async () => (await (await import('/js/sync.js')).recordsPort(window.MedTrackerCloud.ctx).list('settings')).find((x) => x.recordId === 'settings')?.med_register === 'eu'), 30_000);
    await page.evaluate(() => window.switchTab('settings'));
    await page.waitForFunction(() => window.SettingsView.openSettingsPage('features'), null, { timeout: 15_000 });
    await page.waitForFunction(() => document.getElementById('med-register-value')?.textContent.trim() === 'EU register', null, { timeout: 15_000 });
    await ctx.stableShot('account-pulled-eu');
    await page.locator('.wg-page[aria-label="Features"] .wg-pagebar .wg-back').click();
    await page.evaluate(() => { window.switchTab('meds'); window.showAddModal(); });
    await page.locator('#med-name').fill('Candecor');
    await page.locator('#med-name').dispatchEvent('change');
    await chipIs('EU · Candesartan Cilexetil');
    await waitForAsync('account cache', hasCachedAsset);
    r.accountCache = await page.evaluate(async (asset) => {
      for (const n of await caches.keys()) {
        if (!n.startsWith('medtracker-ema-')) continue;
        const response = await (await caches.open(n)).match(asset);
        if (!response) continue;
        const hash = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
        return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
      }
      return null;
    }, ASSET);
    r.accountBodyComplete = r.accountCache === r.bundledAssetSha256 && r.assetResponses.some((res) => res.phase === 'account'
      && new URL(res.url).origin === new URL(ctx.claimUrl).origin && res.status === 200);
    if (!r.accountBodyComplete) throw new Error('account check did not cache the exact register');
    await page.locator('#med-dosage').focus();
    await ctx.stableShot('account-eu-chip');
    r.accountObservation = await page.evaluate(() => ({ sameDocument: window.__qaSameDocument, pulls: window.__qaNativePullsAllowed, blocked: window.__qaNativePullsBlocked }));
    if (r.accountObservation.sameDocument !== 'account-peer-before-pull' || r.accountObservation.pulls !== 1) throw new Error('account did not pull exactly once in the same document');
    r.accountPulledEU = true;
  });
  r.completedAssetCancels = r.failedAssetRequests.filter(completedCancel);
  r.failedAppRequests = failedAppRequests();
  if (r.failedAppRequests.length) throw new Error(`failed register requests: ${JSON.stringify(r.failedAppRequests)}`);
  if (r.assetRequests.second) throw new Error(`${r.assetRequests.second} asset request(s) after relaunch`);
  if (!r.observedRequests) throw new Error('no network requests observed by the egress guard');
  if (r.nameEgress.length || r.rxNavRequests.length) throw new Error(`EU name/RxNav egress: ${JSON.stringify({ names: r.nameEgress, rxNav: r.rxNavRequests })}`);
  ctx.log('euRegister', JSON.stringify(r, null, 2));
}
