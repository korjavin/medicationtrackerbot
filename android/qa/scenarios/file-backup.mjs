// B3: the SAME document saved by ACTION_CREATE_DOCUMENT is restored by ACTION_GET_CONTENT.
// No File/DataTransfer fallback: missing native Save/picker legs fail this scenario.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { counts } from './local-to-cloud.mjs';

export const retry = false;
const fixture = JSON.parse(readFileSync(new URL('../../../tests/fixtures/vault-v1.json', import.meta.url)));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const snapshot = async (page) => JSON.parse(await page.evaluate(async () => {
  await window.MedTrackerCloudReady;
  return window.CloudVault.exportAll();
}));

// local-policy.exportAll supplies a NEW backupAt on every call (vault.js recordsToVault).
// Compare every data field, including all IDs/FKs/settings and unknown supported blocks,
// except this one documented per-export stamp. Envelope exported_at is also a clock stamp.
function content(vault) {
  const data = structuredClone(vault.data);
  if (data.protection) data.protection.last_backup_at = '<export time>';
  return { format: vault.format, version: vault.version, data };
}
function equal(actual, expected, where) {
  if (isDeepStrictEqual(content(actual), content(expected))) return;
  const changed = [...new Set([...Object.keys(actual.data), ...Object.keys(expected.data)])]
    .filter((key) => !isDeepStrictEqual(content(actual).data[key], content(expected).data[key]));
  // Never log synthetic integration/token contents either: names and hashes suffice.
  throw new Error(`${where}: semantic differences in ${changed.join(', ')}; hashes ${digest(JSON.stringify(content(actual)))}/${digest(JSON.stringify(content(expected)))}`);
}
async function backup(page) {
  if (await page.locator('#importexport-export-btn').isVisible()) return;
  if (!(await page.locator('[data-settings-open="backup"]:visible').count())) {
    await page.locator('[data-nav-to="settings"]:visible').first().click();
  }
  await page.locator('[data-settings-open="backup"]:visible').click();
  await page.locator('#importexport-export-btn').waitFor({ state: 'visible' });
}

export default async function fileBackup(ctx) {
  const { shell, pkg, device, sleep } = ctx;
  const r = (ctx.results.fileBackup = { picker: 'native only', includeSecrets: 'committed synthetic golden fixture only' });
  await shell(`pm clear ${pkg}`);
  let page = await ctx.step('seed once, then plain local document before baseline/export/erase', async () => {
    const p = await ctx.launchLocal('today');
    await p.goto(`${ctx.LOCAL_ORIGIN}/`, { waitUntil: 'load' });
    await ctx.waitLocalReady(p);
    const scene = await p.evaluate(() => ({ qa: new URL(location.href).searchParams.get('qa'), marker: !!document.getElementById('wg-qa-ready') }));
    if (scene.qa || scene.marker) throw new Error('seed driver still active');
    r.sceneAbsent = scene;
    return p;
  });
  const base = await ctx.step('canonical full fixture baseline after conversion and derived writers settle', async () => {
    await sleep(2500);
    const first = await snapshot(page);
    await sleep(2000);
    const settled = await snapshot(page);
    equal(settled, first, 'baseline did not settle');
    if (settled.format !== fixture.format || settled.version !== fixture.version) throw new Error('canonical baseline is not the committed vault format/version');
    const missing = Object.keys(fixture.data).filter((key) => key !== 'api_tokens' && !(key in settled.data));
    // Legacy vitals.stress is deliberately ignored by vaultToRecords; passthrough gamification
    // and api_tokens ARE supported and compared in full. No timezone/core-only normalization.
    if (missing.length) throw new Error(`missing fixture sections: ${missing}`);
    r.before = counts(settled);
    r.settings = { timezone: settled.data.settings.timezone, history: settled.data.tz.history.length,
      plans: settled.data.tz.transition_plans.length, foodTargets: settled.data.settings.food_targets,
      unit: settled.data.weight.unit_pref, features: settled.data.settings.features };
    if (!r.before['vitals.sleep'] || !r.before['medications.items'] || !r.settings.timezone || !r.settings.history) throw new Error('incomplete full fixture baseline');
    r.semanticBefore = digest(JSON.stringify(content(settled)));
    return settled;
  });
  let saved;
  const corruptName = 'qa-b3-corrupt.json.gz';
  try {
    saved = await ctx.step('Settings export empty passphrase → Backup ready → actual DocumentsUI Save', async () => {
      await backup(page);
      await page.click('#importexport-export-btn');
      await page.locator('#importexport-export-confirm').waitFor({ state: 'visible' });
      if (await page.inputValue('#importexport-export-passphrase')) throw new Error('export passphrase is not empty');
      if (!(await page.isChecked('#importexport-include-secrets'))) throw new Error('full fixture export must include synthetic secrets');
      await page.click('#importexport-export-confirm');
      await page.locator('.mt-confirm-modal__confirm').waitFor({ state: 'visible' });
      await ctx.shot('plaintext-confirm');
      await page.click('.mt-confirm-modal__confirm');
      await page.locator('#importexport-ready-save').waitFor({ state: 'visible', timeout: 120_000 });
      await ctx.shot('backup-ready');
      await page.click('#importexport-ready-save');
      await ctx.waitFor({ text: /^(SAVE|Save)$/ });
      await ctx.shot('native-save');
      const cache = await shell(`run-as ${pkg} sh -c 'ls cache/downloads/*/*'`);
      const name = cache.slice(cache.lastIndexOf('/') + 1);
      if (!/^medtracker-vault-[\w-]+\.json\.gz$/.test(name)) throw new Error('unexpected export filename');
      const temporary = Buffer.from(await shell(`run-as ${pkg} base64 -w 0 ${cache}`), 'base64');
      await device.tap({ text: /^(SAVE|Save)$/ });
      await sleep(2500);
      // This independent provider-backed Downloads path is the proof, not the cache above.
      const path = `/sdcard/Download/${name}`;
      const bytes = Buffer.from(await shell(`base64 -w 0 ${path}`), 'base64');
      if (!bytes.length || digest(bytes) !== digest(temporary)) throw new Error('saved document differs from temporary export');
      const vault = JSON.parse(gunzipSync(bytes).toString('utf8'));
      equal(vault, base, 'saved provider bytes');
      r.saved = { path, name, bytes: bytes.length, sha256: digest(bytes), cacheSha256: digest(temporary), counts: counts(vault),
        backupAt: vault.data.protection.last_backup_at };
      await ctx.shot('saved-return');
      return { name, path, vault };
    });
    await ctx.step('Settings typed ERASE → genuinely empty supported collections/customized settings gone', async () => {
      await page.click('#importexport-local-erase-btn');
      await page.locator('.mt-confirm-modal__input').fill('ERASE');
      await ctx.shot('erase-confirm');
      const loaded = page.waitForEvent('load', { timeout: 60_000 });
      await page.click('.mt-confirm-modal__confirm');
      await loaded;
      await page.waitForURL(`${ctx.LOCAL_ORIGIN}/`, { timeout: 60_000 });
      await ctx.waitLocalReady(page);
      if (new URL(page.url()).searchParams.has('qa')) throw new Error('erase retained seed scene');
      const empty = await snapshot(page);
      r.erased = counts(empty);
      const nonempty = Object.entries(r.erased).filter(([key, n]) => n && key !== 'settings.tab_order');
      if (nonempty.length) throw new Error(`erase retained collections: ${JSON.stringify(nonempty)}`);
      if (isDeepStrictEqual(empty.data.settings.food_targets, base.data.settings.food_targets)) throw new Error('erase retained customized food targets');
      r.customizedSettingsGone = true;
      await ctx.shot('empty-after-erase');
      // The empty app legitimately offers first run. Dismiss through its existing UI.
      const skip = page.locator('[data-firstrun-action="skip-all"]');
      if (await skip.isVisible()) {
        await skip.click();
        // QA's native trial is unsupported, so the picker can finish directly.
        // Supported builds may offer the trial next; either real route ends at the app.
        await page.waitForFunction(() => !document.getElementById('wg-firstrun-overlay') ||
          !!document.querySelector('[data-firstrun-action="not-now"]'), null, { timeout: 15_000 });
        const notNow = page.locator('[data-firstrun-action="not-now"]');
        if (await notNow.isVisible()) await notNow.click();
        await page.locator('#wg-firstrun-overlay').waitFor({ state: 'hidden' });
      }
    });
    const pick = async (name) => {
      await backup(page);
      await page.locator('[data-file-input="importexport-import-file"] [data-file-choose]').click();
      await ctx.waitFor({ text: name }, 30_000);
      await ctx.shot(name === corruptName ? 'corrupt-picker' : 'restore-picker');
      await device.tap({ text: name });
      await page.waitForFunction((n) => document.getElementById('importexport-import-file')?.files?.[0]?.name === n, name, { timeout: 20_000 });
    };
    await ctx.step('receiver sentinel → SAME saved file via native picker → typed REPLACE with no Merge', async () => {
      // Fixture setup only: makes replacement observable on a nonempty receiver.
      const sentinel = await page.evaluate(() => window.apiCall('/api/bp', 'POST', { systolic: 222, diastolic: 111, notes: 'B3 receiver-only sentinel' }));
      r.sentinelId = sentinel.id;
      await pick(saved.name);
      await page.click('#importexport-import-btn');
      await page.locator('.mt-confirm-modal__input').waitFor({ state: 'visible' });
      const dialog = page.locator('.mt-confirm-modal');
      if (/\bMerge\b/.test(await dialog.innerText())) throw new Error('file restore unexpectedly offers Merge');
      const confirm = page.locator('.mt-confirm-modal__confirm');
      if (!(await confirm.isDisabled())) throw new Error('Replace enabled before typed phrase');
      await page.locator('.mt-confirm-modal__input').fill('REPLACE');
      await ctx.shot('typed-replace-no-merge');
      const loaded = page.waitForEvent('load', { timeout: 120_000 });
      await confirm.click();
      await loaded;
      await ctx.waitLocalReady(page);
      equal(await snapshot(page), saved.vault, 'restored full content');
      await page.reload({ waitUntil: 'load' });
      await ctx.waitLocalReady(page);
      const restored = await snapshot(page);
      equal(restored, saved.vault, 'restored after reload');
      if (restored.data.bp.readings.some((b) => b.notes === 'B3 receiver-only sentinel')) throw new Error('Replace retained receiver sentinel');
      r.restored = counts(restored);
      r.semanticRestored = digest(JSON.stringify(content(restored)));
      r.fullContentAndSettings = true;
      await ctx.shot('restored-today');
    });
    await ctx.step('real picker corrupt file → refusal → receiver unchanged after reload', async () => {
      // Public synthetic truncated gzip header (1f 8b 08), REAL chooser input.
      await shell(`sh -c 'echo H4sI | base64 -d > /sdcard/Download/${corruptName}'`);
      const before = await snapshot(page);
      await pick(corruptName);
      await page.click('#importexport-import-btn');
      const refusal = page.locator('.wg-toast--danger[role="alert"]').filter({ hasText: 'Could not read backup' });
      await refusal.waitFor({ state: 'visible', timeout: 20_000 });
      const message = await refusal.innerText();
      if (await page.locator('.mt-confirm-modal__input').count()) throw new Error('corrupt gzip reached destructive confirmation');
      r.corruptRefusal = message;
      await ctx.shot('corrupt-refused');
      equal(await snapshot(page), before, 'corrupt refusal');
      await page.reload({ waitUntil: 'load' });
      await ctx.waitLocalReady(page);
      equal(await snapshot(page), before, 'corrupt refusal after reload');
      r.corruptPreserved = true;
    });
  } finally {
    await ctx.step('remove own saved/corrupt fixture documents', async () => {
      if (saved) await shell(`rm -f ${saved.path}`);
      await shell(`rm -f /sdcard/Download/${corruptName}`);
      r.documentsRemoved = true;
    });
  }
}
