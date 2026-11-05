// EU register check on the real shell in local mode (bd med-3u28.2, acceptance f): the measurement
// gate and the editor/sheet screens. results.euRegister = {
//   phases: fetch+decode, JSON.parse, index build of the bundled asset (ms), measured apart;
//   first: the app path's first EU check (ms to ready, peak heap, long tasks, worst timer lag);
//   second: the next page load (cache-first: no asset request);
//   heapMB: { before, afterFirst, retained } after a forced GC (CDP), the register held in memory }.
// Numbers only: the gate's verdict is a review call (worker / smaller projection is a follow-up bead).

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
  let polls = 0;
  for (;;) {
    res = await window.apiCall(`/api/medications/ema-check?name=${encodeURIComponent(name)}`);
    polls++;
    if (res.status !== 'loading') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const ms = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 200));
  stop = true;
  if (po) po.disconnect();
  const round = (n) => Math.round(n);
  return {
    ms: round(ms), status: res.status, candidates: res.candidates.length, polls,
    maxTimerLagMs: round(maxLag), longTasks: tasks.length, longestTaskMs: round(Math.max(0, ...tasks)),
    totalBlockingMs: round(tasks.reduce((s, d) => s + Math.max(0, d - 50), 0)),
    peakHeapMB: performance.memory ? +(peak / 1048576).toFixed(1) : null,
  };
}

export default async function euRegister(ctx) {
  const { shell, pkg, sleep } = ctx;
  const r = (ctx.results.euRegister = { assetRequests: { first: 0, second: 0 } });
  let counting = null;
  const watch = (p) => p.on('request', (q) => { if (counting && q.url().includes('/static/data/ema-')) r.assetRequests[counting]++; });

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

  await ctx.step('phases: fetch+decode, JSON.parse, index build', async () => {
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
  });

  await ctx.step('first EU check on this phone (download, parse, index, cache write)', async () => {
    await page.evaluate(async () => {
      localStorage.setItem('medRegister:unknown', 'eu');
      for (const n of await caches.keys()) if (n.startsWith('medtracker-ema-')) await caches.delete(n);
    });
    await freshPage();
    const before = await heapMB();
    counting = 'first';
    r.first = await page.evaluate(timedCheck, 'Candecor');
    counting = null;
    const after = await heapMB();
    r.heapMB = { before, afterFirst: after, retained: before !== null ? +(after - before).toFixed(1) : null };
    r.cacheNames = await page.evaluate(async () => (await caches.keys()).filter((n) => n.startsWith('medtracker-')));
    if (r.first.status !== 'ready' || r.first.candidates !== 2) throw new Error(`first check: ${JSON.stringify(r.first)}`);
  });

  await ctx.step('next page load reads the stored register (no asset request)', async () => {
    await freshPage();
    counting = 'second';
    r.second = await page.evaluate(timedCheck, 'Candecor');
    counting = null;
    if (r.second.status !== 'ready') throw new Error(`second check: ${JSON.stringify(r.second)}`);
    if (r.assetRequests.second) throw new Error(`${r.assetRequests.second} asset request(s) on the cached load`);
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
  const sheet = async (shot) => {
    await page.locator('#med-eu-chip').click();
    await page.locator('#med-eu-sheet').waitFor({ timeout: 10_000 });
    await ctx.stableShot(shot);
    await page.locator('#med-eu-sheet .wg-sheethead .wg-btn').click();
  };
  await ctx.step('ER3/ER7 one entry', async () => { await editor('Candecor', 'er3-chip'); await sheet('er7-sheet'); });
  await ctx.step('ER5/ER8 several entries', async () => { await editor('Voltaren', 'er5-several'); await sheet('er8-sheet'); });
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
  ctx.log('euRegister', JSON.stringify(r, null, 2));
}
