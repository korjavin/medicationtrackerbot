// testscenarios/common/notifications-no-ask-at-launch.yaml (bd med-88x0.9): opening the app never
// asks for notification permission by itself. With POST_NOTIFICATIONS never granted (no pm grant,
// reminders-offline's revoke + flag reset), neither the in-context ask sheet ("Let Med Tracker
// remind you", features/notify-permission.js) nor the permissioncontroller dialog shows:
// 1. on a local cold open of the golden vault;
// 2. on an account cold open + unlock whose vault has a plan exercise without exercise_library_id
//    (the med-cabs trigger: the boot backfill wrote through a UI-origin route and asked at launch).
// Then the user's own write (a med with a time, through the editor) opens the ask sheet, and the
// system dialog shows only after its Allow (med-ckm5.4).
// Claims the run's invite: dispatch alone, never in `all`.
import { claimAccount, waitForVault } from './smoke.mjs';

export const retry = false;

const SHEET = 'notify-permission-sheet';
const SYSTEM = 'com.android.permissioncontroller';

export default async function notificationsNoAsk(ctx) {
  const { shell, pkg, sleep } = ctx;
  const r = (ctx.results.notifyNoAsk = {});
  // Notifications never decided on this device: pm clear drops the shell's ASKED pref and the web's
  // asked flag; the revoke + flag reset undoes any grant an earlier scenario left (reminders-offline).
  const reset = async () => {
    await shell(`pm clear ${pkg}`);
    await shell(`pm revoke ${pkg} android.permission.POST_NOTIFICATIONS`).catch(() => {});
    await shell(`pm clear-permission-flags ${pkg} android.permission.POST_NOTIFICATIONS user-set user-fixed`).catch(() => {});
    await shell(`appops set ${pkg} SCHEDULE_EXACT_ALARM default`);
  };
  /** Is the system permission dialog up? UiAutomator for its package, and the focused window. */
  const systemDialog = async (ms = 1_000) => ({
    ui: await ctx.device.wait({ pkg: SYSTEM }, { timeout: ms }).then(() => true, () => false),
    focus: (await shell('dumpsys window | grep mCurrentFocus').catch(() => '')).includes(SYSTEM),
  });
  const askState = (page) => page.evaluate(async (id) => ({
    sheet: !!document.getElementById(id),
    asked: localStorage.getItem('wg.notifyPermission.asked'),
    permission: await window.LocalNotifications.permission().catch((e) => `error ${e?.message}`),
  }), SHEET);
  /** Nothing asked: no sheet, no system dialog, the permission still undecided. */
  const assertNoAsk = async (page, out) => {
    Object.assign(out, await askState(page), { system: await systemDialog() });
    if (out.sheet) throw new Error('the notification ask sheet is open with no user write');
    if (out.system.ui || out.system.focus) throw new Error(`the system permission dialog is up: ${JSON.stringify(out.system)}`);
    if (out.asked === '1') throw new Error('this device was already asked');
    if (out.permission !== 'default') throw new Error(`permission ${out.permission}, not default: the precondition failed`);
  };

  await reset();
  let page = await ctx.step('local cold open (golden vault): no sheet, no system dialog', async () => {
    const p = await ctx.launchLocal('today');
    await p.locator('.wg-tabbar').first().waitFor({ state: 'visible', timeout: 30_000 });
    await sleep(8000); // past the 2 s reminder recompute debounce and any boot-time write
    await ctx.stableShot('local-cold-open');
    await assertNoAsk(p, (r.local = {}));
    return p;
  });
  const fixture = await page.evaluate(() => window.CloudVault.exportAll({ includeSecrets: false }));

  await reset();
  page = await ctx.step('claim run invite with soft authenticator', () => ctx.openClaim({ softAuthn: true }));
  await claimAccount(ctx, page);
  const acct = (r.account = {});
  await ctx.step('account: import the golden vault, its plan exercise without exercise_library_id', async () => {
    const prepared = await page.evaluate((json) => {
      const v = JSON.parse(json);
      for (const e of v.data.workouts.exercises) delete e.exercise_library_id;
      v.data.settings.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return JSON.stringify(v);
    }, fixture);
    acct.import = await page.evaluate((json) => window.CloudVault.importAll(json), prepared);
    if (acct.import.upload !== 'synced') throw new Error(`golden import not uploaded: ${acct.import.upload}`);
    acct.reflessBefore = await refless(page);
    if (!acct.reflessBefore) throw new Error('the import linked the plan exercise: no ref-less row for the boot backfill');
  });

  await ctx.step('account: cold relaunch + unlock runs the backfill; no sheet, no system dialog', async () => {
    await shell(`am force-stop ${pkg}`);
    await sleep(2000);
    await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity --ez qaSoftAuthn true`);
    page = await ctx.attachPage();
    if (!page) throw new Error('no WebView page after the relaunch');
    await waitForVault(page);
    await page.locator('.wg-tabbar').first().waitFor({ state: 'visible', timeout: 60_000 });
    // The backfill runs once the boot pull lands: the ref-less row gets its library link.
    for (const end = Date.now() + 60_000; (acct.reflessAfter = await refless(page)) && Date.now() < end;) await sleep(2000);
    if (acct.reflessAfter) throw new Error(`the boot backfill did not link the plan exercise (${acct.reflessAfter} ref-less)`);
    await sleep(8000);
    await ctx.stableShot('account-cold-open');
    await assertNoAsk(page, acct);
  });

  await ctx.step('account: add a med with a time → the ask sheet, no system dialog yet', async () => {
    await page.evaluate(() => window.switchTab('meds'));
    await page.evaluate(() => window.showAddModal());
    await page.locator('#med-modal').waitFor({ state: 'visible' });
    await page.fill('#med-name', 'QA No Ask');
    await page.fill('#med-dosage', '5mg');
    await page.locator('[data-schedule-type="daily"]').click();
    if (!(await page.locator('.med-time-input').count())) await page.click('#add-time-btn');
    await page.locator('.med-time-input').first().fill('08:00');
    await page.click('#med-modal-save-btn');
    await page.locator('#med-modal').waitFor({ state: 'hidden' });
    await page.locator(`#${SHEET}`).waitFor({ state: 'visible', timeout: 20_000 });
    await sleep(3000); // a system dialog started alongside the sheet would be up by now
    await ctx.stableShot('ask-sheet');
    acct.afterWrite = { ...(await askState(page)), system: await systemDialog() };
    if (acct.afterWrite.system.ui || acct.afterWrite.system.focus) throw new Error('the system dialog showed before the sheet\'s Allow');
  });

  await ctx.step('account: the sheet\'s Allow → the system dialog', async () => {
    await page.locator(`#${SHEET} [data-notify-choice="allow"]`).click();
    const allow = { res: `${SYSTEM}:id/permission_allow_button` };
    await ctx.waitFor(allow, 20_000);
    await ctx.shot('system-dialog');
    await ctx.device.tap(allow);
    // Android's 'granted' also needs Alarms & reminders: the shell opens it next (reminders-offline).
    const alarms = { text: /.*Allow setting alarms and reminders.*/ };
    if (await ctx.waitFor(alarms, 20_000).then(() => true, () => false)) {
      await ctx.device.tap(alarms);
      await sleep(1500);
      await shell('input keyevent KEYCODE_BACK');
    }
    for (const end = Date.now() + 10_000; !(await ctx.inForeground()) && Date.now() < end;) await sleep(500);
    await sleep(2000);
    acct.afterAllow = await askState(page).catch((e) => `error ${e?.message}`);
    await ctx.stableShot('after-allow');
  });
  ctx.log('notifyNoAsk', JSON.stringify(r, null, 2));
}

/** Live plan exercises with a name and no exercise_library_id, read from the vault export. */
async function refless(page) {
  const vault = JSON.parse(await page.evaluate(() => window.CloudVault.exportAll({ includeSecrets: false })));
  return vault.data.workouts.exercises.filter((e) => e.exercise_name && e.exercise_library_id == null).length;
}
