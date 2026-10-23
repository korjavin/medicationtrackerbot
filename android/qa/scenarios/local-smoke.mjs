// The passkey-free full-app run (bd med-nt9p.32.6, docs/android.md → Agent QA harness): local mode
// on the real shell with the debug-only extras (bd med-nt9p.32.4) and the QA=1 bundle's driver,
// which seeds the golden vault on ?qa=today. Every tab → the add-BP sheet with the keyboard up →
// Back closes it with the app still open → a med added → force-stop → relaunch on the persisted
// pref alone → the med is still there → Settings shows the Android reminder and Health Connect copy.
// results.local = { durable, networkRequests }: every page request (CDP Network, incl. websockets)
// to a host other than the asset origin, over both loads — must be 0 (the whole-app zero-egress check).

const TABS = [['today', 'today'], ['meds', 'meds'], ['vitals', 'health'], ['food', 'food'], ['settings', 'settings']];

export default async function localSmoke(ctx) {
  const { shell, pkg, sleep, LOCAL_ORIGIN } = ctx;
  const r = (ctx.results.local = { durable: false, networkRequests: 0, egress: [], paint: {} });
  const host = new URL(LOCAL_ORIGIN).host;
  // Every request the page makes, from the first byte of a load: attach, then reload.
  const watchNet = (page) => {
    const note = (url) => {
      const u = new URL(url);
      if (/^(https?|wss?):$/.test(u.protocol) && u.host !== host) { r.networkRequests++; r.egress.push(url); }
    };
    page.on('request', (q) => note(q.url()));
    page.on('websocket', (w) => note(w.url()));
  };
  // A fresh store, so the driver seeds the golden vault (pm clear also drops the local-mode pref).
  await shell(`pm clear ${pkg}`);
  // Notifications allowed, so the reminder row reaches its device wording ("on for this phone").
  await shell(`pm grant ${pkg} android.permission.POST_NOTIFICATIONS`);
  await shell(`appops set ${pkg} SCHEDULE_EXACT_ALARM allow`); // 'granted' needs both (Notifications.permission)

  let page = await ctx.step('cold start in local mode on scene today (seeds the golden vault)', async () => {
    const p = await ctx.launchLocal('today');
    watchNet(p);
    // Playwright attaches only after the launch's first boot, so replay an empty-store first boot
    // under the listener: a same-origin document with no app (the QA bundle's scenes.json shown as
    // text; a 404 has no body and becomes Chromium's error page) wipes the origin's storage, then
    // /?qa=today boots on it, seeds, reloads and runs the scene — all observed.
    await p.goto(`${LOCAL_ORIGIN}/qa/scenes.json`, { waitUntil: 'load', timeout: 30_000 });
    r.wiped = await p.evaluate(async () => {
      localStorage.clear();
      sessionStorage.clear();
      const dbs = await indexedDB.databases();
      await Promise.all(dbs.map((d) => new Promise((res, rej) => {
        const q = indexedDB.deleteDatabase(d.name);
        q.onsuccess = res; q.onerror = () => rej(q.error); q.onblocked = () => rej(new Error(`delete ${d.name} blocked`));
      })));
      return dbs.map((d) => d.name);
    });
    await p.goto(`${LOCAL_ORIGIN}/?qa=today`, { waitUntil: 'load', timeout: 60_000 });
    await ctx.waitLocalReady(p, 'today');
    const report = JSON.parse(await p.locator('#wg-qa-ready').getAttribute('aria-label'));
    r.scene = { ok: report.ok, failed: report.failed, loads: report.loads };
    if (!report.ok && report.failed?.includes('ready')) throw new Error(`scene today: ${JSON.stringify(report)}`);
    if (!(await p.evaluate(() => document.documentElement.classList.contains('wg-local-vault')))) throw new Error('no wg-local-vault on <html>');
    return p;
  });

  // Today is the screen earlier runs shot as a header over an empty body: wait for its content and
  // the bottom nav in the DOM, then for a stable frame, and record how long the paint took.
  for (const [label, tab] of TABS) {
    await ctx.step(`tab ${label}`, async () => {
      // Settings is not a tab in nav v2: the app-bar gear opens it.
      if (tab === 'settings') await page.locator('[data-nav-to="settings"]:visible').first().click();
      else await page.evaluate((t) => window.switchTab(t), tab);
      await page.waitForFunction((id) => !!document.getElementById(id)?.offsetParent, `${tab}-view`, { timeout: 15_000 });
      if (tab === 'today') await page.locator('#today-content > *').first().waitFor({ timeout: 20_000 });
      await page.locator('.wg-tabbar').first().waitFor({ state: 'visible', timeout: 10_000 });
      r.paint[label] = await ctx.stableShot(`tab-${label}`);
    });
  }

  await page.evaluate(() => window.switchTab('today'));
  await sleep(800);
  const sheetOpen = () => page.evaluate(() => window.ModalManager._isVisible('bp-modal'));
  await ctx.step('add-BP sheet → type systolic → keyboard up', async () => {
    await page.evaluate(() => window.showBPRecordModal());
    await sleep(2500); // its programmatic focus() may raise the keyboard: let the resize settle
    if (!(await sheetOpen())) throw new Error('bp-modal not visible');
    // The sheet's own focus() may already have raised the keyboard: a tap at the pre-keyboard rect
    // then lands on the IME's "1" key (attempt 1 typed "112" three runs in a row). Tap only if needed.
    const focused = await page.evaluate(() => document.activeElement?.id === 'bp-systolic');
    r.tappedSystolic = !(focused && (await ctx.imeShown()));
    if (r.tappedSystolic) await ctx.tapElement(page, '#bp-systolic');
    // Type only once the keyboard is up and settled: keys sent while it opens can double (run 39249851915: "112").
    const end = Date.now() + 10_000;
    while (Date.now() < end && !(await ctx.imeShown())) await sleep(500);
    await sleep(1000);
    await shell('input keyevent KEYCODE_1 KEYCODE_2 KEYCODE_8');
    r.keyboard = await page.evaluate(() => {
      const el = document.activeElement;
      const b = el && el.getBoundingClientRect();
      const vv = window.visualViewport;
      const bottom = vv ? vv.offsetTop + vv.height : innerHeight;
      // 3 digits auto-advance focus to diastolic (app.js): the typed value is systolic's.
      return { focused: el && el.id, value: document.getElementById('bp-systolic').value, inputVisible: !!b && b.bottom <= bottom && b.top >= 0 };
    });
    r.keyboard.imeShown = await ctx.imeShown();
    await ctx.shot('bp-sheet-keyboard');
    if (!r.keyboard.imeShown) throw new Error(`no IME (${JSON.stringify(r.keyboard)})`);
    if (r.keyboard.value !== '128') throw new Error(`typed 128, field shows ${JSON.stringify(r.keyboard.value)}`);
  });

  // Back with the keyboard up first hides it, the next closes the sheet; the app stays open throughout.
  await ctx.step('Back closes the sheet, the app stays open', async () => {
    for (let n = 1; n <= 2; n++) {
      await shell('input keyevent KEYCODE_BACK');
      await sleep(1500);
      if (!(await ctx.inForeground())) throw new Error(`app left on Back #${n} with the sheet open`);
      if (!(await sheetOpen())) { r.backPressesToCloseSheet = n; return; }
    }
    throw new Error('sheet still open after 2 Backs');
  });
  await ctx.shot('after-back-sheet');

  // ponytail: the med goes in through the app's API route (apishim → domain → IndexedDB), not the
  // add-med form; drive the form if the form itself needs Android coverage.
  const name = `QA Durable ${Date.now()}`;
  await ctx.step('add a med', async () => {
    await page.evaluate((n) => window.apiCall('/api/medications', 'POST', {
      name: n, dosage: '5mg', schedule: JSON.stringify({ type: 'as_needed' }),
    }), name);
    const meds = await page.evaluate(() => window.apiCall('/api/medications'));
    if (!meds.some((m) => m.name === name)) throw new Error('the new med is not listed');
    await sleep(1500); // IndexedDB commits are done; give leveldb its write before the kill
  });

  await ctx.step('force-stop → relaunch (persisted pref, no extras) → the med is still there', async () => {
    page = await ctx.launchLocal(undefined, { extra: false });
    watchNet(page);
    // The same boot again under the listener (the store is persisted; nothing differs but the attach).
    await page.reload({ waitUntil: 'load', timeout: 60_000 });
    await ctx.waitLocalReady(page);
    const meds = await page.evaluate(() => window.apiCall('/api/medications'));
    r.durable = meds.some((m) => m.name === name);
    if (!r.durable) throw new Error(`med ${name} gone after relaunch`);
    // Meds opens on History (intakes); the med list is the Schedule sub-tab.
    await page.evaluate(() => window.switchTab('meds'));
    await page.locator('.med-tab[data-tab="schedule"]').click();
    const row = page.locator('#med-list').getByText(name).first();
    await row.waitFor({ timeout: 15_000 });
    await row.scrollIntoViewIfNeeded();
    r.paint.relaunch = await ctx.stableShot('relaunch-meds');
  });

  await ctx.step('Settings: Android reminder copy and the Health Connect row', async () => {
    await page.locator('[data-nav-to="settings"]:visible').first().click();
    const row = page.locator('#health-import-row .wg-setting__title');
    await row.waitFor({ timeout: 15_000 });
    r.healthLabel = (await row.textContent()).trim();
    // A finding, not a stopper (bd med-nt9p.38: the "On this device only" row says iPhone).
    r.iPhoneText = await page.evaluate(() => (document.getElementById('settings-view')?.innerText.match(/iPhone/g) || []).length);
    await page.evaluate(() => window.SettingsView.openSettingsPage('notifications'));
    const state = page.locator('#local-notify-state');
    // Attached, not visible: a denied permission swaps the status card for the warn note (kit S8).
    await state.waitFor({ state: 'attached', timeout: 10_000 });
    await page.waitForFunction(() => !/^(Checking|Notifications are allowed)/.test(document.getElementById('local-notify-state').textContent), null, { timeout: 15_000 }).catch(() => {});
    r.reminderCopy = (await state.textContent()).trim();
    r.reminderDevice = await page.evaluate(() => window.LocalNotifications?.copy?.device);
    await ctx.stableShot('settings-notifications');
    if (r.healthLabel !== 'Health Connect') throw new Error(`health row: ${r.healthLabel}`);
    if (r.reminderDevice !== 'phone' || /iPhone|iOS/.test(r.reminderCopy) || !/phone|Android/.test(r.reminderCopy)) throw new Error(`reminder copy: ${r.reminderDevice} / ${r.reminderCopy}`);
  });

  // bd med-ta2n.18: the Telegram row's local page is a sync offer (no telegram.js).
  await ctx.step('Settings: Telegram offer page (needs sync)', async () => {
    await page.evaluate(() => window.SettingsView.openSettingsPage('telegram'));
    await page.locator('#telegram-settings-mount [data-action="telegram-turn-on-sync"]').waitFor({ timeout: 15_000 });
    await ctx.stableShot('settings-telegram-offer');
  });

  await ctx.step('zero egress: no request left the asset origin', async () => {
    if (r.networkRequests) throw new Error(`${r.networkRequests} request(s) off the asset origin: ${r.egress.slice(0, 10).join(', ')}`);
  });
  ctx.log('local', JSON.stringify(r, null, 2));
}
