// Reminders and offline on the emulator (bd med-nt9p.55), so the phone keeps only what an emulator
// cannot show (real-OEM doze, Google Password Manager, Play referrer, Health Connect data):
// 1. Settings → Notifications → Enable walks both system grants through UiAutomator (the
//    POST_NOTIFICATIONS prompt, then Alarms & reminders) → 'granted'.
// 2. A med due in ~2 min → the app process killed → the notification is posted anyway.
// 3. Its tap opens that dose's take sheet (bd med-nt9p.52: row url → ReminderPath → handleDeepLinks).
//    bd med-5vy0.3: the lock-screen text pref is set to Detailed first (the default depends on the
//    account's history since med-5vy0.1), so this one names the medication.
// 3a. Stale taps (bd med-wi09.7, twin of iOS reminder-stale-*): that dose taken in-app, then two
//    notifications with the page's own reminderDeeplink urls posted through the shell — its exact
//    slot (→ the "Already logged" toast, no take sheet, the TAKEN count unchanged) and a minute off
//    it, as a schedule edit leaves one (→ the MT6 "out of date" note). Each tap must reach the page
//    with that url unchanged (ReminderPath adds no target).
// 3b. Generic: a second med scheduled under Detailed, then the pref switched → its stored row is
//    rescheduled to "Medication time"; app killed → the posted text is generic, without the name.
// 4. Offline cold start: airplane mode, force-stop, relaunch → the account renders from the SW.
// 5. Last (bd med-nt9p.57; the reboot kills the UiAutomator driver): rows moved back to credential-
//    encrypted prefs migrate to device-protected storage on the next start; then a med due in ~4 min,
//    a PIN, reboot → posted while still locked; the PIN unlocks → no second post, an alarm armed.
// The locked tap (local mode's app lock) is not covered yet: see the ponytail note at its place.
// In `all` it runs after smoke and reopens smoke's account; dispatched alone it claims the invite.
// "Killed" is HOME + am kill (+ kill -9), not am force-stop: Android drops a force-stopped app's alarms.
// results.reminders = { permission: 'ui' | 'pm-grant/appops fallback: …', … } in qa-summary.json.
import { execFile } from 'node:child_process';
import { claimAccount, waitForVault } from './smoke.mjs';

const MODAL = 'med-confirm-modal';
const GENERIC = 'Medication time'; // web/domain/reminders.js GENERIC_DOSE_TEXT, emoji dropped
// Device-protected storage (bd med-nt9p.57); run-as starts in the credential-encrypted data dir.
const DE_ROWS = `/data/user_de/0/${process.env.QA_PKG || 'com.example.medtracker'}/shared_prefs/reminders.xml`;

export default async function remindersOffline(ctx) {
  const { shell, pkg, sleep } = ctx;
  const r = (ctx.results.reminders ||= {}); // a retry adds to the first attempt's findings
  r.attempts = (r.attempts || 0) + 1;
  await shell('svc power stayon true'); // the screen stays on through the notification waits
  // Undo local-smoke's pm grant / appops (and a retry's grants), so Enable meets both system screens.
  await shell(`pm revoke ${pkg} android.permission.POST_NOTIFICATIONS`).catch(() => {});
  await shell(`pm clear-permission-flags ${pkg} android.permission.POST_NOTIFICATIONS user-set user-fixed`).catch(() => {});
  await shell(`appops set ${pkg} SCHEDULE_EXACT_ALARM default`);
  try {
    let page = await ctx.step('open the account', () => openVault(ctx, r));
    r.console ||= [];
    page.on('console', (m) => { if (r.console.length < 60 && !/stub response/.test(m.text())) r.console.push(m.text().slice(0, 200)); });

    await ctx.step('Settings → Notifications → Enable → both system grants → granted', async () => {
      // In-page clicks: Playwright locator clicks on the gear and the row timed out with them on screen (runs 39914887973, 39916962235).
      await page.evaluate(() => [...document.querySelectorAll('[data-nav-to="settings"]')].find((b) => b.offsetParent)?.click());
      await sleep(1500);
      await page.evaluate(() => window.SettingsView.openSettingsPage('notifications'));
      const toggle = page.locator('#cloud-push-toggle');
      await toggle.waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForFunction(() => !document.getElementById('cloud-push-toggle').disabled, null, { timeout: 15_000 });
      await ctx.stableShot('settings-notifications-off');
      await page.evaluate(() => document.getElementById('cloud-push-toggle').click()); // a locator click timed out on attempt 2
      // bd med-nt9p.61: per-stage elapsed ms, so a stall names its stage (the 60 s wait is the native
      // LocalNotifications permission bridge — settings.js toggleLocalNotifications — not web push).
      const tm = (r.timings = {});
      let t0 = Date.now();
      r.permission = await grantBoth(ctx, r, tm);
      tm.grantBothMs = Date.now() - t0;
      tm.foregroundAfterGrant = await ctx.inForeground();
      t0 = Date.now();
      try {
        await page.waitForFunction(() => document.getElementById('cloud-push-toggle').dataset.subscribed === '1', null, { timeout: 60_000 });
      } finally {
        tm.subscribedWaitMs = Date.now() - t0;
        r.permissionState = await page.evaluate(() => window.LocalNotifications.permission()).catch((e) => `error ${e?.message}`);
        r.toggle = await page.evaluate(() => {
          const t = document.getElementById('cloud-push-toggle');
          return { text: t.textContent, disabled: t.disabled, sub: t.dataset.subscribed, status: document.getElementById('cloud-push-status')?.textContent };
        }).catch((e) => `error ${e?.message}`);
        r.grants = {
          post: (await shell(`dumpsys package ${pkg} | grep POST_NOTIFICATIONS`)).replace(/\s+/g, ' '),
          alarm: await shell(`appops get ${pkg} SCHEDULE_EXACT_ALARM`),
          foreground: await ctx.inForeground(),
        };
      }
      await ctx.stableShot('settings-notifications-on');
      if (r.permissionState !== 'granted') throw new Error(`permission ${r.permissionState}`);
    });

    const acct = (r.account = {});
    await ctx.step('account: lock-screen text set to Detailed', async () => {
      r.prefBefore = await page.evaluate(() => window.apiCall('/api/settings/reminder-delivery'));
      r.prefDetailed = await setLockscreen(page, 'detailed');
    });
    const med = await ctx.step('account: a med due in ~2 min is scheduled on the device', () => addDueMed(ctx, page, acct));
    await ctx.step('account: app killed → the reminder is posted', async () => {
      await killApp(ctx);
      await waitNotification(ctx, med, med.name, acct);
    });
    await ctx.step('account: the tap opens the take sheet for that dose', async () => {
      await tapNotification(ctx, new RegExp(`.*Time to take: ${med.name}.*`), 'account');
      page = await ctx.attachPage();
      if (!page) throw new Error('no WebView page after the tap');
      await waitForVault(page);
      await waitSheet(page, med.name, acct);
      await ctx.stableShot('account-take-sheet');
    });

    page = await ctx.step('account: stale taps — taken in-app → "Already logged" toast, no new TAKEN row; slot moved → MT6', () =>
      staleTaps(ctx, page, med, (r.stale = {})));

    await ctx.step('account: Generic reschedules the rows; app killed → "Medication time", no name', async () => {
      const gen = (r.generic = {});
      const med2 = await addDueMed(ctx, page, gen);
      gen.pref = await setLockscreen(page, 'generic');
      // The PUT recomputes at once: the stored row for the slot loses the name.
      for (const end = Date.now() + 30_000; ;) {
        const rows = await ctx.shell(`run-as ${ctx.pkg} cat ${DE_ROWS}`).catch(() => '');
        if (rows.includes(GENERIC) && !rows.includes(med2.name)) break;
        if (Date.now() > end) throw new Error(`rows not rescheduled generic: ${rows.slice(0, 300)}`);
        await ctx.sleep(1000);
      }
      gen.rescheduled = true;
      await killApp(ctx);
      await waitNotification(ctx, med2, GENERIC, gen);
      gen.nameLines = Number(await ctx.shell(`dumpsys notification --noredact | grep -c "${med2.name}"`).catch(() => '0')) || 0;
      await ctx.shell('cmd statusbar expand-notifications');
      await ctx.waitFor({ text: new RegExp(`.*${GENERIC}.*`) }, 15_000);
      await ctx.stableShot('shade-account-generic');
      await ctx.shell('cmd statusbar collapse');
      if (gen.nameLines) throw new Error(`the generic notification names "${med2.name}" (${gen.nameLines} lines)`);
    });

    await ctx.step('offline cold start renders the account from the SW', async () => {
      const off = (r.offline = {});
      try {
        await shell('cmd connectivity airplane-mode enable');
        await shell('svc wifi disable');
        await shell('svc data disable');
        await sleep(3000);
        await shell(`am force-stop ${pkg}`);
        await sleep(2000);
        await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity --ez qaSoftAuthn true`);
        page = await ctx.attachPage();
        if (!page) throw new Error('no WebView page offline');
        await page.locator('.wg-tabbar').first().waitFor({ state: 'visible', timeout: 90_000 });
        Object.assign(off, await page.evaluate(() => ({
          url: location.href,
          online: navigator.onLine,
          controlled: !!navigator.serviceWorker?.controller,
          title: document.title,
        })));
        off.n4 = await ctx.device.wait({ text: /.*(Can['’]t reach your account|Copy diagnostics).*/ }, { timeout: 1_000 }).then(() => true, () => false);
        await ctx.stableShot('offline-cold-start');
        if (!off.url.startsWith('https://')) throw new Error(`not the app document: ${off.url}`);
        if (off.n4) throw new Error('the N4 load-error screen shows');
        if (off.online) throw new Error('navigator.onLine is still true: the device was not offline');
        if (!off.controlled) throw new Error('the document is not SW-controlled');
      } finally {
        await shell('cmd connectivity airplane-mode disable');
        await shell('svc wifi enable');
        await shell('svc data enable');
      }
    });

    await ctx.step('upgrade moves the rows to device-protected storage; after a reboot a reminder posts before the first unlock', () =>
      rebootLocked(ctx, page, (r.reboot = {})));

    // ponytail: no locked-tap step (the local-mode app lock + a reminder tap while locked). Turning the
    // lock on needs the system credential screen. In runs 39924844133 / 39930468307, `locksettings
    // set-pin` + lock.set left the focus on the ImmersiveModeConfirmation window, so the PIN keys
    // never reached the prompt (FLAG_SECURE: its shots are black). The harness then stalled until the
    // 45-min job timeout, even past bounded waits. Follow-up bead: dismiss the immersive notice
    // (`settings put secure immersive_mode_confirmations confirmed`) and find the stall.
  } finally {
    await adb(['shell', 'svc power stayon false']); // the reboot step closed ctx.shell's device
  }
}

/** The account in the foreground, unlocked: smoke's (all), a claim (alone), or the retry's after local mode. */
async function openVault(ctx, r) {
  const { shell, pkg } = ctx;
  const prefs = await shell(`run-as ${pkg} cat shared_prefs/shell.xml`).catch(() => '');
  if (!/name="accountHost"/.test(prefs)) {
    r.account = 'claimed';
    const page = await ctx.openClaim({ softAuthn: true });
    await claimAccount(ctx, page);
    return page;
  }
  r.account = 'reopened';
  await shell(`am force-stop ${pkg}`);
  // ponytail: a retry after the local-mode part flips the pref back by hand; the shell has no QA extra for it.
  if (/name="wgLocalMode" value="true"/.test(prefs)) await shell(`run-as ${pkg} sed -i 's/"wgLocalMode" value="true"/"wgLocalMode" value="false"/' shared_prefs/shell.xml`);
  await ctx.sleep(2000);
  await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity --ez qaSoftAuthn true`);
  const page = await ctx.attachPage();
  if (!page) throw new Error('no WebView page');
  await waitForVault(page);
  return page;
}

/**
 * The system side of Enable: the POST_NOTIFICATIONS prompt's Allow, then the Alarms & reminders
 * switch and Back. A screen that does not show falls back to pm grant / appops; the return says which.
 */
async function grantBoth(ctx, out, tm = {}) {
  const { shell, pkg, device } = ctx;
  const seen = async (sel, ms) => { // tm[sel's key]: ms until it showed (or the timeout)
    const t0 = Date.now();
    const ok = await device.wait(sel, { timeout: ms }).then(() => true, () => false);
    tm[sel.res ? 'notifPromptMs' : 'alarmsPageMs'] = Date.now() - t0;
    return ok;
  };
  const notes = [];
  const allow = { res: 'com.android.permissioncontroller:id/permission_allow_button' };
  if (await seen(allow, 20_000)) {
    await ctx.shot('system-notifications-prompt');
    await device.tap(allow);
  } else {
    notes.push('pm grant POST_NOTIFICATIONS (no prompt)');
    await ctx.shot('no-notifications-prompt');
    await shell(`pm grant ${pkg} android.permission.POST_NOTIFICATIONS`);
  }
  const alarms = { text: /.*Allow setting alarms and reminders.*/ };
  if (await seen(alarms, 20_000)) {
    await ctx.shot('system-alarms-page');
    // bd med-nt9p.56: the page's Enable must still be waiting while Alarms & reminders is up.
    out.whileAlarmsPage = await ctx.page.evaluate(() => {
      const t = document.getElementById('cloud-push-toggle');
      return { disabled: t.disabled, status: document.getElementById('cloud-push-status')?.textContent || '' };
    }).catch((e) => `error ${e?.message}`);
    await device.tap(alarms);
    await ctx.sleep(1500);
    await ctx.shot('system-alarms-allowed');
    const t0 = Date.now();
    await shell('input keyevent KEYCODE_BACK');
    for (const end = Date.now() + 10_000; !(await ctx.inForeground()) && Date.now() < end;) await ctx.sleep(500);
    tm.resumeMs = Date.now() - t0;
  } else {
    notes.push('appops SCHEDULE_EXACT_ALARM allow (no Alarms & reminders page)');
    await ctx.shot('no-alarms-page');
    await shell(`appops set ${pkg} SCHEDULE_EXACT_ALARM allow`);
    // The page's reply waits for a resume: Back from whatever is up, or nothing.
    if (!(await ctx.inForeground())) await shell('input keyevent KEYCODE_BACK');
  }
  return notes.length ? `pm-grant/appops fallback: ${notes.join('; ')}` : 'ui';
}

/**
 * The upgrade migration, then the last step (the reboot closes Playwright's AndroidDevice, so it
 * runs on the adb CLI and nothing may follow it). bd med-nt9p.57: the receivers are direct-boot aware and the rows
 * live in device-protected storage, so a reminder due after a reboot posts before the first unlock.
 */
async function rebootLocked(ctx, page, out) {
  const { shell, pkg, sleep } = ctx;
  // Upgrade path first (the current Play build kept the rows in credential-encrypted prefs): move the
  // file back there with the app dead; the next process moves it to device-protected storage again.
  // postedThrough tells the migrated file from a fresh schedule (schedule() never writes it).
  await killApp(ctx);
  const before = await shell(`run-as ${pkg} cat ${DE_ROWS}`);
  const posted = (before.match(/name="postedThrough" value="(\d+)"/) || [])[1];
  if (!posted) throw new Error(`no postedThrough in the stored rows: ${before.slice(0, 300)}`);
  await shell(`run-as ${pkg} mv ${DE_ROWS} shared_prefs/reminders.xml`);
  await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity --ez qaSoftAuthn true`);
  const end = Date.now() + 90_000;
  for (;;) {
    const de = await shell(`run-as ${pkg} cat ${DE_ROWS}`).catch(() => '');
    const ce = await shell(`run-as ${pkg} ls shared_prefs`).catch(() => '');
    if (de.includes(`name="postedThrough" value="${posted}"`) && !ce.includes('reminders.xml')) break;
    if (Date.now() > end) throw new Error(`not migrated: de=${de.slice(0, 200)} ce=${ce}`);
    await sleep(2000);
  }
  out.migrated = true;

  page = await ctx.attachPage();
  if (!page) throw new Error('no WebView page after the migration launch');
  await waitForVault(page);
  out.pref = await setLockscreen(page, 'detailed'); // the Generic step left it generic; this waits for the name
  const med = await addDueMed(ctx, page, out, 240_000); // past the reboot (~1–2 min on the CI emulator)
  // From here the adb CLI: the reboot closes Playwright's AndroidDevice, ctx.shell included.
  const adbShell = (cmd) => adb(['shell', cmd]);
  const user = async () => ((await adbShell('dumpsys user')).match(/State: (\w+)/) || [])[1] || 'unknown';
  await adbShell('locksettings set-pin 1234');
  try {
    await adb(['reboot']);
    await sleep(20_000);
    for (const stop = Date.now() + 240_000; ; await sleep(3000)) {
      if ((await adbShell('getprop sys.boot_completed')) === '1') break;
      if (Date.now() > stop) throw new Error('the emulator did not come back from the reboot');
    }
    out.userAtBoot = await user();
    await sleep(10_000); // LOCKED_BOOT_COMPLETED → Rearm
    out.armLog = (await adbShell('logcat -d -s Notifications:*')).split('\n').slice(-6);
    out.alarmAtBoot = (await adbShell(`dumpsys alarm | grep -A2 ${pkg}`)).split('\n').slice(0, 12);
    if (out.userAtBoot !== 'RUNNING_LOCKED') throw new Error(`not locked after the reboot: ${out.userAtBoot}`);
    // The reboot emptied the shade. Locked, the alarm is inexact (≤ ~3/4 of the lead late): 6 min.
    await waitNotification({ ...ctx, shell: adbShell }, med, med.name, out, 0, 6);
    out.postLog = (await adbShell('logcat -d -s Notifications:*')).split('\n').slice(-4);
    out.userAtPost = await user();
    if (out.userAtPost !== 'RUNNING_LOCKED') throw new Error(`posted only after the unlock: ${out.userAtPost}`);
    // The first unlock: the bouncer takes the PIN as key input.
    for (let i = 0; i < 5 && (await user()) !== 'RUNNING_UNLOCKED'; i++) {
      await adbShell('input keyevent KEYCODE_WAKEUP');
      await adbShell('wm dismiss-keyguard');
      await sleep(1500);
      await adbShell('input text 1234');
      await adbShell('input keyevent KEYCODE_ENTER');
      await sleep(5000);
    }
    out.userAfterUnlock = await user();
    if (out.userAfterUnlock !== 'RUNNING_UNLOCKED') throw new Error(`the PIN did not unlock: ${out.userAfterUnlock}`);
    await sleep(5000); // BOOT_COMPLETED re-arms: it must not post the reminder again
    out.afterUnlock = Number(await adbShell(`dumpsys notification --noredact | grep -c "${med.name}"`)) || 0;
    out.alarmAfterUnlock = await adbShell('dumpsys alarm | grep -c "Notifications.Fire"');
    out.unlockLog = (await adbShell('logcat -d -s Notifications:*')).split('\n').slice(-3);
    if (out.afterUnlock !== out.notificationLines) throw new Error(`${out.afterUnlock} "${med.name}" notification lines after the unlock, ${out.notificationLines} at the post: posted twice or gone`);
    if (!(Number(out.alarmAfterUnlock) > 0)) throw new Error('no alarm armed for the next reminder');
  } finally {
    await adbShell('locksettings clear --old 1234');
  }
}

/** The adb CLI's stdout, trimmed; '' on failure (device offline mid-reboot, grep -c's exit 1). */
async function adb(args) {
  return new Promise((resolve) => execFile('adb', args, { timeout: 60_000 }, (_e, stdout) => resolve(String(stdout || '').trim())));
}

/** PUT the lock-screen text pref through the page's /api seam (apishim → setDeliveryPref; reschedules at once). */
async function setLockscreen(page, verbosity) {
  const pref = await page.evaluate((v) => window.apiCall('/api/settings/reminder-delivery', 'PUT', { verbosity: v }), verbosity);
  if (pref?.lockscreen !== verbosity) throw new Error(`lock-screen pref ${JSON.stringify(pref)}, wanted ${verbosity}`);
  return pref;
}

/** A daily med at the next whole minute ≥ `lead` ms ahead (device zone), and its row in the shell's store. */
async function addDueMed(ctx, page, out, lead = 90_000) {
  const name = `QA Reminder ${Date.now() % 1_000_000}`;
  const due = await page.evaluate(async ([n, lead]) => {
    const slot = Math.ceil((Date.now() + lead) / 60_000) * 60_000;
    const d = new Date(slot);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    await window.apiCall('/api/medications', 'POST', { name: n, dosage: '5mg', schedule: JSON.stringify({ type: 'daily', times: [hhmm] }) });
    return { slotUnix: slot / 1000, hhmm };
  }, [name, lead]);
  Object.assign(out, { name, ...due });
  // The reminder recompute is debounced (2 s): poll the shell's stored rows for this slot.
  const end = Date.now() + 30_000;
  for (;;) {
    const rows = await ctx.shell(`run-as ${ctx.pkg} cat ${DE_ROWS}`).catch(() => '');
    if (rows.includes(String(due.slotUnix)) && rows.includes('medication_confirm')) break;
    if (Date.now() > end) throw new Error(`no stored row at ${due.slotUnix} (${due.hhmm}): ${rows.slice(0, 300)}`);
    await ctx.sleep(1000);
  }
  out.alarm = (await ctx.shell(`dumpsys alarm | grep -c ${ctx.pkg}`)).trim();
  return out;
}

/** The app's process gone the way the system or a swipe kills it — not force-stop, which drops its alarms. */
async function killApp(ctx) {
  const { shell, pkg, sleep } = ctx;
  await shell('input keyevent KEYCODE_HOME');
  await sleep(2000);
  await shell(`am kill ${pkg}`);
  await sleep(1500);
  const pid = await shell(`pidof ${pkg}`).catch(() => '');
  if (pid) await shell(`kill -9 ${pid}`);
  await sleep(1000);
  if (await shell(`pidof ${pkg}`).catch(() => '')) throw new Error('the app process is still alive');
}

/** The emulator's clock, ms (whole seconds: toybox date): the alarm fires on it, and slotUnix came from it. */
async function deviceMs(shell) {
  const s = Number(await shell('date +%s'));
  if (!s) throw new Error('no device clock from `date +%s`');
  return s * 1000;
}

/**
 * Polls the notification service for `text` until the slot + 3 min; returns its dumpsys line count once
 * posted. `before`: the count before the post (default now — the slot is still ahead, ≥ 90 s at add).
 * bd med-nt9p.61: the deadline and postedLateS run on the device clock (runner + clockOffsetMs), and
 * a slot still > 10 s ahead must have the shell's exact alarm armed, or it fails at once, not at the deadline.
 */
async function waitNotification(ctx, med, text, out, before, lateMin = 3) {
  const count = async () => Number((await ctx.shell(`dumpsys notification --noredact | grep -c "${text}"`).catch(() => '0')) || 0);
  const offset = (out.clockOffsetMs = (await deviceMs(ctx.shell)) - Date.now());
  const now = () => Date.now() + offset;
  if (med.slotUnix * 1000 - now() > 10_000) {
    out.alarmArmed = Number(await ctx.shell('dumpsys alarm | grep -c "Notifications.Fire"').catch(() => '0')) || 0;
    if (!out.alarmArmed) throw new Error(`no alarm armed for ${med.hhmm} (${Math.round(med.slotUnix - now() / 1000)} s ahead on the device clock)`);
  }
  out.notificationsBefore = before ??= await count();
  const end = med.slotUnix * 1000 + lateMin * 60_000;
  for (;;) {
    const n = await count();
    if (n > before) { out.notificationLines = n; break; }
    if (now() > end) throw new Error(`no "${text}" notification by ${med.hhmm} + ${lateMin} min (device clock, offset ${offset} ms)`);
    await ctx.sleep(5000);
  }
  out.postedLateS = Math.round(now() / 1000 - med.slotUnix);
  out.processAtPost = (await ctx.shell(`pidof ${ctx.pkg}`).catch(() => '')) ? 'started by the alarm' : 'none';
}

/**
 * Step 3a (bd med-wi09.7). The take sheet of `med` is open: closed, its dose taken in-app (the TAKEN
 * count goes up by one), then two rows with the page's reminderDeeplink urls, 15 s and 25 s out.
 * Scheduling is replace-all and the account fires no schedule event, so window.LocalNotifications
 * .schedule is wrapped first: every app schedule until they fire (the take's own recompute, a
 * resume, a sync drain) carries them too. Toasts stay up for the shots. Returns the page.
 */
async function staleTaps(ctx, page, med, out) {
  try {
    const prep = await page.evaluate(async ([name, slotUnix]) => {
      window.ModalManager.close('med-confirm-modal');
      const m = (await window.apiCall('/api/medications')).find((x) => x.name === name);
      if (!m) throw new Error(`no med ${name}`);
      const taken = async () => (await window.apiCall('/api/doses')).filter((d) => String(d.medId) === String(m.id) && d.state === 'taken').length;
      const iso = new Date(slotUnix * 1000).toISOString();
      const row = (await window.apiCall(`/api/doses?at=${encodeURIComponent(iso)}`)).find((d) => String(d.medId) === String(m.id));
      if (!row) throw new Error(`no dose of ${name} at ${iso}`);
      const { reminderDeeplink } = await import('/js/reminder-deeplink.js');
      const link = (slot) => reminderDeeplink({ kind: 'medication', medicationIds: [m.id], fireAtUnix: slot, slotUnix: slot });
      const urls = { taken: link(slotUnix), moved: link(slotUnix + 60) };
      const at = Math.floor(Date.now() / 1000);
      const items = [
        { fireAtUnix: at + 15, title: 'Med Tracker', body: 'QA stale taken', url: urls.taken },
        { fireAtUnix: at + 25, title: 'Med Tracker', body: 'QA stale moved', url: urls.moved },
      ];
      const ln = window.LocalNotifications;
      const schedule = (window.__qaSchedule = ln.schedule);
      ln.schedule = (list) => schedule.call(ln, Date.now() / 1000 < at + 25 ? [...(list || []), ...items] : list);
      const sm = window.SyncManager;
      const show = (window.__qaShowToast = sm.showToast);
      sm.showToast = (msg, t, o) => show.call(sm, msg, t, { ...o, duration: 0 });
      // What the shell hands the open page (MainActivity.openPath): the router cleans the url to "/" at once.
      window.__qaTapped = [];
      const route = (window.__qaRoute = window.handleDeepLinks);
      window.handleDeepLinks = () => { window.__qaTapped.push(location.pathname + location.search); return route(); };
      const before = await taken();
      await window.apiCall('/api/doses/act', 'POST', { action: 'take', occ_ids: [row.occId] });
      return { medId: m.id, urls, before, afterTake: await taken(), scheduled: await ln.schedule([]) };
    }, [med.name, med.slotUnix]);
    Object.assign(out, prep);
    if (prep.afterTake !== prep.before + 1) throw new Error(`the in-app take did not add a TAKEN row: ${prep.before} → ${prep.afterTake}`);
    if (prep.scheduled < 2) throw new Error(`the shell scheduled ${prep.scheduled} of the 2 stale rows`);
    // The url the tap reached the page with: the router wrapper's, or — when the shell loaded it into
    // a new document (page not ready) — that document's own load, only if it started after the tap.
    const landing = (tapAt) => page.evaluate((t) => ({
      url: window.__qaTapped?.shift() ??
        (performance.timeOrigin > t ? '/' + new URL(performance.getEntriesByType('navigation')[0].name).search : 'not routed'),
      sheet: !!window.ModalManager?._isVisible('med-confirm-modal'),
      toast: [...document.querySelectorAll('.wg-toast')].map((n) => n.textContent),
      stale: document.querySelector('.wg-timeline__stale')?.offsetParent ? document.querySelector('.wg-timeline__stale').textContent : null,
    }), tapAt);
    const tap = async (body) => {
      await waitNotification(ctx, { slotUnix: (await deviceMs(ctx.shell)) / 1000, hhmm: 'now' }, body, (out[`${body} post`] = {}), 0, 1);
      const tapAt = await page.evaluate(() => Date.now());
      await tapNotification(ctx, new RegExp(`.*${body}.*`), body.replace(/ /g, '-').toLowerCase());
      page = (await ctx.attachPage()) || page;
      return tapAt;
    };

    let tapAt = await tap('QA stale taken');
    await page.waitForFunction((t) => [...document.querySelectorAll('.wg-toast')].some((n) => n.textContent.includes(t)), LOGGED, { timeout: 30_000 });
    await ctx.sleep(3000); // a late sheet or write would show by now
    out.taken = { ...(await landing(tapAt)), count: await page.evaluate((id) => window.apiCall('/api/doses').then((rows) =>
      rows.filter((d) => String(d.medId) === String(id) && d.state === 'taken').length), prep.medId) };
    await ctx.stableShot('stale-taken-toast');
    if (out.taken.url !== prep.urls.taken) throw new Error(`the tap reached the page as ${out.taken.url}, not ${prep.urls.taken}`);
    if (out.taken.sheet) throw new Error('the take sheet opened for a dose already taken');
    if (out.taken.count !== prep.afterTake) throw new Error(`TAKEN rows ${prep.afterTake} → ${out.taken.count} after the stale tap`);

    await page.evaluate(() => document.querySelector('body > .wg-toasts')?.remove()); // the MT6 shot without the toast
    tapAt = await tap('QA stale moved');
    await page.waitForFunction(() => document.querySelector('.wg-timeline__stale')?.offsetParent, null, { timeout: 30_000 });
    out.moved = await landing(tapAt);
    await ctx.stableShot('stale-moved-mt6');
    if (out.moved.url !== prep.urls.moved) throw new Error(`the tap reached the page as ${out.moved.url}, not ${prep.urls.moved}`);
    if (out.moved.sheet) throw new Error('the take sheet opened for a moved slot');
    if (!/is out of date\./.test(out.moved.stale)) throw new Error(`MT6 note reads ${out.moved.stale}`);
    return page;
  } finally {
    // The later steps run on this page: its own schedule, toasts and router again.
    await page.evaluate(() => {
      if (window.__qaSchedule) window.LocalNotifications.schedule = window.__qaSchedule;
      if (window.__qaShowToast) window.SyncManager.showToast = window.__qaShowToast;
      if (window.__qaRoute) window.handleDeepLinks = window.__qaRoute;
    }).catch(() => {});
  }
}

const LOGGED = 'Already logged — nothing left to take for this reminder.'; // web/static/js/app.js handlePushAction

async function tapNotification(ctx, text, label) {
  await ctx.shell('cmd statusbar expand-notifications');
  await ctx.sleep(1500);
  await ctx.waitFor({ text }, 15_000);
  await ctx.shot(`shade-${label}`);
  await ctx.device.tap({ text });
}

/** The take sheet open on this dose: the med-confirm modal visible and naming the med. */
async function waitSheet(page, name, out) {
  await page.waitForFunction(([id, n]) => window.ModalManager?._isVisible(id) && document.getElementById(id).innerText.includes(n), [MODAL, name], { timeout: 60_000 });
  out.sheetUrl = await page.evaluate(() => location.pathname + location.search);
}
