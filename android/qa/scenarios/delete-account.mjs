// bd med-nt9p.32.15: the account's ways out on the Android shell (account.leave, bd med-nt9p.32.13).
// Claim the run's invite → Settings → Account → "Use this phone without an account" → straight into
// local mode → Switch account → open the account again (unlock) → Settings → Account → Delete my
// account (typed confirm + soft authenticator) → the NATIVE first run, the WebView on about:blank and
// the host forgotten (A) → force-stop + plain relaunch → the first run again, no "There is no
// account" screen (B). Claims the run's one invite: dispatch-only (not in `all`), no retry.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimAccount, waitForVault } from './smoke.mjs';

export const retry = false;

const here = dirname(fileURLToPath(import.meta.url));
// The typed-confirm phrase, read from its source so the two never drift.
const PHRASE = /DELETE_CONFIRM_PHRASE = '([^']+)'/.exec(readFileSync(join(here, '../../../web/cloud/js/account-delete.js'), 'utf8'))[1];

const storedHost = async (ctx) => {
  await ctx.sleep(1500); // SharedPreferences.apply() writes asynchronously
  const xml = await ctx.shell(`run-as ${ctx.pkg} cat shared_prefs/shell.xml`);
  return /name="accountHost">([^<]*)</.exec(xml)?.[1] ?? null;
};

/** Settings → Account (the page the user opens). */
async function openAccountPage(page) {
  const row = page.locator('[data-settings-open="account"]');
  // A reopened account restores its last section, Settings included (run 39325392612): no gear then.
  if (!(await row.isVisible())) await page.locator('[data-nav-to="settings"]:visible').first().click();
  await row.waitFor({ state: 'visible', timeout: 15_000 });
  await row.click();
}

/** The account opened from the first run: a warm vault boots straight in; otherwise /unlock's passkey button. */
async function unlock(ctx, page, r) {
  const end = Date.now() + 60_000;
  for (;;) {
    // Navigation between / and /unlock destroys the context mid-evaluate: retry until one answers.
    const state = await page.evaluate(() => (window.MedTrackerCloudReady ? 'boot' : document.getElementById('unlock-button') ? 'button' : null)).catch(() => null);
    if (state === 'boot') { r.unlock ??= 'warm'; break; }
    if (state === 'button') {
      r.unlock = 'passkey';
      await ctx.shot('unlock');
      await page.click('#unlock-button');
      await page.waitForURL((u) => u.pathname === '/', { timeout: 60_000 });
      break;
    }
    if (Date.now() > end) throw new Error(`neither the app nor /unlock (${page.url()})`);
    await ctx.sleep(1000);
  }
  await waitForVault(page);
}

export default async function deleteAccount(ctx) {
  const { shell, pkg, sleep, device, LOCAL_ORIGIN } = ctx;
  const r = (ctx.results.deleteAccount = {});
  // No pm clear: the run's emulator is fresh, and right after one the launcher ANRs over the first run
  // (runs 39326281141, 39327638865).

  let page = await ctx.step('invite opens the signup wizard (soft authenticator)', () => ctx.openClaim({ softAuthn: true }));
  await claimAccount(ctx, page);
  r.accountHost = new URL(page.url()).host;

  // 0. Killed right after sign-in (bd med-nt9p.45): the session cookie is already on disk, so the
  // relaunch reopens the account and unlocks. Chromium's own write is ~30 s late.
  await ctx.step('force-stop right after sign-in → session cookie on disk → relaunch unlocks', async () => {
    await shell(`am force-stop ${pkg}`);
    const jar = await shell(`run-as ${pkg} cat app_webview/Default/Cookies`);
    if (!jar.includes('cloud_session')) throw new Error(`no cloud_session on disk: ${await shell(`run-as ${pkg} ls -R app_webview`)}`);
    await sleep(2000); // the dead process's devtools socket must go before attaching
    await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity --ez qaSoftAuthn true`);
    page = await ctx.attachPage();
    if (!page) throw new Error('no WebView page');
    await page.waitForURL((u) => u.host === r.accountHost, { timeout: 30_000 });
    await unlock(ctx, page, r);
  });

  // 1. Use this phone without an account → local mode, no stop at the first run.
  await ctx.step('Settings → Account shows "Use this phone without an account"', async () => {
    await openAccountPage(page);
    const btn = page.locator('#settings-leave-account-btn');
    await btn.waitFor({ state: 'visible', timeout: 15_000 });
    const text = await btn.textContent();
    if (!/Use this phone without an account/.test(text)) throw new Error(`row reads "${text}"`);
  });
  await ctx.stableShot('leave-row');
  await ctx.step('confirm → local mode', async () => {
    await page.click('#settings-leave-account-btn');
    await page.locator('.mt-confirm-modal__confirm').waitFor({ state: 'visible', timeout: 10_000 });
    await ctx.shot('leave-confirm');
    await page.click('.mt-confirm-modal__confirm');
    await sleep(2000);
    page = await ctx.attachPage();
    if (!page) throw new Error('no WebView page');
    await page.waitForURL((u) => u.href.startsWith(`${LOCAL_ORIGIN}/`), { timeout: 30_000 });
    await ctx.waitLocalReady(page);
  });
  await ctx.stableShot('local-mode');

  // 2. Back to the account: Switch account → first run → Open the account address → unlock.
  await ctx.step('Switch account → first run', () => ctx.launch({ softAuthn: true }));
  await ctx.shot('first-run');
  await ctx.step('open the account again → unlocked', async () => {
    await ctx.openLink(`https://${r.accountHost}/`);
    page = await ctx.attachPage();
    if (!page) throw new Error('no WebView page');
    await page.waitForURL((u) => u.host === r.accountHost, { timeout: 30_000 });
    await unlock(ctx, page, r);
  });
  await ctx.stableShot('account-again');

  // 3. Delete my account → the native first run (A).
  await ctx.step('Settings → Account → Delete → typed confirm', async () => {
    await openAccountPage(page);
    await page.locator('#delete-account-open').scrollIntoViewIfNeeded();
    await ctx.stableShot('delete-section');
    await page.click('#delete-account-open');
    await page.locator('.mt-confirm-modal__input').waitFor({ state: 'visible', timeout: 15_000 });
    await page.fill('.mt-confirm-modal__input', PHRASE);
    await ctx.shot('delete-confirm');
    await page.click('.mt-confirm-modal__confirm');
  });
  await ctx.step('deleted → the native first run (A)', async () => {
    await ctx.waitFor({ text: 'Only on this device' }, 60_000);
    await ctx.waitFor({ text: 'Continue' }, 5_000);
    r.urlAfterDelete = await page.evaluate(() => location.href).catch(async () => (await ctx.attachPage())?.url());
    if (r.urlAfterDelete !== 'about:blank') throw new Error(`WebView on ${r.urlAfterDelete}, want about:blank`);
    const h = await storedHost(ctx);
    if (h !== null) throw new Error(`accountHost still stored: ${h}`);
  });
  await ctx.shot('after-delete');

  // 4. A cold relaunch stays on the first run (B).
  await ctx.step('force-stop + relaunch → first run, no error screen (B)', async () => {
    await shell(`am force-stop ${pkg}`);
    await sleep(2000);
    await shell(`am start -W -n ${pkg}/com.example.medtracker.MainActivity`);
    await ctx.waitFor({ text: 'Only on this device' }, 30_000);
    await ctx.waitFor({ text: 'Continue' }, 5_000);
    for (const text of [/There is no account.*/, 'Copy diagnostics', 'Try again']) {
      if (await device.wait({ text }, { timeout: 1_500 }).then(() => true, () => false)) throw new Error(`showing ${text}`);
    }
  });
  await ctx.shot('relaunch');
}
