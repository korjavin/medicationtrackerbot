// Seamless local → cloud move (bd med-nt9p.32.19, P3 bd med-ta2n.7; docs/android.md → Moving to a
// cloud account): the invite user path end to end on the shell. Local mode seeded with the golden
// vault → the runner's invite arrives as medtracker://i/<sub>#<tok> on the open page → the shell
// reloads home?invite=1 → the web's "Turn on sync?" sheet with the live record count → Turn on sync
// → the shell's stash (no_backup/move/vault.json, plain vault v1 JSON, checked against
// tests/fixtures/vault-v1.json) + local.leave {url} → the claim page, claimed with the soft
// authenticator → the account picks the stash up by itself (no Backup & import): "Sync is on · N
// records are on your account", the seeded records, the stash gone → Switch account → local mode
// (F1, bd med-ta2n.12) → the local records are all still there. results.localToCloudSeamless has the
// counts. Claims the run's one invite: not in `all` (smoke claims it there), no retry.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimAccount, waitForVault } from './smoke.mjs';
import { GATED, counts, vaultCounts, confirmDialog } from './local-to-cloud.mjs';

export const retry = false;

const here = dirname(fileURLToPath(import.meta.url));
const TOAST = /^Sync is on · \d+ records? (is|are) on your account$/;
const WAIT = 240_000; // claim + import + snapshot upload + reload on the software-GPU emulator

const lost = (from, to) => GATED.filter((k) => !(to[k] >= from[k]));
const diff = (a, b) => Object.fromEntries(Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]).map((k) => [k, [a[k], b[k]]]));

export default async function localToCloudSeamless(ctx) {
  const { shell, pkg, sleep, log, LOCAL_ORIGIN } = ctx;
  const r = (ctx.results.localToCloudSeamless = {});
  if (!ctx.claimUrl) throw new Error('QA_CLAIM_URL unset (no local cloud)');
  const stashFiles = () => shell(`run-as ${pkg} sh -c 'ls no_backup/move 2>/dev/null; true'`);
  await shell(`pm clear ${pkg}`); // the golden vault exactly

  let page = await ctx.step('local mode, seeded with the golden vault', () => ctx.launchLocal('today', { softAuthn: true }));
  await ctx.step('choose EU register in local Settings', async () => {
    await page.locator('[data-nav-to="settings"]:visible').first().click();
    await page.locator('[data-settings-open="features"]:visible').click();
    await page.locator('#med-register-choose').click();
    await page.locator('.mt-confirm-modal__choice').filter({ hasText: 'EU register' }).click();
    await page.waitForFunction(() => document.getElementById('med-register-value')?.textContent.trim() === 'EU register');
    await ctx.stableShot('local-eu-register');
  });
  r.local = await vaultCounts(page);
  await ctx.stableShot('local-today');

  // 1. The invite reaches the open local page (warm delivery, contract med-ta2n.7 §6): the shell
  //    stores the slot and reloads home?invite=1; the web's boot read routes it to P3.
  const claim = new URL(ctx.claimUrl);
  const sub = claim.host.split('.')[0];
  const tok = /claim=([0-9a-f]+)/.exec(claim.hash)[1];
  await ctx.step('medtracker:// invite → home?invite=1 → "Turn on sync?" with the record count', async () => {
    await shell(`am start -W -a android.intent.action.VIEW -d 'medtracker://i/${sub}#${tok}'`);
    await sleep(2000);
    page = await ctx.attachPage();
    if (!page) throw new Error('no WebView page');
    await page.waitForURL((u) => u.href.startsWith(`${LOCAL_ORIGIN}/`), { timeout: 30_000 });
    await ctx.waitLocalReady(page);
    const sheet = page.locator('#invite-sync-sheet');
    await sheet.waitFor({ state: 'visible', timeout: 30_000 });
    r.p3Text = await sheet.textContent();
    if (!/Your \d+ records? moves? to your account/.test(r.p3Text)) throw new Error(`P3 copy: ${r.p3Text}`);
    if (!/Sign in with your fingerprint/.test(r.p3Text)) throw new Error(`P3 platform words: ${r.p3Text}`);
    await ctx.stableShot('p3-turn-on-sync');
  });

  // 2. Turn on sync: move.stash + local.leave {url}; the shell opens the claim page (the stash is
  //    kept for the account, A1).
  page = await ctx.step('Turn on sync → the claim page (signup wizard)', async () => {
    await page.click('#invite-sync-sheet [data-invite-action="turn-on-sync"]');
    await sleep(2000);
    const p = await ctx.attachPage();
    if (!p) throw new Error('no WebView page (see the run log)');
    await p.waitForURL(/\/unlock/, { timeout: 60_000 });
    await p.locator('#create-passkey').waitFor({ timeout: 30_000 });
    await sleep(3000);
    return p;
  });
  await ctx.shot('wizard');

  await ctx.step('the stash is plain vault v1 JSON (fixture shape, counts = store)', async () => {
    if ((await stashFiles()) !== 'vault.json') throw new Error(`stash files: ${await stashFiles()}`);
    const vault = JSON.parse(await shell(`run-as ${pkg} cat no_backup/move/vault.json`));
    const fixture = JSON.parse(readFileSync(join(here, '../../../tests/fixtures/vault-v1.json'), 'utf8'));
    if (vault.format !== fixture.format || vault.version !== fixture.version) throw new Error(`format ${vault.format} v${vault.version}`);
    // protection: the move stash carries none by design (local-policy.js moveToCloud), so the
    // account keeps no backup claim.
    const missing = Object.keys(fixture.data).filter((k) => k !== 'protection' && !(k in vault.data));
    if ('protection' in vault.data) throw new Error('the move stash carries data.protection');
    if (missing.length) throw new Error(`data sections missing vs the fixture: ${missing.join(', ')}`);
    r.stashCounts = counts(vault);
    const off = GATED.filter((k) => r.stashCounts[k] !== r.local[k]);
    if (off.length) throw new Error(`stash differs from the store: ${off.map((k) => `${k} ${r.stashCounts[k]}≠${r.local[k]}`).join(', ')}`);
  });

  // 3. Claimed on the account origin; the post-unlock boot picks the stash up.
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

  await ctx.step('the moved EU choice survives and the first medication save sends no name to RxNav', async () => {
    if (!process.env.QA_RECEIPTS) throw new Error('QA_RECEIPTS unset');
    const receipts = () => readFileSync(process.env.QA_RECEIPTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    await page.locator('[data-nav-to="settings"]:visible').first().click();
    await page.locator('[data-settings-open="features"]:visible').click();
    r.movedRegister = (await page.locator('#med-register-value').textContent()).trim();
    if (r.movedRegister !== 'EU register') throw new Error(`moved register: ${r.movedRegister}`);
    await ctx.stableShot('account-eu-register');
    const before = receipts().length;
    const network = [];
    page.on('request', (q) => {
      let payload = `${q.url()}\n${q.postData() || ''}`;
      try { payload = decodeURIComponent(payload); } catch { /* inspect raw */ }
      if (/rxnav\.nlm\.nih\.gov|\/api\/rxnav\/|candecor/i.test(payload)) network.push({ method: q.method(), url: q.url() });
    });
    await page.evaluate(() => { window.switchTab('meds'); window.showAddModal(); });
    await page.locator('#med-modal').waitFor({ state: 'visible' });
    await page.fill('#med-name', 'Candecor');
    await page.locator('#med-name').dispatchEvent('change');
    await page.fill('#med-dosage', '5mg');
    await page.locator('[data-schedule-type="daily"]').click();
    await page.locator('.med-time-input').first().fill('09:00');
    await page.locator('#med-modal-save-btn').click();
    await page.locator('#med-modal').waitFor({ state: 'hidden', timeout: 30_000 });
    const meds = await page.evaluate(() => window.apiCall('/api/medications'));
    if (!meds.some((m) => m.name === 'Candecor')) throw new Error('first medication was not saved');
    await sleep(3000);
    r.registerEgress = { network, rxNavReceipts: receipts().slice(before).filter((x) => /rxnav/i.test(x.path)) };
    if (network.length || r.registerEgress.rxNavReceipts.length) throw new Error(`EU egress: ${JSON.stringify(r.registerEgress)}`);
    await ctx.stableShot('account-first-eu-medication');
  });

  // 4. Back to local mode: the move erased nothing there.
  await ctx.step('Switch account → local mode (F1) → local records intact', async () => {
    page = await ctx.launch({ softAuthn: true }); // Switch account lands in local mode with F1 open
    await ctx.shot('switch-f1');
    await page.locator('[data-invite-action="not-now"]').click();
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

  // The first move populated this real account; revisit it by address with the
  // original passkey rather than attempting to claim the spent invite again.
  await ctx.step('move to the populated account and cancel without changing its records', async () => {
    await ctx.openLink(`https://${r.accountHost}/`, { move: true });
    page = await ctx.attachPage();
    if (!page) throw new Error('no account WebView after returning to account');
    await page.waitForURL((u) => u.host === r.accountHost, { timeout: 60_000 });
    const unlock = page.locator('#unlock-button');
    if (await unlock.isVisible().catch(() => false)) await unlock.click();
    const choice = page.locator('.mt-confirm-modal').filter({ has: page.locator('.mt-confirm-modal__title').filter({ hasText: 'Records already in your account' }) });
    await choice.waitFor({ state: 'visible', timeout: WAIT });
    for (const label of ['Merge', 'Replace']) {
      if (!(await choice.locator('.mt-confirm-modal__choice').filter({ hasText: label }).count())) throw new Error(`missing ${label} choice`);
    }
    r.receiverBefore = await vaultCounts(page);
    await ctx.stableShot('populated-account-choice');
    await choice.locator('.mt-confirm-modal__cancel').click();
    await choice.waitFor({ state: 'hidden' });
    r.receiverAfterCancel = await vaultCounts(page);
    if (Object.keys(diff(r.receiverBefore, r.receiverAfterCancel)).length) throw new Error('cancel changed account counts');
    if ((await stashFiles()) !== 'vault.json') throw new Error('cancel lost the move stash');
  });

  await ctx.step('Replace requires the exact typed confirmation; cancelling keeps the account', async () => {
    await page.reload({ waitUntil: 'load', timeout: 60_000 });
    const choice = page.locator('.mt-confirm-modal').filter({ has: page.locator('.mt-confirm-modal__title').filter({ hasText: 'Records already in your account' }) });
    await choice.waitFor({ state: 'visible', timeout: WAIT });
    await choice.locator('.mt-confirm-modal__choice').filter({ hasText: 'Replace' }).click();
    await choice.locator('.mt-confirm-modal__confirm').click();
    const confirm = page.locator('.mt-confirm-modal').filter({ has: page.locator('.mt-confirm-modal__title').filter({ hasText: 'Replace the records in your account?' }) });
    await confirm.waitFor({ state: 'visible', timeout: 10_000 });
    const button = confirm.locator('.mt-confirm-modal__confirm');
    const input = confirm.locator('.mt-confirm-modal__input');
    if (await button.isEnabled()) throw new Error('Replace enabled before typing');
    await input.fill('replace');
    if (await button.isEnabled()) throw new Error('Replace accepted incorrect phrase');
    await input.fill('REPLACE');
    if (!(await button.isEnabled())) throw new Error('Replace did not accept REPLACE');
    await ctx.stableShot('replace-typed');
    await confirm.locator('.mt-confirm-modal__cancel').click();
    if (Object.keys(diff(r.receiverBefore, await vaultCounts(page))).length) throw new Error('cancelled Replace changed account counts');
    if ((await stashFiles()) !== 'vault.json') throw new Error('cancelled Replace lost the move stash');
  });

  await ctx.step('retry the retained move using Merge', async () => {
    await page.reload({ waitUntil: 'load', timeout: 60_000 });
    const choice = page.locator('.mt-confirm-modal').filter({ has: page.locator('.mt-confirm-modal__title').filter({ hasText: 'Records already in your account' }) });
    await choice.waitFor({ state: 'visible', timeout: WAIT });
    await choice.locator('.mt-confirm-modal__choice').filter({ hasText: 'Merge' }).click();
    await choice.locator('.mt-confirm-modal__confirm').click();
    await page.getByText(TOAST).waitFor({ state: 'visible', timeout: WAIT });
    await waitForVault(page);
    r.merged = await vaultCounts(page);
    if (lost(r.receiverBefore, r.merged).length || lost(r.local, r.merged).length) throw new Error('Merge lost account or local records');
    if ((await stashFiles()) !== '') throw new Error('successful Merge left the move stash');
    await ctx.stableShot('populated-account-merged');
  });
  log('localToCloudSeamless', JSON.stringify(r, null, 2));
}
