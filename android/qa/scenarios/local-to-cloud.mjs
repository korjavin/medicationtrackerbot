// Local → cloud upgrade path (bd med-nt9p.32.10, docs/android.md → Moving to a cloud account): the
// file-based Move of bd med-o7zq.6 end to end on the shell. Local mode seeded with the golden vault
// → Settings → Backup & import → Export backup → the passphrase sheet (left empty) → Backup ready
// → Save to device (the file Files.kt wrote is read back from the device and checked against
// tests/fixtures/vault-v1.json's shape) → Save to device → local.leave (the op the page's removed
// "I have an invite" called, bd med-ckm5.7) → native first run → the runner's invite, claimed with the soft
// authenticator → the new account's Restore of that file → the account lists the seeded records and
// they reached the server → Switch account → Only on this device → Start → the local records are
// all still there (nothing is erased by a move). results.localToCloud has the counts per vault list.
// Claims the run's one invite: not in `all` (smoke claims it there), no retry.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { claimAccount, waitForVault } from './smoke.mjs';

export const retry = false;

const here = dirname(fileURLToPath(import.meta.url));
// The restore's typed-confirm word, read from its source so the two never drift.
const REPLACE_PHRASE = /REPLACE_PHRASE = '([^']+)'/.exec(readFileSync(join(here, '../../../web/static/js/features/settings/importexport.js'), 'utf8'))[1];
// The lists a move must carry over (records the user made): the target holds at least as many as
// the local store. Not equal: a view lazily materializes derived slots (run 39272557051: the
// account's Today minted today's planned workout session-<group>-<date>, workouts.sessions 1 → 2).
// Everything else is counted and reported (accountDiff), not gated.
export const GATED = ['medications.items', 'medications.intakes', 'bp.readings', 'weight.logs', 'food.logs', 'diary.notes', 'trackers.items', 'trackers.logs', 'workouts.sessions', 'vitals.heart'];

/** Every array in the vault's data, two levels deep: {"bp.readings": 2, "api_tokens": 2, …}. */
export function counts(vault) {
  const out = {};
  for (const [k, v] of Object.entries(vault.data || {})) {
    if (Array.isArray(v)) out[k] = v.length;
    else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) if (Array.isArray(vv)) out[`${k}.${kk}`] = vv.length;
  }
  return out;
}

export const vaultCounts = async (page) => counts(JSON.parse(await page.evaluate(() => window.CloudVault.exportAll({ includeSecrets: false }))));

/** Settings → Backup & import (the page the user opens). */
async function openBackup(page) {
  await page.locator('[data-nav-to="settings"]:visible').first().click();
  await page.locator('[data-settings-open="backup"]').waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('[data-settings-open="backup"]').click();
  await page.locator('#importexport-export-btn').waitFor({ state: 'visible', timeout: 10_000 });
}

/** The in-page dialog's confirm (safeConfirm), typing its phrase first when it asks for one. */
export async function confirmDialog(page, timeout = 10_000) {
  const btn = page.locator('.mt-confirm-modal__confirm');
  await btn.waitFor({ state: 'visible', timeout });
  const typed = page.locator('.mt-confirm-modal__input');
  if (await typed.count()) await typed.fill(REPLACE_PHRASE);
  await btn.click();
}

export default async function localToCloud(ctx) {
  const { shell, pkg, sleep, device, log, LOCAL_ORIGIN } = ctx;
  const r = (ctx.results.localToCloud = {});
  if (!ctx.claimUrl) throw new Error('QA_CLAIM_URL unset (no local cloud)');
  await shell(`pm clear ${pkg}`); // the golden vault exactly
  await shell('rm -f /sdcard/Download/medtracker-vault-*').catch(() => {});

  let page = await ctx.step('local mode, seeded with the golden vault', () => ctx.launchLocal('today', { softAuthn: true }));
  r.local = await vaultCounts(page);
  await ctx.stableShot('local-today');

  // 1. Export, as the user does: no passphrase, API keys included (the plain-text confirm), then
  //    Backup ready → Save to device hands the file to the shell, which opens the system file picker.
  await ctx.step('Backup & import → Export backup → Backup ready → file picker', async () => {
    await openBackup(page);
    await ctx.stableShot('backup-page');
    await page.click('#importexport-export-btn');
    await page.locator('#importexport-export-confirm').waitFor({ state: 'visible', timeout: 10_000 });
    await ctx.shot('export-sheet');
    await page.click('#importexport-export-confirm');
    await confirmDialog(page);
    await page.locator('#importexport-ready-save').waitFor({ state: 'visible', timeout: 120_000 });
    await ctx.shot('backup-ready');
    await page.click('#importexport-ready-save');
    await ctx.waitFor({ text: /^(SAVE|Save)$/ }, 60_000);
  });
  await ctx.shot('export-file-picker');

  // The file Files.offer wrote (cache/downloads/<uuid>/<name>) before the picker, read back intact.
  const file = await ctx.step('the exported file is vault v1 (fixture shape)', async () => {
    const path = await shell(`run-as ${pkg} sh -c 'ls cache/downloads/*/*'`);
    r.exportName = path.slice(path.lastIndexOf('/') + 1);
    if (!/^medtracker-vault-.*\.json\.gz$/.test(r.exportName)) throw new Error(`unexpected export: ${path}`);
    const bytes = Buffer.from(await shell(`run-as ${pkg} base64 -w 0 ${path}`), 'base64');
    r.exportBytes = bytes.length;
    const vault = JSON.parse(gunzipSync(bytes).toString('utf8'));
    const fixture = JSON.parse(readFileSync(join(here, '../../../tests/fixtures/vault-v1.json'), 'utf8'));
    if (vault.format !== fixture.format || vault.version !== fixture.version) throw new Error(`format ${vault.format} v${vault.version}`);
    const missing = Object.keys(fixture.data).filter((k) => !(k in vault.data));
    if (missing.length) throw new Error(`data sections missing vs the fixture: ${missing.join(', ')}`);
    r.exportCounts = counts(vault);
    const off = GATED.filter((k) => r.exportCounts[k] !== r.local[k]);
    if (off.length) throw new Error(`export differs from the store: ${off.map((k) => `${k} ${r.exportCounts[k]}≠${r.local[k]}`).join(', ')}`);
    return { name: r.exportName, b64: bytes.toString('base64') };
  });

  // Save to device: DocumentsUI's create-document screen (Downloads), as a user keeps the file.
  // A finding, not a stopper: the restore below can still take the bytes read above.
  r.savedToDownloads = await ctx.step('Save to device → Downloads', async () => {
    await ctx.waitFor({ text: /^(SAVE|Save)$/ }, 20_000);
    await ctx.shot('documentsui-save');
    await device.tap({ text: /^(SAVE|Save)$/ });
    await sleep(2500);
    const ls = await shell('ls /sdcard/Download/');
    if (!ls.includes(file.name)) throw new Error(`not in Downloads: ${ls}`);
    return true;
  }).catch(async () => {
    await ctx.shot('documentsui-stuck');
    if (!(await ctx.inForeground())) await shell('input keyevent KEYCODE_BACK');
    return false;
  });
  await sleep(1000);
  await ctx.stableShot('export-done');

  // 2. The shell's first run through local.leave, the op the removed "I have an invite" button
  //    called (bd med-ckm5.7; the seamless Move is local-to-cloud-seamless.mjs). The page goes
  //    away right after the reply, hence the catch.
  await ctx.step('local.leave → first run', async () => {
    await page.evaluate(() => window.LocalNotifications.__native.call('local.leave')).catch(() => {});
    await ctx.waitFor({ text: 'Only on this device' }, 20_000);
  });
  await ctx.shot('first-run');

  // 3. The runner's invite, claimed on the account origin.
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
  await claimAccount(ctx, page);
  r.accountHost = new URL(page.url()).host;
  r.accountBefore = await vaultCounts(page);

  // 4. Restore the file in the new account. The real Choose → the system picker → the saved file;
  //    where the picker cannot be driven, the same bytes go into the input as the QA driver's seed does.
  await ctx.step('new account: Backup & import → choose the file', async () => {
    await openBackup(page);
    await page.locator('#importexport-import-btn').scrollIntoViewIfNeeded();
    r.restorePicker = 'system';
    try {
      if (!r.savedToDownloads) throw new Error('no saved file to pick');
      await page.locator('[data-file-input="importexport-import-file"] [data-file-choose]').click();
      await ctx.waitFor({ text: file.name }, 20_000);
      await ctx.shot('picker');
      await device.tap({ text: file.name });
      await page.waitForFunction(() => document.getElementById('importexport-import-file').files.length === 1, null, { timeout: 15_000 });
    } catch (e) {
      r.restorePicker = `injected (${String(e?.message || e).split('\n')[0]})`;
      log('picker:', r.restorePicker);
      await ctx.shot('picker-fallback');
      if (!(await ctx.inForeground())) { await shell('input keyevent KEYCODE_BACK'); await sleep(1500); }
      await page.evaluate(({ name, b64 }) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const input = document.getElementById('importexport-import-file');
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], name, { type: 'application/gzip' }));
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, file);
    }
    await ctx.stableShot('restore-chosen');
  });

  // importAll waits for the snapshot upload (sync.js forceSnapshot); one that did not land shows
  // "Not uploaded yet" before the reload, which fails this step.
  await ctx.step('Replace my data → restored and uploaded → reload', async () => {
    const reloaded = page.waitForEvent('load', { timeout: 180_000 });
    await page.click('#importexport-import-btn');
    // An empty account skips the replace confirm (hasUserContent false); one the wizard filled asks.
    const title = page.locator('.mt-confirm-modal__title');
    r.restoreConfirm = await title.filter({ hasText: 'Replace all your data?' }).waitFor({ timeout: 5_000 }).then(() => true, () => false);
    if (r.restoreConfirm) { await ctx.shot('restore-confirm'); await confirmDialog(page); }
    const notUploaded = title.filter({ hasText: 'Not uploaded yet' }).waitFor({ timeout: 180_000 }).then(() => true, () => false);
    if (await Promise.race([reloaded.then(() => false), notUploaded])) {
      await ctx.shot('not-uploaded');
      throw new Error(`not uploaded: ${await page.locator('.mt-confirm-modal__message').textContent()}`);
    }
    await waitForVault(page);
  });
  await ctx.step('the account lists the seeded records', async () => {
    r.account = await vaultCounts(page);
    r.accountDiff = Object.fromEntries(Object.keys({ ...r.local, ...r.account }).filter((k) => r.local[k] !== r.account[k]).map((k) => [k, [r.local[k], r.account[k]]]));
    const off = GATED.filter((k) => !(r.account[k] >= r.local[k]));
    if (off.length) throw new Error(`account lost records: ${off.map((k) => `${k} ${r.account[k]}≠${r.local[k]}`).join(', ')}`);
    await page.evaluate(() => window.switchTab('meds'));
    await page.locator('.med-tab[data-tab="schedule"]').click();
    await page.locator('#med-list > *').first().waitFor({ timeout: 15_000 });
    await ctx.stableShot('account-meds');
    await page.evaluate(() => window.switchTab('today'));
    await page.locator('#today-content > *').first().waitFor({ timeout: 20_000 });
    await ctx.stableShot('account-today');
  });

  // 5. Back to local mode: the move erased nothing there.
  await ctx.step('Switch account → Only on this device → Start → local records intact', async () => {
    await shell(`am force-stop ${pkg}`);
    await sleep(2000);
    await shell(`am start -W -a com.example.medtracker.SWITCH_ACCOUNT -n ${pkg}/com.example.medtracker.MainActivity`);
    await ctx.waitFor({ text: 'Only on this device' });
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
    r.localAfterDiff = Object.fromEntries(Object.keys({ ...r.local, ...r.localAfter }).filter((k) => r.local[k] !== r.localAfter[k]).map((k) => [k, [r.local[k], r.localAfter[k]]]));
    const off = GATED.filter((k) => !(r.localAfter[k] >= r.local[k]));
    if (off.length) throw new Error(`local lost records: ${off.map((k) => `${k} ${r.localAfter[k]}≠${r.local[k]}`).join(', ')}`);
    await page.evaluate(() => window.switchTab('today'));
    await page.locator('#today-content > *').first().waitFor({ timeout: 20_000 });
    await ctx.stableShot('local-again');
  });
  await shell('rm -f /sdcard/Download/medtracker-vault-*').catch(() => {});
  log('localToCloud', JSON.stringify(r, null, 2));
}
