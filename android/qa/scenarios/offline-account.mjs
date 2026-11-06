// B1: account cold boot with real radios OFF. TLS receipts start before launch and include
// initial-navigation/SW traffic that attaching CDP afterwards cannot observe (Archie17180).
import { readFileSync } from 'node:fs';
import { claimAccount, waitForVault } from './smoke.mjs';
export const retry = false; // one invite; never in all

export default async function offlineAccount(ctx) {
  const r = (ctx.results.offlineAccount = { sections: {}, failedAttempts: [] });
  if (!process.env.QA_RECEIPTS) throw new Error('QA_RECEIPTS unset');
  const receipts = () => readFileSync(process.env.QA_RECEIPTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  await ctx.shell(`pm clear ${ctx.pkg}`);
  await ctx.shell(`pm grant ${ctx.pkg} android.permission.POST_NOTIFICATIONS`);
  await ctx.shell(`appops set ${ctx.pkg} SCHEDULE_EXACT_ALARM allow`);
  let page = await ctx.step('prepare a populated golden vault', () => ctx.launchLocal('today'));
  const fixture = await page.evaluate(() => window.CloudVault.exportAll({ includeSecrets: false }));
  // The local origin's seeded content is fixture setup, not the account behavior being tested.
  // Clear it before openClaim so there is no local-to-cloud move ceremony in this account run.
  await ctx.shell(`pm clear ${ctx.pkg}`);
  // Same permission precondition as local-smoke; permission-sheet coverage belongs elsewhere.
  await ctx.shell(`pm grant ${ctx.pkg} android.permission.POST_NOTIFICATIONS`);
  await ctx.shell(`appops set ${ctx.pkg} SCHEDULE_EXACT_ALARM allow`);
  page = await ctx.step('claim run invite with soft authenticator', () => ctx.openClaim({ softAuthn: true }));
  await claimAccount(ctx, page);
  await ctx.step('import golden records and complete real account sync', async () => {
    r.nativeClockBefore = Number((await ctx.shell('date +%s')).trim()) * 1000;
    r.fixtureClock = await page.evaluate(() => ({ now: Date.now(), pinned: !!Date.wgQAPinned, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
    if (r.fixtureClock.pinned) throw new Error('account fixture must use the real clock');
    // The local visual driver's clock is 23:00; the account uses the real device clock.
    // At 01:00 its same-day BP/food/sleep would otherwise still be in the future. Establish
    // actual saved-data preconditions using that account clock, keeping the fixture's values.
    const prepared = await page.evaluate((json) => {
      const v = JSON.parse(json);
      const now = Date.now();
      const iso = (ms) => new Date(ms).toISOString();
      const day = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
      v.data.bp.readings.at(-1).measured_at = iso(now - 120000);
      v.data.weight.logs.at(-1).measured_at = iso(now - 180000);
      v.data.food.logs[0].eaten_at = iso(now - 60000);
      v.data.food.products[0].last_used_at = iso(now - 60000);
      // One canonical completed sleep: 450 asleep +15 awake, ending four hours ago.
      const end = now - 4 * 3600000;
      v.data.vitals.sleep = [{ ...v.data.vitals.sleep.at(-1), start_time: iso(end - 465 * 60000), end_time: iso(end),
        timezone_offset: 0, day: day(end), total_minutes: 450, source_id: day(end) }];
      v.data.vitals.day_stats.at(-1).day = day(now);
      v.data.vitals.heart.at(-1).date_time = iso(now - 120000);
      v.data.vitals.spo2.at(-1).date_time = iso(now - 120000);
      v.data.settings.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return JSON.stringify(v);
    }, fixture);
    r.nativeClockAfter = Number((await ctx.shell('date +%s')).trim()) * 1000;
    if (r.fixtureClock.now < r.nativeClockBefore - 1000 || r.fixtureClock.now > r.nativeClockAfter + 1000) throw new Error('account fixture clock differs from native bracket');
    r.import = await page.evaluate((json) => window.CloudVault.importAll(json), prepared);
    if (r.import.upload !== 'synced') throw new Error(`golden import not uploaded: ${r.import.upload}`);
    await page.evaluate(() => window.DataStore.invalidateTags(['bp', 'weight', 'medications', 'history', 'food', 'workout', 'health', 'notes', 'settings', 'food_targets', 'feature_settings']));
    await page.reload({ waitUntil: 'load' });
    await waitForVault(page);
    r.host = new URL(page.url()).host;
    r.seed = JSON.parse(prepared).data;
    // Record counts/content are retained in the artifact; never print fixture credentials.
    delete r.seed.settings.integrations;
    await page.waitForFunction(async () => {
      const s = await import('/js/sync.js');
      const st = await s.getSyncStatus(window.MedTrackerCloud.ctx);
      return st.pendingCount === 0 && !st.offline && !st.snapshotError && !st.wedged && !st.writeError;
    }, null, { timeout: 90_000 });
  });
  const go = async (tab) => {
    await page.evaluate((t) => window.switchTab(t), tab);
    await page.locator(`#${tab}-view`).waitFor({ state: 'visible', timeout: 15_000 });
  };
  const views = [
    ['today', 'today', null, '#today-content', /Lisinopril|Fuel/],
    ['meds', 'meds', '.med-tab[data-tab="timeline"]', '#med-timeline-list', /Lisinopril/],
    ['food-log', 'food', '.food-tab[data-tab="log"]', '#food-list', /Greek yogurt/],
    ['food-db', 'food', '.food-tab[data-tab="fooddb"]', '#fooddb-list', /Greek yogurt 2%/],
    ['workout-plans', 'workouts', '.workout-tab[data-tab="groups"]', '#workout-groups-list', /Push\/Pull/],
    ['workout-equipment', 'workouts', '.workout-tab[data-tab="equipment"]', '#workout-equipment-list', /Ohio bar[\s\S]*Hex DBs|Hex DBs[\s\S]*Ohio bar/],
    ['bp', 'bp', null, '#bp-list', /135[\s\S]*85/],
    ['weight', 'weight', null, '#weight-list', /82[.,]1/],
    ['vitals-sleep', 'health', '.health-tab[data-tab="overview"]', '#health-overview-content', /SLEEP/],
    ['diary', 'health', '.health-tab[data-tab="notes"]', '#notes-list', /Felt good after the run today/],
    ['settings', 'settings', null, '#settings-view', /2200|2,200|Targets|Units/],
  ];
  const checkViews = async (phase) => {
    r.sections[phase] = {};
    for (const [name, tab, button, selector, expected] of views) {
      await ctx.step(`${phase}: ${name} renders saved rows without network wait`, async () => {
        const t0 = Date.now();
        await go(tab);
        if (button) await page.locator(button).click();
        await page.locator(selector).filter({ hasText: expected }).waitFor({ timeout: 15_000 });
        if (name === 'today') {
          for (const [tile, value] of [['bp', /135[\s\S]*85/], ['weight', /82[.,]1/], ['fuel', /130/], ['sleep', /7h 30m/], ['steps', /10,200/]]) {
            await page.locator(`[data-section="${tile}"]`).filter({ hasText: value }).waitFor({ timeout: 15_000 });
          }
        }
        const text = await page.locator(selector).innerText();
        if (/Failed to load|No sleep data yet|No food logged today|No notes yet/.test(text)) throw new Error(`${name} rendered empty/error: ${text}`);
        r.sections[phase][name] = { ms: Date.now() - t0, text: text.slice(0, 5000) };
        // Under the sync engine's 10s timedFetch deadline (sync.js SYNC_FETCH_TIMEOUT_MS).
        // This bounds cached rendering on this emulator; it is not a physical-phone latency claim.
        if (phase === 'offline' && r.sections[phase][name].ms >= 5000) throw new Error(`${name} waited ${r.sections[phase][name].ms}ms for cached rows`);
        if (name === 'vitals-sleep') {
          const sleepText = await page.locator('.wg-sleep-card').innerText();
          if (!/7[.,]5/.test(sleepText)) throw new Error(`saved 450 minute sleep missing: ${sleepText}`);
          r.sections[phase][name].sleepText = sleepText;
        }
        if (name === 'settings') {
          await page.evaluate(() => window.SettingsView.openSettingsPage('units'));
          await page.locator('#settings-height-input').waitFor({ state: 'visible' });
          const height = await page.inputValue('#settings-height-input');
          if (height !== '180') throw new Error(`saved height missing from Settings: ${height}`);
          r.sections[phase][name].height = height;
          await ctx.shot(`${phase}-settings-units`);
          await ctx.waitFor({ clazz: 'android.webkit.WebView' }, 30_000);
          await ctx.shell('input keyevent KEYCODE_BACK');
          await ctx.sleep(500);
          if (!(await ctx.inForeground())) throw new Error('Back from Units left app');
        }
        // Keep the DOM render timing above separate from the emulator's delayed GPU capture.
        if (phase === 'offline') r.sections[phase][name].paintSettleSeconds = await ctx.stableShot(`offline-${name}`);
      });
    }
    // Compare real stored values too: a heading or a section's unrelated row cannot prove its seed.
    const vault = JSON.parse(await page.evaluate(() => window.CloudVault.exportAll({ includeSecrets: false })));
    for (const [section, key] of [['bp', 'readings'], ['weight', 'logs'], ['food', 'logs'], ['food', 'products'], ['workouts', 'groups'], ['workouts', 'equipment'], ['workouts', 'locations'], ['vitals', 'sleep'], ['diary', 'notes']]) {
      const before = r.seed[section][key];
      const after = vault.data[section][key];
      if (!before?.length || !after?.length || before.some((row) => !after.some((got) => Object.keys(row).every((k) => JSON.stringify(got[k]) === JSON.stringify(row[k]))))) {
        throw new Error(`${phase}: ${section}.${key} saved content changed`);
      }
    }
    if (vault.data.settings.height_cm !== 180 || vault.data.settings.food_targets.calories !== 2200) throw new Error(`${phase}: saved settings missing`);
  };
  await checkViews('online');
  await ctx.step('warm controlled SW/cache and persist account before kill', async () => {
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: 'load' });
    await waitForVault(page);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    r.cache = await page.evaluate(async () => ({ controlled: !!navigator.serviceWorker.controller, caches: await caches.keys() }));
    r.receiptsOnline = receipts().filter((x) => x.host === r.host).length;
    if (!r.receiptsOnline) throw new Error('receipt accounting did not observe online account');
    await ctx.sleep(6000);
  });
  await ctx.step('Food: browse yesterday before offline relaunch', async () => {
    await go('food');
    await page.locator('.food-tab[data-tab="log"]').click();
    r.foodToday = await page.inputValue('#food-date-filter');
    await page.click('#food-date-prev-btn');
    r.foodYesterday = await page.inputValue('#food-date-filter');
    if (!r.foodToday || !r.foodYesterday || r.foodYesterday >= r.foodToday) throw new Error(`Food did not navigate to an earlier date: ${r.foodYesterday} / ${r.foodToday}`);
    await ctx.shot('food-yesterday-before-offline');
  });
  const saved = r.radiosBefore = {
    airplane: (await ctx.shell('settings get global airplane_mode_on')).trim(),
    wifi: (await ctx.shell('settings get global wifi_on')).trim(),
    data: (await ctx.shell('settings get global mobile_data')).trim(),
  };
  try {
    await ctx.step('radios off, force-stop, count before plain account cold launch', async () => {
      await ctx.shell('cmd connectivity airplane-mode enable');
      await ctx.shell('svc wifi disable');
      await ctx.shell('svc data disable');
      await page.waitForFunction(() => !navigator.onLine, null, { timeout: 30_000 });
      await ctx.shell(`am force-stop ${ctx.pkg}`);
      await ctx.sleep(2000);
      r.receiptsBefore = receipts().filter((x) => x.host === r.host).length;
      r.intervalStartedAt = new Date().toISOString();
      await ctx.shell(`am start -W -n ${ctx.pkg}/com.example.medtracker.MainActivity --ez qaSoftAuthn true`);
      page = await ctx.attachPage();
      if (!page) throw new Error('no offline WebView');
      page.on('requestfailed', (q) => r.failedAttempts.push({ path: new URL(q.url()).pathname, failure: q.failure() }));
      await waitForVault(page);
      await page.locator('.wg-tabbar').first().waitFor({ timeout: 60_000 });
      r.offlineBoot = await page.evaluate(() => ({ online: navigator.onLine, controlled: !!navigator.serviceWorker.controller, host: location.host }));
      if (r.offlineBoot.online || !r.offlineBoot.controlled || r.offlineBoot.host !== r.host) throw new Error(`offline boot ${JSON.stringify(r.offlineBoot)}`);
      r.radiosOff = {
        airplane: await ctx.shell('settings get global airplane_mode_on'),
        wifi: await ctx.shell('settings get global wifi_on'),
        data: await ctx.shell('settings get global mobile_data'),
      };
      if (r.radiosOff.airplane.trim() !== '1' || r.radiosOff.wifi.trim() !== '0' || r.radiosOff.data.trim() !== '0') throw new Error('radios not actually disabled');
    });
    await ctx.step('offline Food opens on today after browsing yesterday', async () => {
      await go('food');
      await page.locator('.food-tab[data-tab="log"]').click();
      r.foodAfterRelaunch = await page.inputValue('#food-date-filter');
      const today = await page.evaluate(() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      });
      if (r.foodAfterRelaunch !== today || r.foodAfterRelaunch === r.foodYesterday) throw new Error(`Food opened ${r.foodAfterRelaunch}, expected ${today}`);
      await ctx.stableShot('offline-food-today-after-relaunch');
    });
    await checkViews('offline');
    await ctx.step('offline: real note write stays enabled, durable after reload and pending', async () => {
      await go('health');
      await page.locator('.health-tab[data-tab="notes"]').click();
      await page.fill('#notes-textarea', 'QA B1 offline durable note');
      await page.click('#notes-save-btn');
      await page.locator('#notes-list').getByText('QA B1 offline durable note', { exact: true }).waitFor();
      await page.reload({ waitUntil: 'load' });
      await waitForVault(page);
      await go('health');
      await page.locator('.health-tab[data-tab="notes"]').click();
      await page.locator('#notes-list').getByText('QA B1 offline durable note', { exact: true }).waitFor();
      r.pendingOffline = await page.evaluate(async () => (await import('/js/sync.js')).getSyncStatus(window.MedTrackerCloud.ctx));
      if (!(r.pendingOffline.pendingCount > 0)) throw new Error('offline write not queued');
      await ctx.shot('offline-written-note');
    });
    await ctx.step('offline interval: zero TLS-front receipts including initial navigation and SW', async () => {
      r.intervalEndedAt = new Date().toISOString();
      r.receiptsAfter = receipts().filter((x) => x.host === r.host).length;
      r.receiptsDuringColdBoot = r.receiptsAfter - r.receiptsBefore;
      if (r.receiptsDuringColdBoot !== 0) throw new Error(`offline account received ${r.receiptsDuringColdBoot} requests`);
    });
  } finally {
    await ctx.shell(`cmd connectivity airplane-mode ${saved.airplane === '1' ? 'enable' : 'disable'}`);
    await ctx.shell(`svc wifi ${saved.wifi === '0' ? 'disable' : 'enable'}`);
    await ctx.shell(`svc data ${saved.data === '0' ? 'disable' : 'enable'}`);
    r.radiosRestored = {
      airplane: (await ctx.shell('settings get global airplane_mode_on')).trim(),
      wifi: (await ctx.shell('settings get global wifi_on')).trim(),
      data: (await ctx.shell('settings get global mobile_data')).trim(),
    };
    if (JSON.stringify(saved) !== JSON.stringify(r.radiosRestored)) throw new Error(`radio cleanup failed: ${JSON.stringify(r.radiosRestored)}`);
  }
  await ctx.step('reconnect: queued note reaches server and remains after synced reload', async () => {
    await page.waitForFunction(() => navigator.onLine, null, { timeout: 30_000 });
    r.flushAcknowledged = await page.evaluate(async () => (await import('/js/sync.js')).flushConfirmed(window.MedTrackerCloud.ctx));
    if (!r.flushAcknowledged) throw new Error('server did not acknowledge offline write');
    r.synced = await page.evaluate(async () => (await import('/js/sync.js')).getSyncStatus(window.MedTrackerCloud.ctx));
    if (r.synced.pendingCount || r.synced.offline || r.synced.writeError || r.synced.integrityErrors) throw new Error(`queue not synced: ${JSON.stringify(r.synced)}`);
    r.receiptsReconnected = receipts().filter((x) => x.host === r.host).length;
    if (!(r.receiptsReconnected > r.receiptsAfter)) throw new Error('receipt observer failed after reconnect');
    await page.reload({ waitUntil: 'load' });
    await waitForVault(page);
    await go('health');
    await page.locator('.health-tab[data-tab="notes"]').click();
    await page.locator('#notes-list').getByText('QA B1 offline durable note', { exact: true }).waitFor();
    await ctx.shot('reconnected-synced-note');
  });
}
