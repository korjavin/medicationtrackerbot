// Reminders and offline on the emulator (bd med-nt9p.55), so the phone keeps only what an emulator
// cannot show (real-OEM doze, Google Password Manager, Play referrer, Health Connect data):
// 1. Settings → Notifications → Enable walks both system grants through UiAutomator (the
//    POST_NOTIFICATIONS prompt, then Alarms & reminders) → 'granted'.
// 2. A med due in ~2 min → the app process killed → the notification is posted anyway.
// 3. Its tap opens that dose's take sheet (bd med-nt9p.52: row url → ReminderPath → handleDeepLinks).
//    bd med-5vy0.3: the lock-screen text pref is set to Detailed first (the default depends on the
//    account's history since med-5vy0.1), so this one names the medication.
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
      r.permission = await grantBoth(ctx, r);
      try {
        await page.waitForFunction(() => document.getElementById('cloud-push-toggle').dataset.subscribed === '1', null, { timeout: 60_000 });
      } finally {
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
async function grantBoth(ctx, out) {
  const { shell, pkg, device } = ctx;
  const seen = async (sel, ms) => device.wait(sel, { timeout: ms }).then(() => true, () => false);
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
    await shell('input keyevent KEYCODE_BACK');
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

/**
 * Polls the notification service for `text` until the slot + 3 min; returns its dumpsys line count once
 * posted. `before`: the count before the post (default now — the slot is still ahead, ≥ 90 s at add).
 */
async function waitNotification(ctx, med, text, out, before, lateMin = 3) {
  const count = async () => Number((await ctx.shell(`dumpsys notification --noredact | grep -c "${text}"`).catch(() => '0')) || 0);
  out.notificationsBefore = before ??= await count();
  const end = med.slotUnix * 1000 + lateMin * 60_000;
  for (;;) {
    const n = await count();
    if (n > before) { out.notificationLines = n; break; }
    if (Date.now() > end) throw new Error(`no "${text}" notification by ${med.hhmm} + ${lateMin} min`);
    await ctx.sleep(5000);
  }
  out.postedLateS = Math.round(Date.now() / 1000 - med.slotUnix);
  out.processAtPost = (await ctx.shell(`pidof ${ctx.pkg}`).catch(() => '')) ? 'started by the alarm' : 'none';
}

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
