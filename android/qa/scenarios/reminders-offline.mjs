// Reminders and offline on the emulator (bd med-nt9p.55), so the phone keeps only what an emulator
// cannot show (real-OEM doze, reboot, Google Password Manager, Play referrer, Health Connect data):
// 1. Settings → Notifications → Enable walks both system grants through UiAutomator (the
//    POST_NOTIFICATIONS prompt, then Alarms & reminders) → 'granted'.
// 2. A med due in ~2 min → the app process killed → the notification is posted anyway.
// 3. Its tap opens that dose's take sheet (bd med-nt9p.52: row url → ReminderPath → handleDeepLinks).
// 4. Offline cold start: airplane mode, force-stop, relaunch → the account renders from the SW.
// 5. (2)-(3) again in local mode with the app lock on (a throwaway PIN): the tap asks for the PIN
//    first and the sheet opens after the unlock. The lock is local mode only (LocalLock.holds).
// In `all` it runs after smoke and reopens smoke's account; dispatched alone it claims the invite.
// "Killed" is HOME + am kill (+ kill -9), not am force-stop: Android drops a force-stopped app's alarms.
// results.reminders = { permission: 'ui' | 'pm-grant/appops fallback: …', … } in qa-summary.json.
import { claimAccount, waitForVault } from './smoke.mjs';

const PIN = '1111';
const MODAL = 'med-confirm-modal';

export default async function remindersOffline(ctx) {
  const { shell, pkg, sleep } = ctx;
  const r = (ctx.results.reminders ||= {}); // a retry adds to the first attempt's findings
  r.attempts = (r.attempts || 0) + 1;
  await shell('svc power stayon true'); // no screen-off keyguard over the shade while a PIN is set
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

    const loc = (r.locked = {});
    await shell(`locksettings clear --old ${PIN}`).catch(() => {}); // a retry's leftover
    try {
      page = await ctx.step('local mode: a screen-lock PIN and the app lock on', async () => {
        loc.setPin = await shell(`locksettings set-pin ${PIN}`);
        const p = await ctx.launchLocal('today');
        await p.evaluate(() => {
          window.__qaLock = window.LocalNotifications.__native.call('lock.set', { on: true }).then((v) => ({ v }), (e) => ({ e: String(e?.message || e) }));
        });
        await enterPin(ctx, 'lock-on-pin');
        loc.lockSet = await p.evaluate(() => window.__qaLock);
        loc.status = await p.evaluate(() => window.LocalNotifications.__native.call('lock.status'));
        if (!loc.status?.on) throw new Error(`lock not on: ${JSON.stringify(loc)}`);
        return p;
      });
      const med2 = await ctx.step('local: a med due in ~2 min is scheduled on the device', () => addDueMed(ctx, page, loc));
      await ctx.step('local, locked: app killed → the reminder is posted', async () => {
        await killApp(ctx);
        await waitNotification(ctx, med2, 'Medication time', loc);
      });
      await ctx.step('local, locked: the tap asks for the unlock first, then opens the take sheet', async () => {
        await tapNotification(ctx, /.*Medication time.*/, 'local');
        await sleep(6000);
        loc.focusBeforeUnlock = (await shell('dumpsys window | grep mCurrentFocus')).trim();
        await ctx.stableShot('locked-after-tap');
        if (/MainActivity/.test(loc.focusBeforeUnlock)) throw new Error(`no unlock prompt over the app: ${loc.focusBeforeUnlock}`);
        await enterPin(ctx, 'locked-pin');
        page = await ctx.localPage((p) => waitSheet(p, med2.name, loc));
        await ctx.stableShot('local-take-sheet');
      });
    } finally {
      await shell(`locksettings clear --old ${PIN}`).catch(() => {});
      // Without a screen lock the check passes, so the lock goes off with no prompt.
      await ctx.page?.evaluate(() => window.LocalNotifications.__native.call('lock.set', { on: false })).catch(() => {});
    }
  } finally {
    await shell('svc power stayon false');
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

/** A daily med at the next whole minute ≥ 90 s ahead (device zone), and its row in the shell's store. */
async function addDueMed(ctx, page, out) {
  const name = `QA Reminder ${Date.now() % 1_000_000}`;
  const due = await page.evaluate(async (n) => {
    const slot = Math.ceil((Date.now() + 90_000) / 60_000) * 60_000;
    const d = new Date(slot);
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    await window.apiCall('/api/medications', 'POST', { name: n, dosage: '5mg', schedule: JSON.stringify({ type: 'daily', times: [hhmm] }) });
    return { slotUnix: slot / 1000, hhmm };
  }, name);
  Object.assign(out, { name, ...due });
  // The reminder recompute is debounced (2 s): poll the shell's stored rows for this slot.
  const end = Date.now() + 30_000;
  for (;;) {
    const rows = await ctx.shell(`run-as ${ctx.pkg} cat shared_prefs/reminders.xml`).catch(() => '');
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

/** Polls the notification service for `text` until the slot + 3 min. */
async function waitNotification(ctx, med, text, out) {
  const count = async () => Number((await ctx.shell(`dumpsys notification --noredact | grep -c "${text}"`).catch(() => '0')) || 0);
  const before = (out.notificationsBefore = await count()); // the slot is still ahead (≥ 90 s at add)
  const end = med.slotUnix * 1000 + 180_000;
  for (;;) {
    const n = await count();
    if (n > before) break;
    if (Date.now() > end) throw new Error(`no "${text}" notification by ${med.hhmm} + 3 min`);
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

/** The system credential screen (BiometricPrompt with the screen-lock fallback): the PIN and Enter. */
async function enterPin(ctx, shotName) {
  await ctx.sleep(4000);
  await ctx.shot(shotName);
  await ctx.shell(`input text ${PIN}`);
  await ctx.shell('input keyevent KEYCODE_ENTER');
  await ctx.sleep(3000);
}
