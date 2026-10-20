// Seamless local → cloud move (bd med-nt9p.32.19, docs/android.md → Moving to a cloud account): the
// user path of bd med-nt9p.32.16-.18 end to end on the shell. Local mode seeded with the golden vault
// → Settings home → Move to a cloud account → Continue → the shell's stash (no_backup/move/vault.json,
// plain vault v1 JSON, checked against tests/fixtures/vault-v1.json) → the native first run with the
// hint → Only on this device shows the intro's pending-move note → Back keeps the stash → the
// runner's invite, claimed with the soft authenticator → the account picks the stash up by itself
// (no Backup & import): the toast, the seeded records, the stash gone → Switch account → Only on
// this device → Start → the local records are all still there. results.localToCloudSeamless has
// the counts. Claims the run's one invite: not in `all` (smoke claims it there), no retry.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimAccount, waitForVault } from './smoke.mjs';
import { GATED, counts, vaultCounts, confirmDialog } from './local-to-cloud.mjs';

export const retry = false;

const here = dirname(fileURLToPath(import.meta.url));
const HINT = /^Your records are ready to move\. Paste or scan the invite for your new account\..*/;
const NOTE = /^A move to a cloud account is waiting\. Start here cancels it\..*/;
const TOAST = 'Your records from this phone are in your account.';
const WAIT = 240_000; // claim + import + snapshot upload + reload on the software-GPU emulator

const lost = (from, to) => GATED.filter((k) => !(to[k] >= from[k]));
const diff = (a, b) => Object.fromEntries(Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]).map((k) => [k, [a[k], b[k]]]));

export default async function localToCloudSeamless(ctx) {
  const { shell, pkg, sleep, device, log, LOCAL_ORIGIN } = ctx;
  const r = (ctx.results.localToCloudSeamless = {});
  if (!ctx.claimUrl) throw new Error('QA_CLAIM_URL unset (no local cloud)');
  const stashFiles = () => shell(`run-as ${pkg} sh -c 'ls no_backup/move 2>/dev/null; true'`);
  await shell(`pm clear ${pkg}`); // the golden vault exactly

  let page = await ctx.step('local mode, seeded with the golden vault', () => ctx.launchLocal('today', { softAuthn: true }));
  r.local = await vaultCounts(page);
  await ctx.stableShot('local-today');

  // 1. Settings home → Move to a cloud account (shown only when the shell lists move.stash).
  await ctx.step('Settings → Move to a cloud account → Continue → first run with the hint', async () => {
    await page.locator('[data-nav-to="settings"]:visible').first().click();
    const row = page.locator('#settings-local-move-btn');
    await row.waitFor({ state: 'visible', timeout: 15_000 });
    await row.scrollIntoViewIfNeeded();
    await ctx.stableShot('settings-move-row');
    await row.click();
    await page.locator('.mt-confirm-modal__confirm').waitFor({ state: 'visible', timeout: 10_000 });
    await ctx.shot('move-confirm');
    await page.click('.mt-confirm-modal__confirm');
    await ctx.waitFor({ text: HINT }, 60_000);
  });
  await ctx.shot('first-run-hint');

  await ctx.step('the stash is plain vault v1 JSON (fixture shape, counts = store)', async () => {
    if ((await stashFiles()) !== 'vault.json') throw new Error(`stash files: ${await stashFiles()}`);
    const vault = JSON.parse(await shell(`run-as ${pkg} cat no_backup/move/vault.json`));
    const fixture = JSON.parse(readFileSync(join(here, '../../../tests/fixtures/vault-v1.json'), 'utf8'));
    if (vault.format !== fixture.format || vault.version !== fixture.version) throw new Error(`format ${vault.format} v${vault.version}`);
    const missing = Object.keys(fixture.data).filter((k) => !(k in vault.data));
    if (missing.length) throw new Error(`data sections missing vs the fixture: ${missing.join(', ')}`);
    r.stashCounts = counts(vault);
    const off = GATED.filter((k) => r.stashCounts[k] !== r.local[k]);
    if (off.length) throw new Error(`stash differs from the store: ${off.map((k) => `${k} ${r.stashCounts[k]}≠${r.local[k]}`).join(', ')}`);
  });

  // 2. Parity with iOS hiding Continue on this iPhone: the intro warns that Start drops the move; Back keeps it.
  await ctx.step('Only on this device: the intro notes the pending move; Back keeps the stash', async () => {
    await device.tap({ text: 'Only on this device' });
    await ctx.waitFor({ text: NOTE }, 20_000);
    await ctx.shot('intro-pending-move');
    await device.tap({ text: 'Back' });
    await ctx.waitFor({ text: HINT }, 20_000);
    if ((await stashFiles()) !== 'vault.json') throw new Error('Back dropped the stash');
  });

  // 3. The runner's invite, claimed on the account origin; the post-unlock boot picks the stash up.
  page = await ctx.step('open the invite → signup wizard', async () => {
    await ctx.openLink(ctx.claimUrl);
    const p = await ctx.attachPage();
    if (!p) throw new Error('no WebView page (see the run log)');
    await p.waitForURL(/\/unlock/, { timeout: 30_000 });
    await p.locator('#create-passkey').waitFor({ timeout: 30_000 });
    await sleep(3000);
    return p;
  });
  await ctx.shot('wizard');
  // Watched from before the claim: the pickup may finish while claimAccount still runs. A locator
  // wait survives the pickup's reload. Losers resolve null, never reject (no unhandled rejection).
  const title = page.locator('.mt-confirm-modal__title');
  const seen = (loc, v) => loc.waitFor({ state: 'visible', timeout: WAIT }).then(() => v, () => null);
  const toast = seen(page.getByText(TOAST), 'toast');
  const outcome = () => Promise.race([
    toast,
    seen(title.filter({ hasText: 'Not uploaded yet' }), 'not-uploaded'),
    seen(title.filter({ hasText: /^Records not moved/ }), 'not-moved'),
  ]);
  const confirm = seen(title.filter({ hasText: 'Replace all your data?' }), 'confirm');
  await claimAccount(ctx, page);
  r.accountHost = new URL(page.url()).host;

  await ctx.step('the account picks the records up by itself: the toast, no Backup & import', async () => {
    let got = await Promise.race([outcome(), confirm]);
    // An empty account skips the replace confirm; one with content (the wizard) asks, typed.
    r.pickupConfirm = got === 'confirm';
    if (r.pickupConfirm) { await ctx.shot('pickup-confirm'); await confirmDialog(page); got = await outcome(); }
    r.pickup = got;
    if (got !== 'toast') {
      await ctx.shot(`pickup-${got}`);
      const msg = await page.locator('.mt-confirm-modal__message').textContent().catch(() => '');
      throw new Error(`pickup: ${got || 'timed out'} ${msg || ''}`);
    }
    await ctx.shot('pickup-toast');
  });
  await ctx.step('the stash is gone; the account lists the seeded records', async () => {
    if ((await stashFiles()) !== '') throw new Error(`stash left after the pickup: ${await stashFiles()}`);
    await waitForVault(page);
    r.account = await vaultCounts(page);
    r.accountDiff = diff(r.local, r.account);
    const off = lost(r.local, r.account);
    if (off.length) throw new Error(`account lost records: ${off.map((k) => `${k} ${r.account[k]}≠${r.local[k]}`).join(', ')}`);
    await page.evaluate(() => window.switchTab('meds'));
    await page.locator('.med-tab[data-tab="schedule"]').click();
    await page.locator('#med-list > *').first().waitFor({ timeout: 15_000 });
    await ctx.stableShot('account-meds');
    await page.evaluate(() => window.switchTab('today'));
    await page.locator('#today-content > *').first().waitFor({ timeout: 20_000 });
    await ctx.stableShot('account-today');
  });

  // 4. Back to local mode: the move erased nothing there.
  await ctx.step('Switch account → Only on this device → Start → local records intact', async () => {
    await shell(`am force-stop ${pkg}`);
    await sleep(2000);
    await shell(`am start -W -a com.example.medtracker.SWITCH_ACCOUNT -n ${pkg}/com.example.medtracker.MainActivity`);
    await ctx.waitFor({ text: 'Only on this device' });
    const hint = await device.wait({ text: HINT }, { timeout: 1_000 }).then(() => true, () => false);
    if (hint) throw new Error('the hint outlived the stash');
    await ctx.shot('switch-first-run');
    await device.tap({ text: 'Only on this device' });
    await ctx.waitFor({ text: 'Start' });
    await ctx.shot('intro');
    await device.tap({ text: 'Start' });
    page = await ctx.attachPage();
    if (!page) throw new Error('no WebView page');
    await page.waitForURL((u) => u.href.startsWith(`${LOCAL_ORIGIN}/`), { timeout: 30_000 });
    await ctx.waitLocalReady(page);
    await page.waitForFunction(() => window.MedTrackerCloudReady, null, { timeout: 60_000 });
    await page.evaluate(() => window.MedTrackerCloudReady);
    r.localAfter = await vaultCounts(page);
    r.localAfterDiff = diff(r.local, r.localAfter);
    const off = lost(r.local, r.localAfter);
    if (off.length) throw new Error(`local lost records: ${off.map((k) => `${k} ${r.localAfter[k]}≠${r.local[k]}`).join(', ')}`);
    await page.evaluate(() => window.switchTab('today'));
    await page.locator('#today-content > *').first().waitFor({ timeout: 20_000 });
    await ctx.stableShot('local-again');
  });
  log('localToCloudSeamless', JSON.stringify(r, null, 2));
}
